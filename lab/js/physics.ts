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
import { CONFIG } from './config';
import { initWasm, isReady, callTersoff, marshalCSR, csrIsCurrent } from './tersoff-wasm';
import type { BondTuple } from '../../src/types/interfaces';
import { createBondRules, type BondRuleSet } from '../../src/topology/bond-rules';
import {
  buildBondTopologyAccelerated,
  createBondTopologyWorkspace,
  type BondTopologyWorkspace,
} from '../../src/topology/build-bond-topology';

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

// ─── Spatial hash function (Teschner et al. 2003) ───
function _hashCell(cx, cy, cz, tableSize) {
  return (((cx * 73856093) ^ (cy * 19349663) ^ (cz * 83492791)) & 0x7FFFFFFF) % tableSize;
}

// ─── Force-cap parameters (source-level saturation) ───
const F_MAX_INTERACTION = CONFIG.physics.fMaxInteraction;
const F_REPULSION_START = CONFIG.physics.fRepulsionStart;
const F_MAX_INTERNAL = CONFIG.physics.fMaxInternal;
const V_HARD_MAX = CONFIG.physics.vHardMax;

// ─── Integration defaults (instance-level; see PhysicsEngine.dtFs / .dampingRefSteps) ───

// ─── Unit conversion ───
const ACC_FACTOR = 1.602176634e-29 / 1.9944235e-26;

/** Smooth saturation: f_sat = f / (1 + |f| / fMax). Scales force components in-place. */
function saturateVec3(
  out: { x: number; y: number; z: number },
  fMax: number,
): void {
  const mag = Math.sqrt(out.x * out.x + out.y * out.y + out.z * out.z);
  if (mag <= 0) return;
  const s = 1 / (1 + mag / fMax);
  out.x *= s; out.y *= s; out.z *= s;
}
// Reusable scratch object to avoid allocation in hot loop
const _satScratch = { x: 0, y: 0, z: 0 };

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
  const R_FLAT = R_CUT - D_CUT; // 1.80 — below this, fc=1, dfc=0

  // ── Per-atom-i neighbor geometry cache (Phase 2a) ──
  // Precomputed once per atom i, reused in zeta_ij AND 3-body-ij loops.
  // Targets redundant recomputation (~44.5% of sqrt calls per Phase 0 profiling),
  // but measured only ~2.6% incremental speedup — the JIT likely already optimizes
  // the redundancy at the machine-code level. Kept for correctness and minor gain.
  // Max K per atom is small (~10 for carbon), so stack-level arrays suffice.
  let cacheR = new Float64Array(32);     // r_ik
  let cacheInvR = new Float64Array(32);  // 1/r_ik
  let cacheRx = new Float64Array(32);    // unit vector x
  let cacheRy = new Float64Array(32);    // unit vector y
  let cacheRz = new Float64Array(32);    // unit vector z
  let cacheFc = new Float64Array(32);    // fc(r_ik)
  let cacheDfc = new Float64Array(32);   // dfc/dr(r_ik)
  let cacheValid = new Uint8Array(32);   // 1 if within R_MAX, 0 otherwise

  function ensureCache(len) {
    if (len > cacheR.length) {
      const newLen = len * 2;
      cacheR = new Float64Array(newLen);
      cacheInvR = new Float64Array(newLen);
      cacheRx = new Float64Array(newLen);
      cacheRy = new Float64Array(newLen);
      cacheRz = new Float64Array(newLen);
      cacheFc = new Float64Array(newLen);
      cacheDfc = new Float64Array(newLen);
      cacheValid = new Uint8Array(newLen);
    }
  }

  for (let i = 0; i < n; i++) {
    const ni = nl[i], niLen = nlc[i];
    const ix = i * 3, pix = p[ix], piy = p[ix + 1], piz = p[ix + 2];

    // ── Cache all i-centered neighbor geometry once per atom i ──
    ensureCache(niLen);
    for (let qk = 0; qk < niLen; qk++) {
      const k = ni[qk];
      const kx3 = k * 3;
      const dik_x = p[kx3] - pix, dik_y = p[kx3 + 1] - piy, dik_z = p[kx3 + 2] - piz;
      const r_ik_sq = dik_x * dik_x + dik_y * dik_y + dik_z * dik_z;
      if (r_ik_sq < 1e-20 || r_ik_sq >= R_MAX_SQ) { cacheValid[qk] = 0; continue; }
      cacheValid[qk] = 1;
      const r_ik = Math.sqrt(r_ik_sq);
      const inv_rik = 1.0 / r_ik;
      cacheR[qk] = r_ik;
      cacheInvR[qk] = inv_rik;
      cacheRx[qk] = dik_x * inv_rik;
      cacheRy[qk] = dik_y * inv_rik;
      cacheRz[qk] = dik_z * inv_rik;
      if (r_ik < R_FLAT) { cacheFc[qk] = 1.0; cacheDfc[qk] = 0.0; }
      else {
        const arg = HALF_PI_OVER_D * (r_ik - R_CUT);
        cacheFc[qk] = 0.5 - 0.5 * Math.sin(arg);
        cacheDfc[qk] = -0.5 * Math.cos(arg) * HALF_PI_OVER_D;
      }
    }

    for (let qi = 0; qi < niLen; qi++) {
      const j = ni[qi];
      if (j <= i) continue;
      if (!cacheValid[qi]) continue; // j outside R_MAX (from i's cache)

      const r_ij = cacheR[qi], inv_rij = cacheInvR[qi];
      const rh_ij0 = cacheRx[qi], rh_ij1 = cacheRy[qi], rh_ij2 = cacheRz[qi];
      const fc_ij = cacheFc[qi], dfc_ij = cacheDfc[qi];
      const jx = j * 3;

      const expL1 = Math.exp(-LAMBDA1 * r_ij);
      const expL2 = Math.exp(-LAMBDA2 * r_ij);
      const fR_ij = T_A * expL1;
      const dfR_ij = -LAMBDA1 * fR_ij;
      const fA_ij = -T_B * expL2;
      const dfA_ij = LAMBDA2 * T_B * expL2;

      // ─── Compute zeta_ij (reads from i's cache) ───
      let zeta_ij = 0.0;
      for (let qk = 0; qk < niLen; qk++) {
        if (qk === qi || !cacheValid[qk]) continue;
        let cosT = rh_ij0 * cacheRx[qk] + rh_ij1 * cacheRy[qk] + rh_ij2 * cacheRz[qk];
        if (cosT > 1) cosT = 1; else if (cosT < -1) cosT = -1;
        const hmc = T_H - cosT;
        zeta_ij += cacheFc[qk] * (1.0 + C2_D2 - C2 / (D2 + hmc * hmc));
      }

      // ─── Compute zeta_ji (j's neighbors — NOT cached in Phase 2a) ───
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
        if (r_jk < R_FLAT) fc_jk = 1.0;
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

      // ─── 3-body forces from zeta_ij (reads from i's cache) ───
      if (bz_ij > 0 && zeta_ij > 0) {
        const dbij = -0.5 * BETA * Math.pow(bz_ij, T_N - 1) *
                     Math.pow(1.0 + Math.pow(bz_ij, T_N), INV_2N - 1.0);
        const dEdz = 0.5 * fc_ij * fA_ij * dbij;

        for (let qk = 0; qk < niLen; qk++) {
          if (qk === qi || !cacheValid[qk]) continue;
          const rk0 = cacheRx[qk], rk1 = cacheRy[qk], rk2 = cacheRz[qk];
          const r_ik = cacheR[qk], inv_rik = cacheInvR[qk];
          const fc_ik = cacheFc[qk], dfc_ik = cacheDfc[qk];
          const kx3 = ni[qk] * 3;

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

      // ─── 3-body forces from zeta_ji (j's neighbors — NOT cached) ───
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
          if (r_jk < R_FLAT) { fc_jk = 1.0; dfc_jk = 0.0; }
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
  // Typed storage for dynamic spatial-hash buffers (neighbor-list path only; bond hash moved to src/topology/)
  _hashBuffers: Map<string, Int32Array | number>;

  // ─── Typed field declarations ───
  n!: number;
  pos!: Float64Array;
  vel!: Float64Array;
  force!: Float64Array;
  mass!: number;

  // Containment boundary
  _wallRadius!: number;
  _wallCenter!: number[];
  _wallCenterSet!: boolean;
  _wallMode!: string;
  _wallRemovedCount!: number;

  // Interaction state
  dragAtom!: number;
  isRotateMode!: boolean;
  isTranslateMode!: boolean;
  activeComponent!: number;
  dragTarget!: number[];

  // Neighbor lists and bonds
  neighborList!: Int32Array[] | null;
  bonds!: BondTuple[];
  componentId!: Int32Array | null;
  components!: { atoms: number[]; size: number }[];
  stepCount!: number;

  // User-adjustable parameters
  kDrag!: number;
  kRotate!: number;
  damping!: number;
  _dampingFactor!: number;

  // Engine timing (instance-level, set from config or setTimeConfig)
  dtFs!: number;
  dampingRefSteps!: number;
  /** Reference batch duration in fs for damping normalization. */
  dampingRefDurationFs!: number;

  // Export/identity plumbing — not part of IPhysicsEngine interface
  private _onCompaction: ((keep: number[]) => void) | null = null;

  setCompactionListener(listener: ((keep: number[]) => void) | null): void {
    this._onCompaction = listener;
  }

  // Benchmark timing
  _bench!: Record<string, number> | null;

  // Pre-allocated cache buffers
  _maxN!: number;
  _nlArrays!: Int32Array[] | null;
  _nlCounts!: Int32Array | null;

  // Cell-list spatial acceleration buffers
  _cellHead!: Int32Array | null;
  _cellNext!: Int32Array | null;
  // Shared bond topology (Round 7 extraction)
  _bondRules!: BondRuleSet;
  _bondWorkspace!: BondTopologyWorkspace;

  // CSR neighbor list (Wasm bridge)
  _csrOffsets!: Int32Array | null;
  _csrData!: Int32Array | null;
  _csrGeneration!: number;
  _csrTotalNl!: number;

  // Wasm state
  _forceKernel!: string | null;
  _wasmReady!: boolean;

  // Short neighbor list buffers
  _shortNlArrays!: Int32Array[] | null;
  _shortNlCounts!: Int32Array | null;
  _shortNeighborList!: Int32Array[] | null;

  constructor(opts?: { skipWasmInit?: boolean }) {
    this._hashBuffers = new Map();
    this.n = 0;
    this.pos = null;
    this.vel = null;
    this.force = null;
    this.mass = 1.9944235e-26;

    // ─── Containment boundary ───
    this._wallRadius = 0;       // Å — current wall radius (monotonically increasing until clear)
    this._wallCenter = [0, 0, 0]; // fixed center, set on first molecule placement
    this._wallCenterSet = false;  // true after first molecule sets the center
    this._wallMode = 'contain';   // 'contain' | 'remove'
    this._wallRemovedCount = 0;   // atoms removed by wall (cumulative since last clear)

    this.dragAtom = -1;
    this.isRotateMode = false;
    this.isTranslateMode = false;
    this.activeComponent = -1;
    this.dragTarget = [0, 0, 0];
    this.neighborList = null;
    this.bonds = [];
    this._bondRules = createBondRules({ minDist: CONFIG.bonds.minDist, cutoff: CONFIG.bonds.cutoff });
    this._resetBondWorkspace();
    this.componentId = null;   // Int32Array[n] — component index per atom
    this.components = [];      // [{ atoms: number[], size: number }]
    this.stepCount = 0;
    this.kDrag = CONFIG.physics.kDragDefault;
    this.kRotate = CONFIG.physics.kRotateDefault;
    this.damping = CONFIG.physics.dampingDefault;
    /** Timestep in femtoseconds — used by integrate() and timeline. */
    this.dtFs = CONFIG.physics.dt;
    /** Reference batch size for damping normalization. */
    this.dampingRefSteps = CONFIG.physics.stepsPerFrame;
    this.dampingRefDurationFs = this.dtFs * this.dampingRefSteps;
    this._recomputeDampingFactor();

    // Benchmark timing hooks (null when not benchmarking, zero overhead)
    this._bench = null; // set to {} to enable per-stage timing

    // Pre-allocated cache buffers (resized in init)
    this._maxN = 0;
    this._nlArrays = null;  // Reusable neighbor list sub-arrays
    this._nlCounts = null;  // Int32Array tracking used length of each sub-array

    // Cell-list spatial acceleration buffers (neighbor-list path only; bond hash in _bondWorkspace)
    this._cellHead = null;
    this._cellNext = null;

    // CSR neighbor list (cached derivative for Wasm bridge)
    this._csrOffsets = null;  // Int32Array[n+1]
    this._csrData = null;     // Int32Array[total_neighbors]
    this._csrGeneration = 0;  // incremented on each buildNeighborList()

    // Wasm initialization
    // skipWasmInit: worker manages Wasm lifecycle explicitly via setWasmReady()
    this._wasmReady = false;
    if (opts?.skipWasmInit) {
      this._forceKernel = 'js'; // worker will set via setWasmReady() after explicit init
    } else {
      // Main-thread path: URL param ?kernel=js|wasm|auto overrides config for benchmarking
      const urlKernel = typeof URLSearchParams !== 'undefined'
        ? new URLSearchParams(globalThis.location?.search).get('kernel') : null;
      this._forceKernel = urlKernel; // 'js' | 'wasm' | null (auto)
      if (urlKernel === 'wasm' || (urlKernel !== 'js' && CONFIG.physics.useWasm)) {
        initWasm().then(ok => { this._wasmReady = ok; });
      }
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
    this.bonds = bonds.map(b => [b[0], b[1], b[2]] as BondTuple);
    this._resetBondWorkspace();
    this.stepCount = 0;
    this.neighborList = null;

    this._ensureNeighborListWorkspace();

    this.computeForces();
    this.rebuildComponents();
  }

  /** Ensure the cached neighbor-list workspace (`_nlCounts` /
   *  `_nlArrays`) is allocated and sized for at least `this.n`
   *  entries. Idempotent; no-op when already sized. Called from
   *  `init` and `restoreCheckpoint` — the two paths that can land
   *  on a fresh or cleared engine where the workspace is null or
   *  smaller than the new atom count. The null check is load-bearing:
   *  a fresh `PhysicsEngine` has `_maxN = 0` AND null workspace
   *  buffers, so a `this._maxN < this.n` comparison alone would skip
   *  allocation for an `init(atoms=[])` (the Watch→Lab pending-handoff
   *  boot path — both zero), leaving `buildNeighborList()` to
   *  null-deref `_nlCounts.fill(0)`.
   *
   *  Grow-only: `appendMolecule` and `_removeAtomsOutsideWall` have
   *  their own inline allocation that handles resize + data migration
   *  in one pass; they do not go through this helper. */
  private _ensureNeighborListWorkspace(): void {
    if (this._nlCounts != null && this._nlArrays != null && this._maxN >= this.n) return;
    this._maxN = this.n;
    this._nlArrays = new Array(this.n);
    this._nlCounts = new Int32Array(this.n);
    for (let i = 0; i < this.n; i++) this._nlArrays[i] = new Int32Array(8);
  }

  /** Spatial-hash construction for the NEIGHBOR-LIST path only. O(N) time and
   *  O(N) memory regardless of domain extent. Teschner et al. (2003) hash with
   *  3-pass compact layout (Müller).
   *
   *  The structurally similar bond-path hash now lives in
   *  src/topology/build-bond-topology.ts (buildSpatialHash). A future round
   *  should extract both into one shared low-level spatial-hash helper.
   *
   *  @returns {{ counts, offsets, atoms, cells, tableSize, cellSide }} or null if n===0 */
  _buildCellGrid(cellSide, headKey, _nextKey) {
    const p = this.pos;
    const n = this.n;
    if (n === 0) return null;

    const tableSize = Math.max(n * 2, 64);
    const prefix = headKey;

    // Grow-only allocation — O(N) arrays, independent of domain extent
    if (!this._hashBuffers.get(headKey + '_hashCounts') || (this._hashBuffers.get(headKey + '_hashSize') as number) < tableSize) {
      const _tg = this._bench ? performance.now() : 0;
      this._hashBuffers.set(headKey + '_hashCounts', new Int32Array(tableSize));
      this._hashBuffers.set(headKey + '_hashOffsets', new Int32Array(tableSize));
      this._hashBuffers.set(headKey + '_hashRunning', new Int32Array(tableSize));
      this._hashBuffers.set(headKey + '_hashSize', tableSize);
      if (this._bench) {
        const dt = performance.now() - _tg;
        this._bench[prefix + '_growMs'] = (this._bench[prefix + '_growMs'] || 0) + dt;
        this._bench[prefix + '_reallocCount'] = (this._bench[prefix + '_reallocCount'] || 0) + 1;
      }
    }
    if (!this._hashBuffers.get(headKey + '_hashAtoms') || (this._hashBuffers.get(headKey + '_hashAtoms') as Int32Array).length < n) {
      const _ta = this._bench ? performance.now() : 0;
      this._hashBuffers.set(headKey + '_hashAtoms', new Int32Array(Math.max(n, 64)));
      this._hashBuffers.set(headKey + '_hashCells', new Int32Array(Math.max(n * 3, 192)));
      if (this._bench) {
        const dt = performance.now() - _ta;
        this._bench[prefix + '_growMs'] = (this._bench[prefix + '_growMs'] || 0) + dt;
        this._bench[prefix + '_reallocCount'] = (this._bench[prefix + '_reallocCount'] || 0) + 1;
      }
    }

    const counts = this._hashBuffers.get(headKey + '_hashCounts') as Int32Array;
    const offsets = this._hashBuffers.get(headKey + '_hashOffsets') as Int32Array;
    const running = this._hashBuffers.get(headKey + '_hashRunning') as Int32Array;
    const atoms = this._hashBuffers.get(headKey + '_hashAtoms') as Int32Array;
    const cells = this._hashBuffers.get(headKey + '_hashCells') as Int32Array;

    const _bt0 = this._bench ? performance.now() : 0;

    // Pass 1: compute cell coords and count per hash bucket
    counts.fill(0, 0, tableSize);
    const invCS = 1.0 / cellSide;
    for (let i = 0; i < n; i++) {
      const i3 = i * 3;
      const cx = Math.floor(p[i3] * invCS);
      const cy = Math.floor(p[i3 + 1] * invCS);
      const cz = Math.floor(p[i3 + 2] * invCS);
      cells[i3] = cx; cells[i3 + 1] = cy; cells[i3 + 2] = cz;
      const h = _hashCell(cx, cy, cz, tableSize);
      counts[h]++;
    }

    // Pass 2: prefix sum → offsets
    offsets[0] = 0;
    for (let h = 1; h < tableSize; h++) {
      offsets[h] = offsets[h - 1] + counts[h - 1];
    }

    // Pass 3: scatter atoms into sorted order
    running.fill(0, 0, tableSize);
    for (let i = 0; i < n; i++) {
      const i3 = i * 3;
      const h = _hashCell(cells[i3], cells[i3 + 1], cells[i3 + 2], tableSize);
      atoms[offsets[h] + running[h]] = i;
      running[h]++;
    }

    if (this._bench) {
      this._bench[prefix + '_clearMs'] = (this._bench[prefix + '_clearMs'] || 0) + 0; // no fill cost in spatial hash
      this._bench[prefix + '_insertMs'] = (this._bench[prefix + '_insertMs'] || 0) + (performance.now() - _bt0);
    }

    return { counts, offsets, atoms, cells, tableSize, cellSide };
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

    const hash = this._buildCellGrid(cutoff, '_cellHead', '_cellNext');
    if (!hash) { this.neighborList = arrays; return; }
    const { counts: hCounts, offsets, atoms: hAtoms, cells, tableSize, cellSide } = hash;
    const invCS = 1.0 / cellSide;

    // ─── Search 27 neighboring cells via spatial hash for each atom ───
    for (let i = 0; i < n; i++) {
      const i3 = i * 3;
      const px = p[i3], py = p[i3 + 1], pz = p[i3 + 2];
      const cx = cells[i3], cy = cells[i3 + 1], cz = cells[i3 + 2];

      for (let dz = -1; dz <= 1; dz++) {
        const ncz = cz + dz;
        for (let dy = -1; dy <= 1; dy++) {
          const ncy = cy + dy;
          for (let dx = -1; dx <= 1; dx++) {
            const ncx = cx + dx;
            const h = _hashCell(ncx, ncy, ncz, tableSize);
            const start = offsets[h];
            const end = start + hCounts[h];
            for (let k = start; k < end; k++) {
              const j = hAtoms[k];
              // Filter hash collisions: verify exact cell match
              if (cells[j * 3] !== ncx || cells[j * 3 + 1] !== ncy || cells[j * 3 + 2] !== ncz) continue;
              if (j <= i) continue;
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
          }
        }
      }
    }
    this.neighborList = arrays;
    this._nlCounts = counts;

    // CSR is now built from the short list in _buildShortNeighborList() every step.
    // _csrGeneration is incremented there, not here.
  }

  /**
   * Build short neighbor list at exact Tersoff cutoff (R_MAX = 2.10 Å) from
   * current positions. Filters the skin-expanded list (2.60 Å) every step.
   * The kernel iterates this short list instead of the full skin list,
   * eliminating ~52-67% wasted inner-loop iterations (measured on Phase 0 benchmark set;
   * actual reduction depends on topology and neighbor density).
   */
  _buildShortNeighborList() {
    const p = this.pos;
    const n = this.n;
    const arrays = this.neighborList;
    const counts = this._nlCounts;
    const R_MAX_SQ = R_MAX * R_MAX;

    // Reuse or allocate short-list arrays
    if (!this._shortNlArrays || this._shortNlArrays.length !== n) {
      this._shortNlArrays = new Array(n);
      this._shortNlCounts = new Int32Array(n);
      for (let i = 0; i < n; i++) this._shortNlArrays[i] = new Int32Array(8);
    }
    const shortArrays = this._shortNlArrays;
    const shortCounts = this._shortNlCounts;
    shortCounts.fill(0);

    for (let i = 0; i < n; i++) {
      const i3 = i * 3;
      const px = p[i3], py = p[i3 + 1], pz = p[i3 + 2];
      const arr = arrays[i];
      const cnt = counts[i];

      for (let q = 0; q < cnt; q++) {
        const j = arr[q];
        const j3 = j * 3;
        const dx = p[j3] - px, dy = p[j3 + 1] - py, dz = p[j3 + 2] - pz;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 < R_MAX_SQ && d2 > 1e-20) {
          // Grow if needed
          if (shortCounts[i] >= shortArrays[i].length) {
            const old = shortArrays[i];
            shortArrays[i] = new Int32Array(old.length * 2);
            shortArrays[i].set(old);
          }
          shortArrays[i][shortCounts[i]++] = j;
        }
      }
    }

    this._shortNeighborList = shortArrays;
    this._shortNlCounts = shortCounts;

    // Build CSR from the short list for Wasm bridge
    this._csrGeneration++;
    let totalNl = 0;
    for (let i = 0; i < n; i++) totalNl += shortCounts[i];
    this._csrTotalNl = totalNl;
    // Reuse CSR arrays if large enough (avoid per-step allocation/GC pressure)
    if (!this._csrOffsets || this._csrOffsets.length < n + 1) {
      this._csrOffsets = new Int32Array(n + 1);
    }
    if (!this._csrData || this._csrData.length < totalNl) {
      this._csrData = new Int32Array(Math.max(totalNl, 64));
    }
    this._csrOffsets[0] = 0;
    let idx = 0;
    for (let i = 0; i < n; i++) {
      this._csrOffsets[i + 1] = this._csrOffsets[i] + shortCounts[i];
      const arr = shortArrays[i];
      for (let q = 0; q < shortCounts[i]; q++) this._csrData[idx++] = arr[q];
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

    // ── Build short Tersoff neighbor list (exact R_MAX cutoff from current positions) ──
    this._buildShortNeighborList();

    // ── Tersoff kernel dispatch: Wasm if ready, JS fallback ──
    // ?kernel=js forces JS, ?kernel=wasm forces Wasm (fails if not ready)
    const useWasm = this._forceKernel !== 'js' && this._wasmReady && isReady();
    let _csrMarshalThisStep = 0;

    if (useWasm) {
      // Ensure CSR is marshaled into Wasm memory
      let wasmOk = false;
      if (!csrIsCurrent(this._csrGeneration)) {
        const csrResult = marshalCSR(this._csrOffsets, this._csrData, this.n, this._csrGeneration, this._csrTotalNl);
        if (this._bench) this._bench.csrMarshalMs = (this._bench.csrMarshalMs || 0) + csrResult.csrMarshalMs;
        _csrMarshalThisStep = csrResult.csrMarshalMs;
        if (csrResult.ok) wasmOk = true;
      } else {
        wasmOk = true;
      }
      if (wasmOk) {
        const timing = callTersoff(this.pos, this.force, this.n);
        if (!timing.ok) {
          // Kernel call failed — fall back to JS for this step
          this.force.fill(0);
          const t1 = this._bench ? performance.now() : 0;
          computeTersoffForces(this.pos, this.force, this._shortNeighborList, this._shortNlCounts, this.n);
          if (this._bench) this._bench.tersoffMs = (this._bench.tersoffMs || 0) + (performance.now() - t1);
        } else if (this._bench) {
          this._bench.tersoffMs = (this._bench.tersoffMs || 0) + timing.pathMs;
          this._bench.marshalMs = (this._bench.marshalMs || 0) + timing.marshalMs;
          this._bench.wasmKernelMs = (this._bench.wasmKernelMs || 0) + timing.kernelMs;
          this._bench.wasmPathTotalMs = (this._bench.wasmPathTotalMs || 0) +
            timing.pathMs + _csrMarshalThisStep;
        }
      } else {
        // Marshal failed — fall back to JS for this step
        const t1 = this._bench ? performance.now() : 0;
        computeTersoffForces(this.pos, this.force, this._shortNeighborList, this._shortNlCounts, this.n);
        if (this._bench) this._bench.tersoffMs = (this._bench.tersoffMs || 0) + (performance.now() - t1);
      }
    } else {
      const t1 = this._bench ? performance.now() : 0;
      computeTersoffForces(this.pos, this.force, this._shortNeighborList, this._shortNlCounts, this.n);
      if (this._bench) this._bench.tersoffMs = (this._bench.tersoffMs || 0) + (performance.now() - t1);
    }

    // ── Containment wall ──
    if (this._wallRadius > 0) {
      const wcx = this._wallCenter[0], wcy = this._wallCenter[1], wcz = this._wallCenter[2];
      const Rw = this._wallRadius;
      const K = CONFIG.wall.springK;

      if (this._wallMode === 'remove') {
        // Remove mode: delete any atom beyond R_wall. The wall is generous
        // (~116 Å for 60 atoms) — anything that far out was intentionally flung.
        // No neighbor check: fragments (bonded pairs/clusters) flying together
        // must also be removed, not just isolated atoms.
        const removeR = Rw + CONFIG.wall.removeMargin;
        const removeR2 = removeR * removeR;
        let needRemoval = false;
        for (let i = 0; i < this.n; i++) {
          const i3 = i * 3;
          const dx = this.pos[i3] - wcx, dy = this.pos[i3 + 1] - wcy, dz = this.pos[i3 + 2] - wcz;
          if (dx * dx + dy * dy + dz * dz > removeR2) {
            needRemoval = true;
            break;
          }
        }
        if (needRemoval) {
          this._removeAtomsOutsideWall(removeR);
          this._recomputeForcesAfterRemoval();
        }
      }

      // Apply harmonic wall force to atoms outside R_wall (Contain mode only)
      // In Remove mode, atoms fly freely past the wall and are deleted at the margin.
      if (this._wallMode !== 'remove')
      for (let i = 0; i < this.n; i++) {
        const i3 = i * 3;
        const dx = this.pos[i3] - wcx, dy = this.pos[i3 + 1] - wcy, dz = this.pos[i3 + 2] - wcz;
        const r2 = dx * dx + dy * dy + dz * dz;
        if (r2 > Rw * Rw) {
          const r = Math.sqrt(r2);
          const f = -K * (r - Rw) / r;
          this.force[i3] += f * dx;
          this.force[i3 + 1] += f * dy;
          this.force[i3 + 2] += f * dz;
        }
      }
    }

    // ── Saturate internal forces (Tersoff + wall) before adding interaction forces ──
    // Per-atom thresholded smooth saturation: exact below F_REPULSION_START,
    // compressed above. Runs BEFORE interaction forces so user-driven forces
    // are not affected by internal-force limiting.
    this.saturateInternalForces();

    // ── Interaction forces: UX layer ──
    // Drag spring, rotation torque — user-driven forces.

    // ─── User drag force (single atom) — full 3D in camera plane ───
    if (this.dragAtom >= 0 && !this.isRotateMode && !this.isTranslateMode) {
      const ix = this.dragAtom * 3;
      _satScratch.x = this.kDrag * (this.dragTarget[0] - this.pos[ix]);
      _satScratch.y = this.kDrag * (this.dragTarget[1] - this.pos[ix + 1]);
      _satScratch.z = this.kDrag * (this.dragTarget[2] - this.pos[ix + 2]);
      saturateVec3(_satScratch, F_MAX_INTERACTION);
      this.force[ix] += _satScratch.x;
      this.force[ix + 1] += _satScratch.y;
      this.force[ix + 2] += _satScratch.z;
    }

    // ─── User translate force (connected component) ───
    // Uniform force on all atoms in the picked atom's connected patch,
    // normalized by component size so total force is size-independent.
    // Saturation applied to the TOTAL spring force before dividing by N,
    // preserving the size-independent total-force contract.
    if (this.dragAtom >= 0 && this.isTranslateMode) {
      const ix = this.dragAtom * 3;
      const dx = this.dragTarget[0] - this.pos[ix];
      const dy = this.dragTarget[1] - this.pos[ix + 1];
      const dz = this.dragTarget[2] - this.pos[ix + 2];
      const comp = this.activeComponent >= 0 ? this.components[this.activeComponent] : null;
      const atoms = comp ? comp.atoms : [this.dragAtom];
      // Saturate total group spring force, then divide by N
      _satScratch.x = this.kDrag * dx;
      _satScratch.y = this.kDrag * dy;
      _satScratch.z = this.kDrag * dz;
      saturateVec3(_satScratch, F_MAX_INTERACTION);
      const perAtomX = _satScratch.x / atoms.length;
      const perAtomY = _satScratch.y / atoms.length;
      const perAtomZ = _satScratch.z / atoms.length;
      for (let k = 0; k < atoms.length; k++) {
        const jx = atoms[k] * 3;
        this.force[jx] += perAtomX; this.force[jx + 1] += perAtomY; this.force[jx + 2] += perAtomZ;
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

      // Spring force scaled by inertia ratio, then saturated pre-torque
      const dx = this.dragTarget[0] - pos[aix];
      const dy = this.dragTarget[1] - pos[aix + 1];
      const dz = this.dragTarget[2] - pos[aix + 2];
      _satScratch.x = this.kRotate * inertiaScale * dx;
      _satScratch.y = this.kRotate * inertiaScale * dy;
      _satScratch.z = this.kRotate * inertiaScale * dz;
      saturateVec3(_satScratch, F_MAX_INTERACTION);
      const Fx = _satScratch.x, Fy = _satScratch.y, Fz = _satScratch.z;

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

  /**
   * Per-atom thresholded smooth saturation for internal forces (Tersoff + wall).
   * Replaces the old global-scaling clampForces().
   *
   * Below F_REPULSION_START: exact physics (zero cost — early continue).
   * Above F_REPULSION_START: smooth compression toward F_MAX_INTERNAL.
   * Formula: f_eff = start + excess / (1 + excess / headroom)
   */
  saturateInternalForces() {
    const headroom = F_MAX_INTERNAL - F_REPULSION_START;
    if (headroom <= 0) return; // misconfigured — no-op rather than corrupt forces
    for (let i = 0; i < this.n; i++) {
      const ix = i * 3;
      const fx = this.force[ix], fy = this.force[ix + 1], fz = this.force[ix + 2];
      const mag = Math.sqrt(fx * fx + fy * fy + fz * fz);
      if (mag <= F_REPULSION_START) continue;
      const excess = mag - F_REPULSION_START;
      const effMag = F_REPULSION_START + excess / (1 + excess / headroom);
      const s = effMag / mag;
      this.force[ix] *= s;
      this.force[ix + 1] *= s;
      this.force[ix + 2] *= s;
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
    for (let i = 0; i < this.n; i++) {
      const ix = i * 3;
      this.vel[ix] += 0.5 * this.force[ix] * a * dt;
      this.vel[ix + 1] += 0.5 * this.force[ix + 1] * a * dt;
      this.vel[ix + 2] += 0.5 * this.force[ix + 2] * a * dt;
    }
  }

  /** Reset bond workspace to a small initial allocation. Called on all
   *  full-state-replacement paths: constructor, init(), clearScene(),
   *  restoreCheckpoint(), and _removeAtomsOutsideWall(). Grow-only during
   *  active simulation (updateBondList / appendMolecule do not reset). */
  private _resetBondWorkspace(): void {
    this._bondWorkspace = createBondTopologyWorkspace(64);
  }

  /**
   * Update bond list via the shared accelerated topology builder.
   * Delegates to buildBondTopologyAccelerated() with output-buffer reuse.
   * The public API (this.bonds, getBonds()) is unchanged.
   */
  updateBondList() {
    if (this.n === 0) { this.bonds.length = 0; return; }
    const count = buildBondTopologyAccelerated(
      this.n, this.pos, null, this._bondRules, this._bondWorkspace, this.bonds,
    );
    this.bonds.length = count;
  }

  /** Refresh bond topology + connected components in one call.
   *  Use this whenever bond graph may have changed and downstream code
   *  (interaction scoping, bonded-group panel) needs fresh component data. */
  refreshTopology() {
    this.updateBondList();
    this.rebuildComponents();
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
    this.integrate(this.dtFs);
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
   * Per-batch safety controls: per-atom velocity hard cap only.
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
  }

  /** Legacy wrapper: runs dampingRefSteps substeps + safety controls. */
  step() {
    for (let s = 0; s < this.dampingRefSteps; s++) this.stepOnce();
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
    this._resetBondWorkspace();
    this.dragAtom = -1;
    this.isRotateMode = false;
    this.isTranslateMode = false;
    this.activeComponent = -1;
    this.neighborList = null;
    this.stepCount = 0;
    this._maxN = 0;
    this._nlArrays = null;
    this._nlCounts = null;
    this._cellHead = null;
    this._cellNext = null;
    this._csrOffsets = null;
    this._csrData = null;
    this._csrGeneration++;
    this._shortNlArrays = null;
    this._shortNlCounts = null;
    this._shortNeighborList = null;
    this.componentId = null;
    this.components = [];
    this._wallRadius = 0;
    this._wallCenter = [0, 0, 0];
    this._wallCenterSet = false;
    this._wallRemovedCount = 0;
  }

  /**
   * Update wall radius based on current atom count and target density.
   * In contain mode: monotonically increasing (only grows).
   * In remove mode: allows controlled shrinkage after removal, with hysteresis.
   */
  updateWallRadius() {
    if (this.n === 0) return;
    const density = CONFIG.wall.density;
    const padding = CONFIG.wall.padding;
    const densityRadius = Math.cbrt((3 * this.n) / (4 * Math.PI * density));
    const targetRadius = densityRadius + padding;
    if (targetRadius > this._wallRadius) {
      this._wallRadius = targetRadius;
    }
  }

  /**
   * Recompute wall radius after boundary removal reduces atom count.
   * Allows shrinkage in remove mode so the boundary stays meaningful
   * for the reduced system. Uses 2× the density-derived radius as a
   * hysteresis band — only shrinks if the current wall is more than
   * double the target for the active atom count.
   */
  shrinkWallRadiusAfterRemoval() {
    if (this.n === 0) return; // handled by the n===0 reset in _removeAtomsOutsideWall
    if (this._wallMode !== 'remove') return; // contain mode stays monotonic
    const density = CONFIG.wall.density;
    const padding = CONFIG.wall.padding;
    const hysteresis = CONFIG.wall.shrinkHysteresis;
    const targetRadius = Math.cbrt((3 * this.n) / (4 * Math.PI * density)) + padding;
    if (this._wallRadius > targetRadius * hysteresis) {
      this._wallRadius = targetRadius * hysteresis;
    }
  }

  /**
   * Recenter the wall to the COM of surviving atoms after a large asymmetric removal.
   * Only fires when the removal fraction exceeds CONFIG.wall.recenterThreshold.
   *
   * v1 limitation: uses single-event fraction, not cumulative drift. If the system
   * loses atoms through many small removals (each below threshold), the wall center
   * may lag behind the surviving structure. Future options if this becomes noticeable:
   *   - cumulative recenter debt across multiple removals
   *   - recenter when COM drift exceeds a distance threshold
   *   - recenter when both removal fraction and COM shift are significant
   *
   * @param {number} removedCount — atoms removed in this event
   * @param {number} prevN — atom count before removal
   */
  _recenterWallAfterRemoval(removedCount, prevN) {
    if (this.n === 0) return; // handled by the n===0 reset
    const fraction = removedCount / prevN;
    if (fraction < CONFIG.wall.recenterThreshold) return; // small removal — keep center stable
    // Recompute center from surviving atom positions
    let cx = 0, cy = 0, cz = 0;
    for (let i = 0; i < this.n; i++) {
      cx += this.pos[i * 3];
      cy += this.pos[i * 3 + 1];
      cz += this.pos[i * 3 + 2];
    }
    this._wallCenter[0] = cx / this.n;
    this._wallCenter[1] = cy / this.n;
    this._wallCenter[2] = cz / this.n;
  }

  /**
   * Recompute forces after boundary removal reduced the atom count.
   * Uses JS Tersoff kernel directly (not Wasm) to avoid re-marshaling CSR
   * mid-step. This is an intentional rare slow-path: boundary removal is
   * infrequent and the one-step JS fallback has negligible impact on overall
   * performance. The Wasm path resumes on the next normal step.
   */
  _recomputeForcesAfterRemoval() {
    if (this.n === 0) return;
    if (this._bench) {
      this._bench.removalRecomputeCount = (this._bench.removalRecomputeCount || 0) + 1;
    }
    this.force.fill(0);
    this.buildNeighborList();
    this._buildShortNeighborList();
    computeTersoffForces(this.pos, this.force, this._shortNeighborList, this._shortNlCounts, this.n);
  }

  /**
   * Set wall center to the COM of newly placed atoms.
   * Called on first molecule placement; subsequent placements blend the center.
   */
  updateWallCenter(atoms, offset) {
    let cx = 0, cy = 0, cz = 0;
    for (const a of atoms) {
      cx += a.x + offset[0];
      cy += a.y + offset[1];
      cz += a.z + offset[2];
    }
    cx /= atoms.length; cy /= atoms.length; cz /= atoms.length;

    if (!this._wallCenterSet) {
      this._wallCenter[0] = cx;
      this._wallCenter[1] = cy;
      this._wallCenter[2] = cz;
      this._wallCenterSet = true;
    } else {
      // Weighted blend: existing center weighted by (n - newAtoms), new by newAtoms
      const w = atoms.length / this.n;
      this._wallCenter[0] += w * (cx - this._wallCenter[0]);
      this._wallCenter[1] += w * (cy - this._wallCenter[1]);
      this._wallCenter[2] += w * (cz - this._wallCenter[2]);
    }
  }

  setWallMode(mode: 'contain' | 'remove') { this._wallMode = mode; }
  getWallMode() { return this._wallMode; }
  getWallRadius() { return this._wallRadius; }
  getWallRemovedCount() { return this._wallRemovedCount; }
  getActiveAtomCount() { return this.n; }

  /** Snapshot boundary state for timeline checkpoints. */
  getBoundarySnapshot(): {
    mode: 'contain' | 'remove';
    wallRadius: number;
    wallCenter: [number, number, number];
    wallCenterSet: boolean;
    removedCount: number;
    damping: number;
  } {
    return {
      mode: this._wallMode as 'contain' | 'remove',
      wallRadius: this._wallRadius,
      wallCenter: [this._wallCenter[0], this._wallCenter[1], this._wallCenter[2]],
      wallCenterSet: this._wallCenterSet,
      removedCount: this._wallRemovedCount,
      damping: this.damping,
    };
  }

  /** Restore boundary state from a timeline checkpoint snapshot. */
  restoreBoundarySnapshot(snap: {
    mode: 'contain' | 'remove';
    wallRadius: number;
    wallCenter: [number, number, number];
    wallCenterSet: boolean;
    removedCount: number;
    damping: number;
  }): void {
    this._wallMode = snap.mode;
    this._wallRadius = snap.wallRadius;
    this._wallCenter[0] = snap.wallCenter[0];
    this._wallCenter[1] = snap.wallCenter[1];
    this._wallCenter[2] = snap.wallCenter[2];
    this._wallCenterSet = snap.wallCenterSet;
    this._wallRemovedCount = snap.removedCount;
    this.setDamping(snap.damping);
  }

  /**
   * Remove all atoms beyond the wall radius from wall center.
   * Removes any atom (isolated or bonded) that has crossed the boundary.
   * Compacts pos/vel/force arrays in-place. Triggers neighbor/bond rebuild.
   */
  _removeAtomsOutsideWall(wallR) {
    const wcx = this._wallCenter[0], wcy = this._wallCenter[1], wcz = this._wallCenter[2];
    const Rw2 = wallR * wallR;
    const keep = [];
    for (let i = 0; i < this.n; i++) {
      const i3 = i * 3;
      const dx = this.pos[i3] - wcx, dy = this.pos[i3 + 1] - wcy, dz = this.pos[i3 + 2] - wcz;
      if (dx * dx + dy * dy + dz * dz <= Rw2) {
        keep.push(i);
      }
    }
    const removed = this.n - keep.length;
    if (removed === 0) return;

    this._wallRemovedCount += removed;
    const newN = keep.length;
    const newPos = new Float64Array(newN * 3);
    const newVel = new Float64Array(newN * 3);
    const newForce = new Float64Array(newN * 3);
    for (let k = 0; k < newN; k++) {
      const old3 = keep[k] * 3;
      const new3 = k * 3;
      newPos[new3] = this.pos[old3];
      newPos[new3 + 1] = this.pos[old3 + 1];
      newPos[new3 + 2] = this.pos[old3 + 2];
      newVel[new3] = this.vel[old3];
      newVel[new3 + 1] = this.vel[old3 + 1];
      newVel[new3 + 2] = this.vel[old3 + 2];
      newForce[new3] = this.force[old3];
      newForce[new3 + 1] = this.force[old3 + 1];
      newForce[new3 + 2] = this.force[old3 + 2];
    }
    this.pos = newPos;
    this.vel = newVel;
    this.force = newForce;
    this.n = newN;
    this._maxN = newN;
    this._nlArrays = new Array(newN);
    this._nlCounts = new Int32Array(newN);
    for (let i = 0; i < newN; i++) this._nlArrays[i] = new Int32Array(8);
    this.neighborList = null;
    // Bonds and components will be rebuilt on next updateBondList/rebuildComponents cycle
    this.bonds = [];
    this._resetBondWorkspace();
    this.componentId = null;
    this.components = [];
    this.activeComponent = -1;
    this.isRotateMode = false;
    this.isTranslateMode = false;
    if (this.dragAtom >= 0) {
      if (!keep.includes(this.dragAtom)) {
        this.dragAtom = -1;
      } else {
        this.dragAtom = keep.indexOf(this.dragAtom);
      }
    }

    // If removal emptied the system, reset wall state so next molecule
    // gets a fresh boundary scaled to its own size, not the old scene's.
    if (this.n === 0) {
      this._wallRadius = 0;
      this._wallCenter = [0, 0, 0];
      this._wallCenterSet = false;
    } else {
      // Partial removal: recenter if asymmetric, then shrink in remove mode
      this._recenterWallAfterRemoval(removed, removed + this.n);
      this.shrinkWallRadiusAfterRemoval();
    }
    // Notify identity tracker of compaction mapping
    if (this._onCompaction) this._onCompaction(keep);
  }

  // ─── Checkpoint / restore ───

  createCheckpoint(): { n: number; pos: Float64Array; vel: Float64Array; bonds: BondTuple[]; } {
    return {
      n: this.n,
      pos: this.pos ? new Float64Array(this.pos.slice(0, this.n * 3)) : new Float64Array(0),
      vel: this.vel ? new Float64Array(this.vel.slice(0, this.n * 3)) : new Float64Array(0),
      bonds: this.bonds ? this.bonds.map(b => [b[0], b[1], b[2]] as BondTuple) : [],
    };
  }

  restoreCheckpoint(cp: { n: number; pos: Float64Array; vel: Float64Array; bonds: BondTuple[]; }) {
    this.n = cp.n;
    this.pos = new Float64Array(cp.pos);
    this.vel = new Float64Array(cp.vel);
    this.force = new Float64Array(cp.n * 3);
    this.bonds = [];
    this._resetBondWorkspace();
    this.neighborList = null;  // force rebuild
    this._ensureNeighborListWorkspace();
    this.computeForces();
    this.updateBondList();  // recomputes bonds from restored positions
    this.rebuildComponents();
  }

  // ─── Debug invariant checks ───

  /** Verify internal array consistency after an append. Throws on violation. */
  assertPostAppendInvariants(): void {
    const ok = this.pos.length >= this.n * 3
      && this.vel.length >= this.n * 3
      && this.force.length >= this.n * 3
      && (!this.componentId || this.componentId.length >= this.n);
    if (!ok) throw new Error(`[assertion] Post-append array invariant: n=${this.n}, pos=${this.pos.length}`);
    for (let b = 0; b < this.bonds.length; b++) {
      if (this.bonds[b][0] >= this.n || this.bonds[b][1] >= this.n) {
        throw new Error(`[assertion] Bond ${b} index out of range: [${this.bonds[b][0]}, ${this.bonds[b][1]}], n=${this.n}`);
      }
    }
  }

  // ─── Wasm kernel control ───

  /** Explicitly set Wasm readiness (used by worker after awaiting initWasm). */
  setWasmReady(ready: boolean): void {
    this._wasmReady = ready;
    if (ready) this._forceKernel = null; // auto — prefer Wasm
  }

  /** Returns which kernel will be used for the next force computation. */
  getActiveKernel(): 'wasm' | 'js' {
    return (this._forceKernel !== 'js' && this._wasmReady && isReady()) ? 'wasm' : 'js';
  }

  // ─── User-adjustable parameters ───

  setDragStrength(val: number) { this.kDrag = val; }
  getDragStrength() { return this.kDrag; }
  setRotateStrength(val: number) { this.kRotate = val; }
  getRotateStrength() { return this.kRotate; }
  setDamping(val: number) {
    this.damping = val;
    this._recomputeDampingFactor();
  }
  getDamping() { return this.damping; }

  /** Get timestep in femtoseconds. */
  getDtFs() { return this.dtFs; }

  /** Set engine timing from protocol config.
   *
   *  Two-arg form (legacy, dt + dampingRefSteps only): preserves the
   *  boot-time `dampingRefDurationFs`. This is the path the Lab runtime
   *  uses during normal init — the reference duration was pinned at
   *  construction and should not silently shift with every step-rate
   *  change.
   *
   *  Three-arg form (authoritative, with `dampingRefDurationFs`): used
   *  by restore paths that need to reinstate a previously-captured
   *  damping calibration (Watch → Lab handoff, future timeline
   *  restart). Without this overload, the engine's
   *  `_recomputeDampingFactor` computes the decay rate against the
   *  boot-default duration rather than the handed-off one — correct
   *  TS shape, wrong physics. See `normalize-watch-seed.ts` for the
   *  producer side.
   */
  setTimeConfig(dtFs: number, dampingRefSteps: number, dampingRefDurationFs?: number) {
    this.dtFs = dtFs;
    this.dampingRefSteps = dampingRefSteps;
    if (dampingRefDurationFs !== undefined && Number.isFinite(dampingRefDurationFs) && dampingRefDurationFs > 0) {
      this.dampingRefDurationFs = dampingRefDurationFs;
    }
    // else: dampingRefDurationFs stays at its current value (boot default
    // OR a previously-restored authoritative value — never silently
    // recomputed from dt * refSteps, which would break step-rate-
    // invariant decay).
    this._recomputeDampingFactor();
  }

  /** Convert user-facing damping to a per-step velocity multiplier using
   *  time-based exponential decay. The damping parameter d represents the
   *  fractional velocity loss over the reference batch duration (dampingRefDurationFs).
   *  This is converted to a decay rate (gamma per fs) then to a per-step
   *  factor at the current dtFs, so changing dtFs preserves the physical
   *  decay per simulated time. */
  _recomputeDampingFactor() {
    if (this.damping <= 0) { this._dampingFactor = 1.0; return; }
    const gamma = -Math.log(1 - this.damping) / this.dampingRefDurationFs;
    this._dampingFactor = Math.exp(-gamma * this.dtFs);
  }
}
