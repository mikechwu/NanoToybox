/**
 * Tersoff potential engine for browser — optimized analytical force computation.
 *
 * Direct port of sim/potentials/tersoff.py to JavaScript, optimized for
 * real-time performance using flat TypedArrays instead of Maps.
 *
 * Key optimizations over the naive port:
 * 1. Flat Float64Array for distance/rhat cache (vs Map — 5-10x faster lookup)
 * 2. Pre-allocated buffers reused across frames (zero GC pressure)
 * 3. Inlined cutoff/force functions (avoids function call overhead)
 * 4. Neighbor list rebuilt every 10 steps (not every step)
 */
import { CONFIG } from './config.js';

// ─── Tersoff parameters for carbon (1988) ───
const LAMBDA1 = 3.4879;
const LAMBDA2 = 2.2119;
const T_A = 1393.6;
const T_B = 346.74;
const T_N = 0.72751;
const BETA = 1.5724e-7;
const T_C = 38049.0;
const T_D = 4.3484;
const T_H = -0.57058;
const R_CUT = 1.95;
const D_CUT = 0.15;
const R_MAX = R_CUT + D_CUT;

// Pre-computed constants
const C2 = T_C * T_C;
const D2 = T_D * T_D;
const C2_D2 = C2 / D2;
const HALF_PI_OVER_D = Math.PI / (2 * D_CUT);
const INV_2N = -1.0 / (2.0 * T_N);

// ─── Interaction parameters ───
const F_MAX = CONFIG.physics.fMax;
const V_HARD_MAX = CONFIG.physics.vHardMax;
const KE_CAP_MULT = CONFIG.physics.keCapMult;

// ─── Integration ───
const DT = CONFIG.physics.dt;
const STEPS_PER_FRAME = CONFIG.physics.stepsPerFrame;

// ─── Unit conversion ───
const ACC_FACTOR = 1.602176634e-29 / 1.9944235e-26;

/**
 * Standalone Tersoff force kernel — pure science, no UX dependencies.
 *
 * This function computes Tersoff (1988) interatomic forces for carbon.
 * It reads positions and writes forces. It does not know about drag,
 * rotation, clamping, or energy control.
 *
 * Extracted as a standalone function so it can be replaced with a
 * Wasm implementation without touching the interaction/runtime layer.
 *
 * @param {Float64Array} pos - atom positions [x0,y0,z0, x1,y1,z1, ...]
 * @param {Float64Array} force - output forces (accumulated, not zeroed here)
 * @param {Int32Array[]} nl - neighbor list arrays (nl[i][0..nlc[i]-1] = neighbors)
 * @param {Int32Array} nlc - neighbor counts (nlc[i] = number of neighbors of i)
 * @param {number} n - number of atoms
 * @param {Float64Array} distBuf - pre-allocated distance cache [n*n]
 * @param {Float64Array} rhatBuf - pre-allocated unit vector cache [n*n*3]
 */
function computeTersoffForces(pos, force, nl, nlc, n, distBuf, rhatBuf) {
  const p = pos;
  const f = force;
  const dist = distBuf;
  const rhat = rhatBuf;

  // ─── Precompute distances and unit vectors into flat arrays ───
  dist.fill(0);
  for (let i = 0; i < n; i++) {
    const ix = i * 3;
    const ni = nl[i];
    const niLen = nlc[i];
    for (let qi = 0; qi < niLen; qi++) {
      const j = ni[qi];
      if (j <= i) continue;
      const jx = j * 3;
      const dx = p[jx] - p[ix];
      const dy = p[jx + 1] - p[ix + 1];
      const dz = p[jx + 2] - p[ix + 2];
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz);

      const kij = i * n + j;
      const kji = j * n + i;
      dist[kij] = d;
      dist[kji] = d;

      if (d > 1e-10) {
        const inv = 1.0 / d;
        const r3ij = kij * 3;
        const r3ji = kji * 3;
        rhat[r3ij] = dx * inv;
        rhat[r3ij + 1] = dy * inv;
        rhat[r3ij + 2] = dz * inv;
        rhat[r3ji] = -dx * inv;
        rhat[r3ji + 1] = -dy * inv;
        rhat[r3ji + 2] = -dz * inv;
      }
    }
  }

  // ─── Main force loop ───
  for (let i = 0; i < n; i++) {
    const ni = nl[i];
    const niLen = nlc[i];
    for (let qi = 0; qi < niLen; qi++) {
      const j = ni[qi];
      if (j <= i) continue;

      const kij = i * n + j;
      const r_ij = dist[kij];
      if (r_ij >= R_MAX || r_ij < 1e-10) continue;

      const r3ij = kij * 3;
      const rh_ij0 = rhat[r3ij], rh_ij1 = rhat[r3ij + 1], rh_ij2 = rhat[r3ij + 2];

      // Inline cutoff
      let fc_ij, dfc_ij;
      if (r_ij < R_CUT - D_CUT) { fc_ij = 1.0; dfc_ij = 0.0; }
      else if (r_ij > R_MAX) { fc_ij = 0.0; dfc_ij = 0.0; }
      else {
        const arg = HALF_PI_OVER_D * (r_ij - R_CUT);
        fc_ij = 0.5 - 0.5 * Math.sin(arg);
        dfc_ij = -0.5 * Math.cos(arg) * HALF_PI_OVER_D;
      }

      const expL1 = Math.exp(-LAMBDA1 * r_ij);
      const expL2 = Math.exp(-LAMBDA2 * r_ij);
      const fR_ij = T_A * expL1;
      const dfR_ij = -LAMBDA1 * fR_ij;
      const fA_ij = -T_B * expL2;
      const dfA_ij = LAMBDA2 * T_B * expL2;

      // ─── Compute zeta_ij ───
      let zeta_ij = 0.0;
      for (let qk = 0; qk < niLen; qk++) {
        const k = ni[qk];
        if (k === j) continue;
        const kik = i * n + k;
        const r_ik = dist[kik];
        if (r_ik === 0 || r_ik >= R_MAX) continue;

        let fc_ik;
        if (r_ik < R_CUT - D_CUT) fc_ik = 1.0;
        else if (r_ik > R_MAX) fc_ik = 0.0;
        else fc_ik = 0.5 - 0.5 * Math.sin(HALF_PI_OVER_D * (r_ik - R_CUT));

        const r3ik = kik * 3;
        let cosT = rh_ij0 * rhat[r3ik] + rh_ij1 * rhat[r3ik + 1] + rh_ij2 * rhat[r3ik + 2];
        if (cosT > 1) cosT = 1; else if (cosT < -1) cosT = -1;

        const hmc = T_H - cosT;
        zeta_ij += fc_ik * (1.0 + C2_D2 - C2 / (D2 + hmc * hmc));
      }

      // ─── Compute zeta_ji ───
      let zeta_ji = 0.0;
      const kji = j * n + i;
      const r3ji = kji * 3;
      const rh_ji0 = rhat[r3ji], rh_ji1 = rhat[r3ji + 1], rh_ji2 = rhat[r3ji + 2];
      const nj = nl[j];
      const njLen = nlc[j];

      for (let qk = 0; qk < njLen; qk++) {
        const k = nj[qk];
        if (k === i) continue;
        const kjk = j * n + k;
        const r_jk = dist[kjk];
        if (r_jk === 0 || r_jk >= R_MAX) continue;

        let fc_jk;
        if (r_jk < R_CUT - D_CUT) fc_jk = 1.0;
        else if (r_jk > R_MAX) fc_jk = 0.0;
        else fc_jk = 0.5 - 0.5 * Math.sin(HALF_PI_OVER_D * (r_jk - R_CUT));

        const r3jk = kjk * 3;
        let cosT = rh_ji0 * rhat[r3jk] + rh_ji1 * rhat[r3jk + 1] + rh_ji2 * rhat[r3jk + 2];
        if (cosT > 1) cosT = 1; else if (cosT < -1) cosT = -1;

        const hmc = T_H - cosT;
        zeta_ji += fc_jk * (1.0 + C2_D2 - C2 / (D2 + hmc * hmc));
      }

      // ─── Bond orders ───
      const bz_ij = BETA * zeta_ij;
      const bij = bz_ij > 0 ? Math.pow(1.0 + Math.pow(bz_ij, T_N), INV_2N) : 1.0;
      const bz_ji = BETA * zeta_ji;
      const bji = bz_ji > 0 ? Math.pow(1.0 + Math.pow(bz_ji, T_N), INV_2N) : 1.0;

      // ─── Pair forces ───
      const pf_ij = 0.5 * (dfc_ij * (fR_ij + bij * fA_ij) + fc_ij * (dfR_ij + bij * dfA_ij));
      const pf_ji = 0.5 * (dfc_ij * (fR_ij + bji * fA_ij) + fc_ij * (dfR_ij + bji * dfA_ij));
      const pf = pf_ij + pf_ji;

      const ix = i * 3, jx = j * 3;
      f[ix]     += pf * rh_ij0;
      f[ix + 1] += pf * rh_ij1;
      f[ix + 2] += pf * rh_ij2;
      f[jx]     -= pf * rh_ij0;
      f[jx + 1] -= pf * rh_ij1;
      f[jx + 2] -= pf * rh_ij2;

      // ─── 3-body forces from zeta_ij ───
      if (bz_ij > 0 && zeta_ij > 0) {
        const dbij = -0.5 * BETA * Math.pow(bz_ij, T_N - 1) *
                     Math.pow(1.0 + Math.pow(bz_ij, T_N), INV_2N - 1.0);
        const dEdz = 0.5 * fc_ij * fA_ij * dbij;

        for (let qk = 0; qk < niLen; qk++) {
          const k = ni[qk];
          if (k === j) continue;
          const kik = i * n + k;
          const r_ik = dist[kik];
          if (r_ik === 0 || r_ik >= R_MAX) continue;

          const r3ik = kik * 3;
          const rk0 = rhat[r3ik], rk1 = rhat[r3ik + 1], rk2 = rhat[r3ik + 2];

          let fc_ik, dfc_ik;
          if (r_ik < R_CUT - D_CUT) { fc_ik = 1.0; dfc_ik = 0.0; }
          else {
            const arg = HALF_PI_OVER_D * (r_ik - R_CUT);
            fc_ik = 0.5 - 0.5 * Math.sin(arg);
            dfc_ik = -0.5 * Math.cos(arg) * HALF_PI_OVER_D;
          }

          let cosT = rh_ij0 * rk0 + rh_ij1 * rk1 + rh_ij2 * rk2;
          if (cosT > 1) cosT = 1; else if (cosT < -1) cosT = -1;

          const hmc = T_H - cosT;
          const denom = D2 + hmc * hmc;
          const g_val = 1.0 + C2_D2 - C2 / denom;
          const dg_val = -2.0 * C2 * hmc / (denom * denom);

          const kx = k * 3;
          const inv_rij = 1.0 / r_ij;
          const inv_rik = 1.0 / r_ik;

          for (let d = 0; d < 3; d++) {
            const rij_d = d === 0 ? rh_ij0 : d === 1 ? rh_ij1 : rh_ij2;
            const rik_d = d === 0 ? rk0 : d === 1 ? rk1 : rk2;

            const dcos_drj = (rik_d - cosT * rij_d) * inv_rij;
            const dcos_drk = (rij_d - cosT * rik_d) * inv_rik;
            const dcos_dri = -(dcos_drj + dcos_drk);

            const dz_dri = dfc_ik * (-rik_d) * g_val + fc_ik * dg_val * dcos_dri;
            f[ix + d] -= dEdz * dz_dri;
            f[jx + d] -= dEdz * fc_ik * dg_val * dcos_drj;
            f[kx + d] -= dEdz * (dfc_ik * rik_d * g_val + fc_ik * dg_val * dcos_drk);
          }
        }
      }

      // ─── 3-body forces from zeta_ji ───
      if (bz_ji > 0 && zeta_ji > 0) {
        const dbji = -0.5 * BETA * Math.pow(bz_ji, T_N - 1) *
                     Math.pow(1.0 + Math.pow(bz_ji, T_N), INV_2N - 1.0);
        const dEdz = 0.5 * fc_ij * fA_ij * dbji;

        for (let qk = 0; qk < njLen; qk++) {
          const k = nj[qk];
          if (k === i) continue;
          const kjk = j * n + k;
          const r_jk = dist[kjk];
          if (r_jk === 0 || r_jk >= R_MAX) continue;

          const r3jk = kjk * 3;
          const rk0 = rhat[r3jk], rk1 = rhat[r3jk + 1], rk2 = rhat[r3jk + 2];

          let fc_jk, dfc_jk;
          if (r_jk < R_CUT - D_CUT) { fc_jk = 1.0; dfc_jk = 0.0; }
          else {
            const arg = HALF_PI_OVER_D * (r_jk - R_CUT);
            fc_jk = 0.5 - 0.5 * Math.sin(arg);
            dfc_jk = -0.5 * Math.cos(arg) * HALF_PI_OVER_D;
          }

          let cosT = rh_ji0 * rk0 + rh_ji1 * rk1 + rh_ji2 * rk2;
          if (cosT > 1) cosT = 1; else if (cosT < -1) cosT = -1;

          const hmc = T_H - cosT;
          const denom = D2 + hmc * hmc;
          const g_val = 1.0 + C2_D2 - C2 / denom;
          const dg_val = -2.0 * C2 * hmc / (denom * denom);

          const kx = k * 3;
          const inv_rji = 1.0 / r_ij;
          const inv_rjk = 1.0 / r_jk;

          for (let d = 0; d < 3; d++) {
            const rji_d = d === 0 ? rh_ji0 : d === 1 ? rh_ji1 : rh_ji2;
            const rjk_d = d === 0 ? rk0 : d === 1 ? rk1 : rk2;

            const dcos_dri = (rjk_d - cosT * rji_d) * inv_rji;
            const dcos_drk = (rji_d - cosT * rjk_d) * inv_rjk;
            const dcos_drj = -(dcos_dri + dcos_drk);

            f[jx + d] -= dEdz * (dfc_jk * (-rjk_d) * g_val + fc_jk * dg_val * dcos_drj);
            f[ix + d] -= dEdz * fc_jk * dg_val * dcos_dri;
            f[kx + d] -= dEdz * (dfc_jk * rjk_d * g_val + fc_jk * dg_val * dcos_drk);
          }
        }
      }
    }
  }
}

export class PhysicsEngine {
  constructor() {
    this.n = 0;
    this.pos = null;
    this.vel = null;
    this.force = null;
    this.mass = 1.9944235e-26;
    this.dragAtom = -1;
    this.isRotateMode = false;
    this.isTranslateMode = false;
    this.dragTarget = [0, 0, 0];
    this.keInitial = 0;
    this.neighborList = null;
    this.bonds = [];
    this.stepCount = 0;
    this.kDrag = CONFIG.physics.kDragDefault;
    this.kRotate = CONFIG.physics.kRotateDefault;
    this.damping = CONFIG.physics.dampingDefault;

    // Pre-allocated cache buffers (resized in init)
    this._dist = null;   // Float64Array[n*n] — distance cache
    this._rhat = null;   // Float64Array[n*n*3] — unit vector cache
    this._maxN = 0;
    this._nlArrays = null;  // Reusable neighbor list sub-arrays
    this._nlCounts = null;  // Int32Array tracking used length of each sub-array
  }

  init(atoms, bonds) {
    this.n = atoms.length;
    this.pos = new Float64Array(this.n * 3);
    this.vel = new Float64Array(this.n * 3);
    this.force = new Float64Array(this.n * 3);

    for (let i = 0; i < this.n; i++) {
      const ix = i * 3;
      this.pos[ix] = atoms[i].x;
      this.pos[ix + 1] = atoms[i].y;
      this.pos[ix + 2] = atoms[i].z;
    }
    this.vel.fill(0);
    this.dragAtom = -1;
    this.isRotateMode = false;
    this.isTranslateMode = false;
    this.bonds = bonds.map(b => [...b]);
    this.keInitial = 0.1;
    this.stepCount = 0;
    this.neighborList = null;

    // Allocate cache buffers — right-size when switching to a smaller structure
    if (this.n !== this._maxN) {
      this._maxN = this.n;
      this._dist = new Float64Array(this.n * this.n);
      this._rhat = new Float64Array(this.n * this.n * 3);
      // Pre-allocate neighbor list arrays (one Int32Array per atom, initial capacity 8)
      this._nlArrays = new Array(this.n);
      this._nlCounts = new Int32Array(this.n);
      for (let i = 0; i < this.n; i++) this._nlArrays[i] = new Int32Array(8);
    }

    this.computeForces();
  }

  buildNeighborList() {
    const counts = this._nlCounts;
    const arrays = this._nlArrays;
    counts.fill(0);
    const p = this.pos;
    const cutoff2 = (R_MAX + 0.5) * (R_MAX + 0.5);

    for (let i = 0; i < this.n; i++) {
      const ix = i * 3;
      for (let j = i + 1; j < this.n; j++) {
        const jx = j * 3;
        const dx = p[jx] - p[ix];
        const dy = p[jx + 1] - p[ix + 1];
        const dz = p[jx + 2] - p[ix + 2];
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 < cutoff2) {
          // Grow array if needed (doubling strategy)
          if (counts[i] >= arrays[i].length) {
            const old = arrays[i];
            arrays[i] = new Int32Array(old.length * 2);
            arrays[i].set(old);
          }
          arrays[i][counts[i]++] = j;
          if (counts[j] >= arrays[j].length) {
            const old = arrays[j];
            arrays[j] = new Int32Array(old.length * 2);
            arrays[j].set(old);
          }
          arrays[j][counts[j]++] = i;
        }
      }
    }
    this.neighborList = arrays;
    this._nlCounts = counts;
  }

  computeForces() {
    this.force.fill(0);

    if (this.stepCount % 10 === 0 || !this.neighborList) {
      this.buildNeighborList();
    }
    if (!this.neighborList || this.n === 0) return;

    // ── Tersoff kernel: pure science, no UX dependencies ──
    // This call can be replaced with a Wasm implementation.
    computeTersoffForces(
      this.pos, this.force, this.neighborList, this._nlCounts, this.n, this._dist, this._rhat
    );

    // ── Interaction forces: UX layer ──
    // Drag spring, rotation torque — user-driven forces.

    // ─── User drag force (single atom) — full 3D in camera plane ───
    if (this.dragAtom >= 0 && !this.isRotateMode && !this.isTranslateMode) {
      const ix = this.dragAtom * 3;
      this.force[ix]     += this.kDrag * (this.dragTarget[0] - this.pos[ix]);
      this.force[ix + 1] += this.kDrag * (this.dragTarget[1] - this.pos[ix + 1]);
      this.force[ix + 2] += this.kDrag * (this.dragTarget[2] - this.pos[ix + 2]);
    }

    // ─── User translate force (whole molecule) ───
    // Uniform force on all atoms, normalized by n so total force is size-independent.
    // Produces approximately rigid translation; internal vibrations are unaffected.
    if (this.dragAtom >= 0 && this.isTranslateMode) {
      const ix = this.dragAtom * 3;
      const dx = this.dragTarget[0] - this.pos[ix];
      const dy = this.dragTarget[1] - this.pos[ix + 1];
      const dz = this.dragTarget[2] - this.pos[ix + 2];
      const s = this.kDrag / this.n;
      const fx = s * dx;
      const fy = s * dy;
      const fz = s * dz;
      for (let i = 0; i < this.n; i++) {
        const jx = i * 3;
        this.force[jx]     += fx;
        this.force[jx + 1] += fy;
        this.force[jx + 2] += fz;
      }
    }

    // ─── User rotation (spring force → torque → distributed tangential force) ───
    //
    // Same visual as drag: spring line from atom to cursor.
    // The spring force F at the selected atom produces torque τ = r_a × F.
    // Angular acceleration α = I⁻¹·τ is distributed as tangential f_i = α × r_i.
    //
    // INERTIA NORMALIZATION: The spring force is scaled by (I_actual / I_ref)
    // so that K_ROTATE produces the same angular response regardless of molecule
    // size. Without this, C720 (100× the inertia of C60) would need 100× the
    // cursor displacement to achieve the same rotation speed.
    //
    // I_ref = 750 Å² ≈ C60 inertia (60 atoms × 3.55² × 2/3)
    //
    if (this.dragAtom >= 0 && this.isRotateMode) {
      const pos = this.pos;
      const force = this.force;
      const aix = this.dragAtom * 3;

      // COM
      let cx = 0, cy = 0, cz = 0;
      for (let i = 0; i < this.n; i++) {
        cx += pos[i * 3]; cy += pos[i * 3 + 1]; cz += pos[i * 3 + 2];
      }
      cx /= this.n; cy /= this.n; cz /= this.n;

      // Diagonal moments of inertia (in units of mass × Å²; mass = 1 for uniform)
      let Ixx = 0, Iyy = 0, Izz = 0;
      for (let i = 0; i < this.n; i++) {
        const ix = i * 3;
        const rx = pos[ix] - cx, ry = pos[ix + 1] - cy, rz = pos[ix + 2] - cz;
        Ixx += ry * ry + rz * rz;
        Iyy += rx * rx + rz * rz;
        Izz += rx * rx + ry * ry;
      }

      // Average scalar inertia for normalization
      const I_avg = (Ixx + Iyy + Izz) / 3;
      const I_REF = CONFIG.physics.iRef;
      const inertiaScale = I_avg > 0.1 ? I_avg / I_REF : 1.0;

      // Spring force scaled by inertia ratio
      const dx = this.dragTarget[0] - pos[aix];
      const dy = this.dragTarget[1] - pos[aix + 1];
      const dz = this.dragTarget[2] - pos[aix + 2];
      const Fx = this.kRotate * inertiaScale * dx;
      const Fy = this.kRotate * inertiaScale * dy;
      const Fz = this.kRotate * inertiaScale * dz;

      // r_a = selected atom position relative to COM
      const rax = pos[aix] - cx;
      const ray = pos[aix + 1] - cy;
      const raz = pos[aix + 2] - cz;

      // Torque: τ = r_a × F
      const tx = ray * Fz - raz * Fy;
      const ty = raz * Fx - rax * Fz;
      const tz = rax * Fy - ray * Fx;

      // Angular acceleration: α = I⁻¹ · τ  (diagonal approximation)
      const ax = Ixx > 0.01 ? tx / Ixx : 0;
      const ay = Iyy > 0.01 ? ty / Iyy : 0;
      const az = Izz > 0.01 ? tz / Izz : 0;

      // Tangential force on each atom: f_i = α × r_i
      // Σ f_i = α × Σ r_i = 0 (r_i relative to COM) → no net translation ✓
      for (let i = 0; i < this.n; i++) {
        const ix = i * 3;
        const rx = pos[ix] - cx, ry = pos[ix + 1] - cy, rz = pos[ix + 2] - cz;
        force[ix]     += ay * rz - az * ry;
        force[ix + 1] += az * rx - ax * rz;
        force[ix + 2] += ax * ry - ay * rx;
      }
    }
  }

  clampForces() {
    for (let i = 0; i < this.n; i++) {
      const ix = i * 3;
      const fx = this.force[ix], fy = this.force[ix + 1], fz = this.force[ix + 2];
      const fMag = Math.sqrt(fx * fx + fy * fy + fz * fz);
      if (fMag > F_MAX) {
        const s = F_MAX / fMag;
        this.force[ix] *= s;
        this.force[ix + 1] *= s;
        this.force[ix + 2] *= s;
      }
    }
  }

  integrate(dt) {
    const a = ACC_FACTOR;
    for (let i = 0; i < this.n; i++) {
      const ix = i * 3;
      this.vel[ix] += 0.5 * this.force[ix] * a * dt;
      this.vel[ix + 1] += 0.5 * this.force[ix + 1] * a * dt;
      this.vel[ix + 2] += 0.5 * this.force[ix + 2] * a * dt;
      this.pos[ix] += this.vel[ix] * dt;
      this.pos[ix + 1] += this.vel[ix + 1] * dt;
      this.pos[ix + 2] += this.vel[ix + 2] * dt;
    }
    this.computeForces();
    this.clampForces();
    for (let i = 0; i < this.n; i++) {
      const ix = i * 3;
      this.vel[ix] += 0.5 * this.force[ix] * a * dt;
      this.vel[ix + 1] += 0.5 * this.force[ix + 1] * a * dt;
      this.vel[ix + 2] += 0.5 * this.force[ix + 2] * a * dt;
    }
  }

  applyEnergyControl() {
    if (this.damping > 0) {
      const factor = 1.0 - this.damping;
      for (let i = 0; i < this.n * 3; i++) this.vel[i] *= factor;
    }

    for (let i = 0; i < this.n; i++) {
      const ix = i * 3;
      const vMag = Math.sqrt(this.vel[ix]**2 + this.vel[ix+1]**2 + this.vel[ix+2]**2);
      if (vMag > V_HARD_MAX) {
        const s = V_HARD_MAX / vMag;
        this.vel[ix] *= s; this.vel[ix+1] *= s; this.vel[ix+2] *= s;
      }
    }

    const ke = this.getKineticEnergy();
    // KE cap scales with atom count: ~5 eV per atom allows energetic rotation
    const keCap = Math.max(KE_CAP_MULT * this.keInitial, this.n * 5.0);
    if (ke > keCap) {
      const s = Math.sqrt(keCap / ke);
      for (let i = 0; i < this.n * 3; i++) this.vel[i] *= s;
    }
  }

  updateBondList() {
    let count = 0;
    for (let i = 0; i < this.n; i++) {
      const ix = i * 3;
      for (let j = i + 1; j < this.n; j++) {
        const jx = j * 3;
        const dx = this.pos[jx] - this.pos[ix];
        const dy = this.pos[jx+1] - this.pos[ix+1];
        const dz = this.pos[jx+2] - this.pos[ix+2];
        const d = Math.sqrt(dx*dx + dy*dy + dz*dz);
        if (d < CONFIG.bonds.cutoff && d > CONFIG.bonds.minDist) {
          // Reuse existing bond entry or push a new one
          if (count < this.bonds.length) {
            this.bonds[count][0] = i;
            this.bonds[count][1] = j;
            this.bonds[count][2] = d;
          } else {
            this.bonds.push([i, j, d]);
          }
          count++;
        }
      }
    }
    this.bonds.length = count;
  }

  step() {
    for (let s = 0; s < STEPS_PER_FRAME; s++) {
      this.integrate(DT);
      this.stepCount++;
    }
    this.applyEnergyControl();
    if (this.stepCount % 20 === 0) this.updateBondList();
  }

  // ─── External interaction API ───

  startTranslate(atomIndex) {
    this.dragAtom = atomIndex;
    this.isRotateMode = false;
    this.isTranslateMode = true;
    this.dragTarget[0] = this.pos[atomIndex * 3];
    this.dragTarget[1] = this.pos[atomIndex * 3 + 1];
    this.dragTarget[2] = this.pos[atomIndex * 3 + 2];
  }

  startDrag(atomIndex) {
    this.dragAtom = atomIndex;
    this.isRotateMode = false;
    this.isTranslateMode = false;
    this.dragTarget[0] = this.pos[atomIndex * 3];
    this.dragTarget[1] = this.pos[atomIndex * 3 + 1];
    this.dragTarget[2] = this.pos[atomIndex * 3 + 2];
  }

  /**
   * Start rotation drag — same as startDrag but force is converted to torque.
   * The spring line from atom to cursor looks identical to regular drag.
   */
  startRotateDrag(atomIndex) {
    this.dragAtom = atomIndex;
    this.isRotateMode = true;
    this.isTranslateMode = false;
    this.dragTarget[0] = this.pos[atomIndex * 3];
    this.dragTarget[1] = this.pos[atomIndex * 3 + 1];
    this.dragTarget[2] = this.pos[atomIndex * 3 + 2];
  }

  updateDrag(worldX, worldY, worldZ) {
    this.dragTarget[0] = worldX;
    this.dragTarget[1] = worldY;
    if (worldZ !== undefined) this.dragTarget[2] = worldZ;
  }

  endDrag() {
    this.dragAtom = -1;
    this.isRotateMode = false;
    this.isTranslateMode = false;
  }

  applyImpulse(atomIndex, vx, vy) {
    const vMag = Math.sqrt(vx * vx + vy * vy);
    if (vMag > V_HARD_MAX) { const s = V_HARD_MAX / vMag; vx *= s; vy *= s; }
    this.vel[atomIndex * 3] += vx;
    this.vel[atomIndex * 3 + 1] += vy;
  }



  getCOM() {
    let cx = 0, cy = 0, cz = 0;
    for (let i = 0; i < this.n; i++) {
      cx += this.pos[i*3]; cy += this.pos[i*3+1]; cz += this.pos[i*3+2];
    }
    return [cx / this.n, cy / this.n, cz / this.n];
  }

  getKineticEnergy() {
    let ke = 0;
    for (let i = 0; i < this.n * 3; i++) ke += this.vel[i] * this.vel[i];
    return 0.5 * this.mass * ke * 1e10 / 1.602176634e-19;
  }

  getPosition(i) {
    return [this.pos[i*3], this.pos[i*3+1], this.pos[i*3+2]];
  }

  getBonds() { return this.bonds; }

  reset(atoms) {
    for (let i = 0; i < this.n; i++) {
      this.pos[i*3] = atoms[i].x;
      this.pos[i*3+1] = atoms[i].y;
      this.pos[i*3+2] = atoms[i].z;
    }
    this.vel.fill(0);
    this.dragAtom = -1;
    this.isRotateMode = false;
    this.isTranslateMode = false;
    this.stepCount = 0;
    this.keInitial = 0.1;
    this.computeForces();
  }

  // ─── User-adjustable parameters ───

  setDragStrength(val) { this.kDrag = val; }
  getDragStrength() { return this.kDrag; }
  setRotateStrength(val) { this.kRotate = val; }
  getRotateStrength() { return this.kRotate; }
  setDamping(val) { this.damping = val; }
  getDamping() { return this.damping; }
}
