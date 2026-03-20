/**
 * Tersoff potential engine for browser — optimized analytical force computation.
 *
 * Direct port of sim/potentials/tersoff.py to JavaScript, optimized for
 * real-time performance.
 *
 * Key optimizations:
 * 1. On-the-fly distance computation — no N×N distance/unit-vector cache.
 *    Distances are computed inline from pos (L1-cacheable) instead of
 *    random access into N×N arrays that exceed CPU cache at ~500 atoms.
 *    Benchmarked 45% faster than cached approach at 2040 atoms (see C.proof).
 * 2. Pre-allocated neighbor list buffers reused across frames (zero GC pressure)
 * 3. Inlined cutoff/force functions (avoids function call overhead)
 * 4. Neighbor list rebuilt every 10 steps (not every step)
 */
import { CONFIG } from './config.js';
import { initWasm, isReady, callTersoff, marshalCSR, csrIsCurrent } from './tersoff-wasm.js';

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
 * Computes Tersoff (1988) interatomic forces for carbon using on-the-fly
 * distance computation. No pre-allocated N×N distance/unit-vector cache —
 * distances are computed inline from pos, keeping memory access within
 * the L1-cacheable pos array (~N×24 bytes vs N²×32 bytes for the cache).
 *
 * Extracted as a standalone function so it can be replaced with a
 * Wasm implementation without touching the interaction/runtime layer.
 *
 * @param {Float64Array} pos - atom positions [x0,y0,z0, x1,y1,z1, ...]
 * @param {Float64Array} force - output forces (accumulated, not zeroed here)
 * @param {Int32Array[]} nl - neighbor list arrays (nl[i][0..nlc[i]-1] = neighbors)
 * @param {Int32Array} nlc - neighbor counts (nlc[i] = number of neighbors of i)
 * @param {number} n - number of atoms
 */
function computeTersoffForces(pos, force, nl, nlc, n) {
  const p = pos;
  const f = force;
  const R_MAX_SQ = R_MAX * R_MAX;

  for (let i = 0; i < n; i++) {
    const ni = nl[i], niLen = nlc[i];
    const ix = i * 3, pix = p[ix], piy = p[ix + 1], piz = p[ix + 2];

    for (let qi = 0; qi < niLen; qi++) {
      const j = ni[qi];
      if (j <= i) continue;
      const jx = j * 3;
      const dij_x = p[jx] - pix, dij_y = p[jx + 1] - piy, dij_z = p[jx + 2] - piz;
      const r_ij_sq = dij_x * dij_x + dij_y * dij_y + dij_z * dij_z;
      if (r_ij_sq >= R_MAX_SQ || r_ij_sq < 1e-20) continue;
      const r_ij = Math.sqrt(r_ij_sq);
      const inv_rij = 1.0 / r_ij;
      const rh_ij0 = dij_x * inv_rij, rh_ij1 = dij_y * inv_rij, rh_ij2 = dij_z * inv_rij;

      // Inline cutoff
      let fc_ij, dfc_ij;
      if (r_ij < R_CUT - D_CUT) { fc_ij = 1.0; dfc_ij = 0.0; }
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
        const kx3 = k * 3;
        const dik_x = p[kx3] - pix, dik_y = p[kx3 + 1] - piy, dik_z = p[kx3 + 2] - piz;
        const r_ik_sq = dik_x * dik_x + dik_y * dik_y + dik_z * dik_z;
        if (r_ik_sq < 1e-20 || r_ik_sq >= R_MAX_SQ) continue;
        const r_ik = Math.sqrt(r_ik_sq);
        const inv_rik = 1.0 / r_ik;
        const rk0 = dik_x * inv_rik, rk1 = dik_y * inv_rik, rk2 = dik_z * inv_rik;

        let fc_ik;
        if (r_ik < R_CUT - D_CUT) fc_ik = 1.0;
        else fc_ik = 0.5 - 0.5 * Math.sin(HALF_PI_OVER_D * (r_ik - R_CUT));

        let cosT = rh_ij0 * rk0 + rh_ij1 * rk1 + rh_ij2 * rk2;
        if (cosT > 1) cosT = 1; else if (cosT < -1) cosT = -1;

        const hmc = T_H - cosT;
        zeta_ij += fc_ik * (1.0 + C2_D2 - C2 / (D2 + hmc * hmc));
      }

      // ─── Compute zeta_ji ───
      let zeta_ji = 0.0;
      const rh_ji0 = -rh_ij0, rh_ji1 = -rh_ij1, rh_ji2 = -rh_ij2;
      const pjx = p[jx], pjy = p[jx + 1], pjz = p[jx + 2];
      const nj = nl[j];
      const njLen = nlc[j];

      for (let qk = 0; qk < njLen; qk++) {
        const k = nj[qk];
        if (k === i) continue;
        const kx3 = k * 3;
        const djk_x = p[kx3] - pjx, djk_y = p[kx3 + 1] - pjy, djk_z = p[kx3 + 2] - pjz;
        const r_jk_sq = djk_x * djk_x + djk_y * djk_y + djk_z * djk_z;
        if (r_jk_sq < 1e-20 || r_jk_sq >= R_MAX_SQ) continue;
        const r_jk = Math.sqrt(r_jk_sq);
        const inv_rjk = 1.0 / r_jk;
        const rk0 = djk_x * inv_rjk, rk1 = djk_y * inv_rjk, rk2 = djk_z * inv_rjk;

        let fc_jk;
        if (r_jk < R_CUT - D_CUT) fc_jk = 1.0;
        else fc_jk = 0.5 - 0.5 * Math.sin(HALF_PI_OVER_D * (r_jk - R_CUT));

        let cosT = rh_ji0 * rk0 + rh_ji1 * rk1 + rh_ji2 * rk2;
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
          const kx3 = k * 3;
          const dik_x = p[kx3] - pix, dik_y = p[kx3 + 1] - piy, dik_z = p[kx3 + 2] - piz;
          const r_ik_sq = dik_x * dik_x + dik_y * dik_y + dik_z * dik_z;
          if (r_ik_sq < 1e-20 || r_ik_sq >= R_MAX_SQ) continue;
          const r_ik = Math.sqrt(r_ik_sq);
          const inv_rik = 1.0 / r_ik;
          const rk0 = dik_x * inv_rik, rk1 = dik_y * inv_rik, rk2 = dik_z * inv_rik;

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

          for (let d = 0; d < 3; d++) {
            const rij_d = d === 0 ? rh_ij0 : d === 1 ? rh_ij1 : rh_ij2;
            const rik_d = d === 0 ? rk0 : d === 1 ? rk1 : rk2;

            const dcos_drj = (rik_d - cosT * rij_d) * inv_rij;
            const dcos_drk = (rij_d - cosT * rik_d) * inv_rik;
            const dcos_dri = -(dcos_drj + dcos_drk);

            f[ix + d] -= dEdz * (dfc_ik * (-rik_d) * g_val + fc_ik * dg_val * dcos_dri);
            f[jx + d] -= dEdz * fc_ik * dg_val * dcos_drj;
            f[kx3 + d] -= dEdz * (dfc_ik * rik_d * g_val + fc_ik * dg_val * dcos_drk);
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
          const kx3 = k * 3;
          const djk_x = p[kx3] - pjx, djk_y = p[kx3 + 1] - pjy, djk_z = p[kx3 + 2] - pjz;
          const r_jk_sq = djk_x * djk_x + djk_y * djk_y + djk_z * djk_z;
          if (r_jk_sq < 1e-20 || r_jk_sq >= R_MAX_SQ) continue;
          const r_jk = Math.sqrt(r_jk_sq);
          const inv_rjk = 1.0 / r_jk;
          const rk0 = djk_x * inv_rjk, rk1 = djk_y * inv_rjk, rk2 = djk_z * inv_rjk;

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

          for (let d = 0; d < 3; d++) {
            const rji_d = d === 0 ? rh_ji0 : d === 1 ? rh_ji1 : rh_ji2;
            const rjk_d = d === 0 ? rk0 : d === 1 ? rk1 : rk2;

            const dcos_dri = (rjk_d - cosT * rji_d) * inv_rij;
            const dcos_drk = (rji_d - cosT * rjk_d) * inv_rjk;
            const dcos_drj = -(dcos_dri + dcos_drk);

            f[jx + d] -= dEdz * (dfc_jk * (-rjk_d) * g_val + fc_jk * dg_val * dcos_drj);
            f[ix + d] -= dEdz * fc_jk * dg_val * dcos_dri;
            f[kx3 + d] -= dEdz * (dfc_jk * rjk_d * g_val + fc_jk * dg_val * dcos_drk);
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
    this.activeComponent = -1;
    this.dragTarget = [0, 0, 0];
    this.keInitial = 0;
    this.neighborList = null;
    this.bonds = [];
    this.componentId = null;   // Int32Array[n] — component index per atom
    this.components = [];      // [{ atoms: number[], size: number }]
    this.stepCount = 0;
    this.kDrag = CONFIG.physics.kDragDefault;
    this.kRotate = CONFIG.physics.kRotateDefault;
    this.damping = CONFIG.physics.dampingDefault;
    this._dampingFactor = this.damping > 0 ? Math.pow(1 - this.damping, 1 / STEPS_PER_FRAME) : 1.0;

    // Benchmark timing hooks (null when not benchmarking, zero overhead)
    this._bench = null; // set to {} to enable per-stage timing

    // Pre-allocated cache buffers (resized in init)
    this._maxN = 0;
    this._nlArrays = null;  // Reusable neighbor list sub-arrays
    this._nlCounts = null;  // Int32Array tracking used length of each sub-array

    // Cell-list spatial acceleration buffers (allocated on demand)
    this._cellHead = null;
    this._cellNext = null;
    this._bondCellHead = null;
    this._bondCellNext = null;

    // CSR neighbor list (cached derivative for Wasm bridge)
    this._csrOffsets = null;  // Int32Array[n+1]
    this._csrData = null;     // Int32Array[total_neighbors]
    this._csrGeneration = 0;  // incremented on each buildNeighborList()

    // Wasm initialization (non-blocking, opportunistic)
    // URL param ?kernel=js|wasm|auto overrides config for benchmarking
    const urlKernel = typeof URLSearchParams !== 'undefined'
      ? new URLSearchParams(globalThis.location?.search).get('kernel') : null;
    this._forceKernel = urlKernel; // 'js' | 'wasm' | null (auto)
    this._wasmReady = false;
    // Load Wasm if config enables it OR URL param explicitly requests it
    if (urlKernel === 'wasm' || (urlKernel !== 'js' && CONFIG.physics.useWasm)) {
      initWasm().then(ok => { this._wasmReady = ok; });
    }
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
    this.activeComponent = -1;
    this.bonds = bonds.map(b => [...b]);
    this.keInitial = 0.1;
    this.stepCount = 0;
    this.neighborList = null;

    // Allocate cache buffers — right-size when switching to a smaller structure
    if (this.n !== this._maxN) {
      this._maxN = this.n;
      // Pre-allocate neighbor list arrays (one Int32Array per atom, initial capacity 8)
      this._nlArrays = new Array(this.n);
      this._nlCounts = new Int32Array(this.n);
      for (let i = 0; i < this.n; i++) this._nlArrays[i] = new Int32Array(8);
    }

    this.computeForces();
    this.rebuildComponents();
  }

  /**
   * Shared cell-grid construction. Computes bounding box, grid dimensions,
   * assigns atoms to cells via linked-list insertion.
   * @returns {{ cellHead, cellNext, nx, ny, nz, minX, minY, minZ, cellSide }} or null if n===0
   */
  _buildCellGrid(cellSide, headKey, nextKey) {
    const p = this.pos;
    const n = this.n;
    if (n === 0) return null;

    // Bounding box
    let minX = p[0], minY = p[1], minZ = p[2];
    let maxX = minX, maxY = minY, maxZ = minZ;
    for (let i = 1; i < n; i++) {
      const i3 = i * 3;
      const x = p[i3], y = p[i3 + 1], z = p[i3 + 2];
      if (x < minX) minX = x; else if (x > maxX) maxX = x;
      if (y < minY) minY = y; else if (y > maxY) maxY = y;
      if (z < minZ) minZ = z; else if (z > maxZ) maxZ = z;
    }

    const nx = Math.max(1, Math.ceil((maxX - minX) / cellSide) + 1);
    const ny = Math.max(1, Math.ceil((maxY - minY) / cellSide) + 1);
    const nz = Math.max(1, Math.ceil((maxZ - minZ) / cellSide) + 1);
    const nCells = nx * ny * nz;

    // Allocate or reuse
    if (!this[headKey] || this[headKey].length < nCells) {
      this[headKey] = new Int32Array(nCells);
      this[nextKey] = new Int32Array(Math.max(n, 64));
    } else if (this[nextKey].length < n) {
      this[nextKey] = new Int32Array(n);
    }
    const cellHead = this[headKey];
    const cellNext = this[nextKey];
    cellHead.fill(-1, 0, nCells);

    // Assign atoms to cells
    for (let i = 0; i < n; i++) {
      const i3 = i * 3;
      const cx = Math.floor((p[i3] - minX) / cellSide);
      const cy = Math.floor((p[i3 + 1] - minY) / cellSide);
      const cz = Math.floor((p[i3 + 2] - minZ) / cellSide);
      const cellIdx = cx + cy * nx + cz * nx * ny;
      cellNext[i] = cellHead[cellIdx];
      cellHead[cellIdx] = i;
    }

    return { cellHead, cellNext, nx, ny, nz, minX, minY, minZ, cellSide };
  }

  /**
   * Build neighbor list using cell-list spatial acceleration.
   * O(N) construction + O(N × 27K) search instead of O(N²) all-pairs.
   */
  buildNeighborList() {
    const counts = this._nlCounts;
    const arrays = this._nlArrays;
    counts.fill(0);
    const p = this.pos;
    const n = this.n;
    const cutoff = R_MAX + 0.5; // 2.60 Å
    const cutoff2 = cutoff * cutoff;

    const grid = this._buildCellGrid(cutoff, '_cellHead', '_cellNext');
    if (!grid) { this.neighborList = arrays; return; }
    const { cellHead, cellNext, nx, ny, nz, minX, minY, minZ, cellSide } = grid;

    // ─── Search 27 neighboring cells for each atom ───
    for (let i = 0; i < n; i++) {
      const i3 = i * 3;
      const px = p[i3], py = p[i3 + 1], pz = p[i3 + 2];
      const cx = Math.floor((px - minX) / cellSide);
      const cy = Math.floor((py - minY) / cellSide);
      const cz = Math.floor((pz - minZ) / cellSide);

      for (let dz = -1; dz <= 1; dz++) {
        const gz = cz + dz;
        if (gz < 0 || gz >= nz) continue;
        for (let dy = -1; dy <= 1; dy++) {
          const gy = cy + dy;
          if (gy < 0 || gy >= ny) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const gx = cx + dx;
            if (gx < 0 || gx >= nx) continue;
            const cellIdx = gx + gy * nx + gz * nx * ny;
            let j = cellHead[cellIdx];
            while (j !== -1) {
              if (j > i) {
                const j3 = j * 3;
                const ddx = p[j3] - px, ddy = p[j3 + 1] - py, ddz = p[j3 + 2] - pz;
                const d2 = ddx * ddx + ddy * ddy + ddz * ddz;
                if (d2 < cutoff2) {
                  // Add to both i's and j's neighbor lists (symmetric)
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
              j = cellNext[j];
            }
          }
        }
      }
    }
    this.neighborList = arrays;
    this._nlCounts = counts;

    // Build CSR as cached derivative for Wasm bridge
    this._csrGeneration++;
    let totalNl = 0;
    for (let i = 0; i < n; i++) totalNl += counts[i];
    this._csrOffsets = new Int32Array(n + 1);
    this._csrData = new Int32Array(totalNl);
    this._csrOffsets[0] = 0;
    let idx = 0;
    for (let i = 0; i < n; i++) {
      this._csrOffsets[i + 1] = this._csrOffsets[i] + counts[i];
      const arr = arrays[i];
      for (let q = 0; q < counts[i]; q++) this._csrData[idx++] = arr[q];
    }
  }

  computeForces() {
    this.force.fill(0);

    if (this.stepCount % 10 === 0 || !this.neighborList) {
      const t0 = this._bench ? performance.now() : 0;
      this.buildNeighborList();
      if (this._bench) this._bench.neighborMs = (this._bench.neighborMs || 0) + (performance.now() - t0);
    }
    if (!this.neighborList || this.n === 0) return;

    // ── Tersoff kernel dispatch: Wasm if ready, JS fallback ──
    // ?kernel=js forces JS, ?kernel=wasm forces Wasm (fails if not ready)
    const useWasm = this._forceKernel !== 'js' && this._wasmReady && isReady();

    if (useWasm) {
      // Ensure CSR is marshaled into Wasm memory
      if (!csrIsCurrent(this._csrGeneration)) {
        const csrResult = marshalCSR(this._csrOffsets, this._csrData, this.n, this._csrGeneration);
        if (this._bench) this._bench.csrMarshalMs = (this._bench.csrMarshalMs || 0) + csrResult.csrMarshalMs;
        if (!csrResult.ok) {
          // Marshal failed — fall back to JS for this step
          const t1 = this._bench ? performance.now() : 0;
          computeTersoffForces(this.pos, this.force, this.neighborList, this._nlCounts, this.n);
          if (this._bench) this._bench.tersoffMs = (this._bench.tersoffMs || 0) + (performance.now() - t1);
          return;
        }
      }
      const timing = callTersoff(this.pos, this.force, this.n);
      if (!timing.ok) {
        // Kernel call failed — fall back to JS for this step
        this.force.fill(0);
        const t1 = this._bench ? performance.now() : 0;
        computeTersoffForces(this.pos, this.force, this.neighborList, this._nlCounts, this.n);
        if (this._bench) this._bench.tersoffMs = (this._bench.tersoffMs || 0) + (performance.now() - t1);
        return;
      }
      if (this._bench) {
        this._bench.tersoffMs = (this._bench.tersoffMs || 0) + timing.pathMs;
        this._bench.marshalMs = (this._bench.marshalMs || 0) + timing.marshalMs;
        this._bench.wasmKernelMs = (this._bench.wasmKernelMs || 0) + timing.kernelMs;
      }
    } else {
      const t1 = this._bench ? performance.now() : 0;
      computeTersoffForces(this.pos, this.force, this.neighborList, this._nlCounts, this.n);
      if (this._bench) this._bench.tersoffMs = (this._bench.tersoffMs || 0) + (performance.now() - t1);
    }

    // ── Interaction forces: UX layer ──
    // Drag spring, rotation torque — user-driven forces.

    // ─── User drag force (single atom) — full 3D in camera plane ───
    if (this.dragAtom >= 0 && !this.isRotateMode && !this.isTranslateMode) {
      const ix = this.dragAtom * 3;
      this.force[ix]     += this.kDrag * (this.dragTarget[0] - this.pos[ix]);
      this.force[ix + 1] += this.kDrag * (this.dragTarget[1] - this.pos[ix + 1]);
      this.force[ix + 2] += this.kDrag * (this.dragTarget[2] - this.pos[ix + 2]);
    }

    // ─── User translate force (connected component) ───
    // Uniform force on all atoms in the picked atom's connected patch,
    // normalized by component size so total force is size-independent.
    if (this.dragAtom >= 0 && this.isTranslateMode) {
      const ix = this.dragAtom * 3;
      const dx = this.dragTarget[0] - this.pos[ix];
      const dy = this.dragTarget[1] - this.pos[ix + 1];
      const dz = this.dragTarget[2] - this.pos[ix + 2];
      const comp = this.activeComponent >= 0 ? this.components[this.activeComponent] : null;
      const atoms = comp ? comp.atoms : [this.dragAtom];
      const s = this.kDrag / atoms.length;
      const fx = s * dx, fy = s * dy, fz = s * dz;
      for (let k = 0; k < atoms.length; k++) {
        const jx = atoms[k] * 3;
        this.force[jx] += fx; this.force[jx + 1] += fy; this.force[jx + 2] += fz;
      }
    }

    // ─── User rotation (spring force → torque → distributed tangential force) ───
    //
    // Forces are scoped to the connected component containing the picked atom.
    // COM, inertia, and tangential forces are computed over that component only.
    //
    // INERTIA NORMALIZATION: The spring force is scaled by (I_actual / I_ref)
    // so that K_ROTATE produces the same angular response regardless of patch
    // size. I_ref = 750 Å² ≈ C60 inertia (60 atoms × 3.55² × 2/3)
    //
    if (this.dragAtom >= 0 && this.isRotateMode) {
      const pos = this.pos;
      const force = this.force;
      const aix = this.dragAtom * 3;
      const comp = this.activeComponent >= 0 ? this.components[this.activeComponent] : null;
      const atoms = comp ? comp.atoms : [this.dragAtom];
      const count = atoms.length;

      // COM over component
      let cx = 0, cy = 0, cz = 0;
      for (let k = 0; k < count; k++) {
        const i3 = atoms[k] * 3;
        cx += pos[i3]; cy += pos[i3 + 1]; cz += pos[i3 + 2];
      }
      cx /= count; cy /= count; cz /= count;

      // Diagonal moments of inertia over component
      let Ixx = 0, Iyy = 0, Izz = 0;
      for (let k = 0; k < count; k++) {
        const i3 = atoms[k] * 3;
        const rx = pos[i3] - cx, ry = pos[i3 + 1] - cy, rz = pos[i3 + 2] - cz;
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

      // Tangential force on component atoms: f_i = α × r_i
      for (let k = 0; k < count; k++) {
        const i3 = atoms[k] * 3;
        const rx = pos[i3] - cx, ry = pos[i3 + 1] - cy, rz = pos[i3 + 2] - cz;
        force[i3]     += ay * rz - az * ry;
        force[i3 + 1] += az * rx - ax * rz;
        force[i3 + 2] += ax * ry - ay * rx;
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

  /**
   * Update bond list using cell-list spatial acceleration.
   * Uses bond-specific cell side (1.8 Å) for tighter candidate density.
   */
  updateBondList() {
    const p = this.pos;
    const n = this.n;
    const bondCutoff = CONFIG.bonds.cutoff;
    const bondCutoff2 = bondCutoff * bondCutoff;
    const minDist = CONFIG.bonds.minDist;
    const minDist2 = minDist * minDist;
    let count = 0;

    if (n === 0) { this.bonds.length = 0; return; }

    const grid = this._buildCellGrid(bondCutoff, '_bondCellHead', '_bondCellNext');
    if (!grid) { this.bonds.length = 0; return; }
    const { cellHead, cellNext, nx, ny, nz, minX, minY, minZ, cellSide } = grid;

    for (let i = 0; i < n; i++) {
      const i3 = i * 3;
      const px = p[i3], py = p[i3 + 1], pz = p[i3 + 2];
      const cx = Math.floor((px - minX) / cellSide);
      const cy = Math.floor((py - minY) / cellSide);
      const cz = Math.floor((pz - minZ) / cellSide);

      for (let ddz = -1; ddz <= 1; ddz++) {
        const gz = cz + ddz;
        if (gz < 0 || gz >= nz) continue;
        for (let ddy = -1; ddy <= 1; ddy++) {
          const gy = cy + ddy;
          if (gy < 0 || gy >= ny) continue;
          for (let ddx = -1; ddx <= 1; ddx++) {
            const gx = cx + ddx;
            if (gx < 0 || gx >= nx) continue;
            const cellIdx = gx + gy * nx + gz * nx * ny;
            let j = cellHead[cellIdx];
            while (j !== -1) {
              if (j > i) {
                const j3 = j * 3;
                const dx = p[j3] - px, dy = p[j3 + 1] - py, dz = p[j3 + 2] - pz;
                const d2 = dx * dx + dy * dy + dz * dz;
                if (d2 < bondCutoff2 && d2 > minDist2) {
                  const d = Math.sqrt(d2);
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
              j = cellNext[j];
            }
          }
        }
      }
    }
    this.bonds.length = count;
  }

  /**
   * Recompute connected components from the current bond graph using Union-Find.
   * Called after each bond list rebuild so Move/Rotate forces are scoped to the
   * picked atom's connected patch, not all atoms.
   */
  rebuildComponents() {
    const n = this.n;
    const parent = new Int32Array(n);
    for (let i = 0; i < n; i++) parent[i] = i;

    function find(x) {
      while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; }
      return x;
    }

    // Union over current bond list
    for (let b = 0; b < this.bonds.length; b++) {
      const ra = find(this.bonds[b][0]), rb = find(this.bonds[b][1]);
      if (ra !== rb) parent[ra] = rb;
    }

    // Group atoms by root
    const rootToComp = new Map();
    let compCount = 0;
    if (!this.componentId || this.componentId.length !== n) {
      this.componentId = new Int32Array(n);
    }
    this.components = [];

    for (let i = 0; i < n; i++) {
      const root = find(i);
      if (!rootToComp.has(root)) {
        rootToComp.set(root, compCount++);
        this.components.push({ atoms: [], size: 0 });
      }
      const cid = rootToComp.get(root);
      this.componentId[i] = cid;
      this.components[cid].atoms.push(i);
      this.components[cid].size++;
    }

    // Re-resolve active component if interaction is in progress
    if (this.dragAtom >= 0 && (this.isTranslateMode || this.isRotateMode)) {
      this.activeComponent = this.componentId[this.dragAtom];
    }
  }

  /**
   * Run one fixed-size integration step with per-step damping.
   * Called by the accumulator in main.js (speed-controlled) or by step() (legacy).
   */
  stepOnce() {
    this.integrate(DT);
    this.stepCount++;
    // Per-step damping: precomputed factor from legacy damping parameter
    if (this._dampingFactor < 1.0) {
      for (let i = 0; i < this.n * 3; i++) this.vel[i] *= this._dampingFactor;
    }
    if (this.stepCount % 20 === 0) {
      const t0 = this._bench ? performance.now() : 0;
      this.updateBondList();
      if (this._bench) this._bench.bondRebuildMs = (this._bench.bondRebuildMs || 0) + (performance.now() - t0);
      const t1 = this._bench ? performance.now() : 0;
      this.rebuildComponents();
      if (this._bench) this._bench.componentMs = (this._bench.componentMs || 0) + (performance.now() - t1);
    }
  }

  /**
   * Per-batch safety controls: velocity cap + KE cap.
   * Called once per RAF tick after all substeps complete.
   */
  applySafetyControls() {
    for (let i = 0; i < this.n; i++) {
      const ix = i * 3;
      const vMag = Math.sqrt(this.vel[ix]**2 + this.vel[ix+1]**2 + this.vel[ix+2]**2);
      if (vMag > V_HARD_MAX) {
        const s = V_HARD_MAX / vMag;
        this.vel[ix] *= s; this.vel[ix+1] *= s; this.vel[ix+2] *= s;
      }
    }
    const ke = this.getKineticEnergy();
    const keCap = Math.max(KE_CAP_MULT * this.keInitial, this.n * 5.0);
    if (ke > keCap) {
      const s = Math.sqrt(keCap / ke);
      for (let i = 0; i < this.n * 3; i++) this.vel[i] *= s;
    }
  }

  /** Legacy wrapper: runs stepsPerFrame substeps + safety controls. */
  step() {
    for (let s = 0; s < STEPS_PER_FRAME; s++) this.stepOnce();
    this.applySafetyControls();
  }

  // ─── External interaction API ───

  startTranslate(atomIndex) {
    this.dragAtom = atomIndex;
    this.isRotateMode = false;
    this.isTranslateMode = true;
    this.activeComponent = (this.componentId && atomIndex < this.n)
      ? this.componentId[atomIndex] : -1;
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
    this.activeComponent = (this.componentId && atomIndex < this.n)
      ? this.componentId[atomIndex] : -1;
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
    this.activeComponent = -1;
  }

  applyImpulse(atomIndex, vx, vy) {
    const vMag = Math.sqrt(vx * vx + vy * vy);
    if (vMag > V_HARD_MAX) { const s = V_HARD_MAX / vMag; vx *= s; vy *= s; }
    this.vel[atomIndex * 3] += vx;
    this.vel[atomIndex * 3 + 1] += vy;
  }



  /** Returns whole-system COM (all atoms), not component-specific. */
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
    this.activeComponent = -1;
    this.stepCount = 0;
    this.keInitial = 0.1;
    this.computeForces();
    this.updateBondList();
    this.rebuildComponents();
  }

  /**
   * Append a molecule to the existing simulation without resetting state.
   * Preserves existing atom positions, velocities, and forces.
   * @param {Array} atoms - [{x,y,z}] local atom positions
   * @param {Array} bonds - [[i,j,d]] local bond indices
   * @param {number[]} offset - [ox,oy,oz] world-space translation for new atoms
   * @returns {{ atomOffset: number, atomCount: number }}
   */
  appendMolecule(atoms, bonds, offset) {
    const oldN = this.n;
    const addN = atoms.length;
    const newN = oldN + addN;

    // Allocate ALL new buffers before mutating any state.
    // If any allocation throws (OOM), this.* is unchanged.
    const newPos = new Float64Array(newN * 3);
    const newVel = new Float64Array(newN * 3);
    const newForce = new Float64Array(newN * 3);
    const newNlArrays = new Array(newN);
    const newNlCounts = new Int32Array(newN);
    for (let i = 0; i < newN; i++) newNlArrays[i] = new Int32Array(8);

    // --- Past this point, no allocation can throw. Commit state. ---
    if (oldN > 0) {
      newPos.set(this.pos);
      newVel.set(this.vel);
    }

    // Append new atoms with offset
    const ox = offset[0], oy = offset[1], oz = offset[2];
    for (let i = 0; i < addN; i++) {
      const ix = (oldN + i) * 3;
      newPos[ix] = atoms[i].x + ox;
      newPos[ix + 1] = atoms[i].y + oy;
      newPos[ix + 2] = atoms[i].z + oz;
    }

    this.pos = newPos;
    this.vel = newVel;
    this.force = newForce;
    this.n = newN;

    // Append bonds with index offset
    for (let b = 0; b < bonds.length; b++) {
      this.bonds.push([bonds[b][0] + oldN, bonds[b][1] + oldN, bonds[b][2]]);
    }

    this._maxN = newN;
    this._nlArrays = newNlArrays;
    this._nlCounts = newNlCounts;

    // Rebuild derived state. These are pure computations on the committed
    // typed arrays and cannot throw in practice. If they did, the atom
    // positions/velocities are already correct — only forces/bonds/components
    // would be stale, which self-corrects on the next physics.step().
    this.neighborList = null;
    this.computeForces();
    this.updateBondList();
    this.rebuildComponents();

    return { atomOffset: oldN, atomCount: addN };
  }

  /**
   * Clear all atoms from the simulation. Resets to empty state.
   */
  clearScene() {
    this.n = 0;
    this.pos = new Float64Array(0);
    this.vel = new Float64Array(0);
    this.force = new Float64Array(0);
    this.bonds = [];
    this.dragAtom = -1;
    this.isRotateMode = false;
    this.isTranslateMode = false;
    this.activeComponent = -1;
    this.keInitial = 0;
    this.neighborList = null;
    this.stepCount = 0;
    this._maxN = 0;
    this._nlArrays = null;
    this._nlCounts = null;
    this._cellHead = null;
    this._cellNext = null;
    this._bondCellHead = null;
    this._bondCellNext = null;
    this._csrOffsets = null;
    this._csrData = null;
    this._csrGeneration++;
    this.componentId = null;
    this.components = [];
  }

  // ─── User-adjustable parameters ───

  setDragStrength(val) { this.kDrag = val; }
  getDragStrength() { return this.kDrag; }
  setRotateStrength(val) { this.kRotate = val; }
  getRotateStrength() { return this.kRotate; }
  setDamping(val) {
    this.damping = val;
    this._dampingFactor = val > 0 ? Math.pow(1 - val, 1 / STEPS_PER_FRAME) : 1.0;
  }
  getDamping() { return this.damping; }
}
