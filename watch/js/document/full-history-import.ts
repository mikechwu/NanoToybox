/**
 * Full history importer — normalizes v1 file data into playback-ready model.
 *
 * Conversions performed:
 *   - number[] → Float64Array for positions/velocities
 *   - { a, b, distance } → [a, b, distance] for bonds
 *   - Precomputes restartAlignedToDense flag
 *   - Round 6: precomputes InterpolationCapability (per-frame / per-bracket /
 *     per-4-window flags + reasons) + importDiagnostics + velocityUnit
 *
 * All frame types (dense, restart, checkpoint) are normalized consistently.
 * Checkpoints are normalized but not consumed by v1 playback.
 */

import type { AtomDojoHistoryFileV1, AtomInfoV1, SimulationMetaV1, PhysicsConfigV1 } from '../../../src/history/history-file-v1';
import { IMPLAUSIBLE_VELOCITY_A_PER_FS } from '../../../src/history/units';

// ── Normalized types ──

export interface NormalizedDenseFrame {
  frameId: number;
  timePs: number;
  n: number;
  atomIds: number[];
  positions: Float64Array;
  interaction: unknown;
  boundary: unknown;
}

export interface NormalizedRestartFrame {
  frameId: number;
  timePs: number;
  n: number;
  atomIds: number[];
  positions: Float64Array;
  velocities: Float64Array;
  bonds: [number, number, number][];
  config: PhysicsConfigV1;
  interaction: unknown;
  boundary: unknown;
}

export interface NormalizedCheckpoint {
  checkpointId: number;
  timePs: number;
  physics: {
    n: number;
    atomIds: number[];
    positions: Float64Array;
    velocities: Float64Array;
    bonds: [number, number, number][];
  };
  config: PhysicsConfigV1;
  interaction: unknown;
  boundary: unknown;
}

// ── Round 6: interpolation capability layer ──

/** Why a dense frame cannot serve as a velocity-safe endpoint. Endpoint-oriented. */
export type VelocityEndpointReason =
  | 'ok'
  | 'restart-misaligned'
  | 'restart-n-mismatch'
  | 'atomids-mismatch'
  | 'velocities-implausible';

/** Why a dense frame index i cannot serve as the start of a valid 2-frame bracket. */
export type BracketReason =
  | 'ok'
  | 'last-frame'
  | 'bracket-n-mismatch'
  | 'bracket-atomids-mismatch';

/** Why a dense frame index i cannot anchor a 4-frame window (f[i-1], f[i], f[i+1], f[i+2]). */
export type WindowReason =
  | 'ok'
  | 'timeline-edge'
  | 'window-n-mismatch'
  | 'window-atomids-mismatch';

/** Precomputed, hot-path-friendly capability layer. All arrays are indexed
 *  by dense frame index. bracketSafe[i] / hermiteSafe[i] / window4Safe[i]
 *  refer to the bracket or window *starting at* / *anchored at* dense frame i.
 *  Diagnostic arrays are regular arrays (cold path — read only when a fallback
 *  needs explanation). Typed-array flags drive the hot-path resolution loop. */
export interface InterpolationCapability {
  denseToRestartIndex: Int32Array;
  velocityReason: VelocityEndpointReason[];
  bracketSafe: Uint8Array;
  bracketReason: BracketReason[];
  hermiteSafe: Uint8Array;
  window4Safe: Uint8Array;
  window4Reason: WindowReason[];
}

/** Typed diagnostic codes — string literals so tests and UI code can
 *  switch() exhaustively and typos fail at compile time. */
export type ImportDiagnosticCode =
  | 'velocities-implausible'
  | 'restart-count-mismatch'
  | 'restart-time-mismatch'
  | 'atomids-mismatch-at-frame';

export interface ImportDiagnostic {
  severity: 'info' | 'warn' | 'error';
  code: ImportDiagnosticCode;
  message: string;
  /** Optional frame index for locating the issue. */
  frameIndex?: number;
}

export interface LoadedFullHistory {
  kind: 'full';
  simulation: SimulationMetaV1;
  atoms: AtomInfoV1[];
  denseFrames: NormalizedDenseFrame[];
  restartFrames: NormalizedRestartFrame[];
  /** Checkpoints are normalized but not consumed by v1 playback or topology. */
  checkpoints: NormalizedCheckpoint[];
  restartAlignedToDense: boolean;
  /** File-level fact: producer-side velocity unit assumption.
   *
   *  Round 6 v1 importer behavior: ALWAYS set to 'angstrom-per-fs'. The v1
   *  wire format does not declare a velocity unit; the Å/fs convention is
   *  producer-side (see sim/integrators/velocity_verlet.py and lab/js/physics.ts).
   *
   *  The 'unknown' branch is RESERVED for a hypothetical v2 wire format that
   *  declares velocity units explicitly. Round 6 cannot produce 'unknown' — it
   *  exists only so the capability-layer gate is already wired up. */
  velocityUnit: 'angstrom-per-fs' | 'unknown';
  /** Precomputed capability layer — general (not Hermite-specific). */
  interpolationCapability: InterpolationCapability;
  /** Non-fatal import diagnostics. Surfaced by the runtime to the settings UI. */
  importDiagnostics: readonly ImportDiagnostic[];
}

// ── Conversion helpers ──

function convertBonds(bonds: { a: number; b: number; distance: number }[]): [number, number, number][] {
  return bonds.map(b => [b.a, b.b, b.distance]);
}

function atomIdsEqual(a: number[], b: number[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Scan one restart frame's velocity array for any component magnitude above
 *  the implausible-Å/fs threshold. Returns true if flagged. */
function frameVelocitiesImplausible(velocities: Float64Array): boolean {
  for (let i = 0; i < velocities.length; i++) {
    const v = velocities[i];
    if (Math.abs(v) > IMPLAUSIBLE_VELOCITY_A_PER_FS) return true;
  }
  return false;
}

// ── Capability computation ──

function computeInterpolationCapability(
  denseFrames: NormalizedDenseFrame[],
  restartFrames: NormalizedRestartFrame[],
  restartAlignedToDense: boolean,
  velocityUnit: 'angstrom-per-fs' | 'unknown',
  diagnosticsOut: ImportDiagnostic[],
): InterpolationCapability {
  const n = denseFrames.length;
  const denseToRestartIndex = new Int32Array(n);
  const velocityReason: VelocityEndpointReason[] = new Array(n);
  const bracketSafe = new Uint8Array(n);
  const bracketReason: BracketReason[] = new Array(n);
  const hermiteSafe = new Uint8Array(n);
  const window4Safe = new Uint8Array(n);
  const window4Reason: WindowReason[] = new Array(n);

  // ── 1. Velocity endpoint reasons ──
  // When file-level gates fail, every frame gets the same reason — intentional
  // denormalization so hot-path strategy gating always reads a per-frame flag.
  const fileLevelVelocityFail =
    !restartAlignedToDense || velocityUnit === 'unknown';

  // Track which frames had implausible velocity magnitudes (reported once in diagnostics).
  let implausibleEmitted = false;

  for (let i = 0; i < n; i++) {
    if (fileLevelVelocityFail) {
      velocityReason[i] = 'restart-misaligned';
      denseToRestartIndex[i] = -1;
      continue;
    }
    const dense = denseFrames[i];
    const restart = restartFrames[i]; // safe: restartAlignedToDense guarantees parity
    if (dense.n !== restart.n) {
      velocityReason[i] = 'restart-n-mismatch';
      denseToRestartIndex[i] = -1;
      continue;
    }
    if (!atomIdsEqual(dense.atomIds, restart.atomIds)) {
      velocityReason[i] = 'atomids-mismatch';
      denseToRestartIndex[i] = -1;
      diagnosticsOut.push({
        severity: 'info',
        code: 'atomids-mismatch-at-frame',
        message: `Dense/restart atomIds diverge at frame ${i}.`,
        frameIndex: i,
      });
      continue;
    }
    if (frameVelocitiesImplausible(restart.velocities)) {
      velocityReason[i] = 'velocities-implausible';
      denseToRestartIndex[i] = -1;
      if (!implausibleEmitted) {
        diagnosticsOut.push({
          severity: 'warn',
          code: 'velocities-implausible',
          message: 'Velocities exceed the physically plausible Å/fs range. Hermite will fall back to linear for affected frames.',
          frameIndex: i,
        });
        implausibleEmitted = true;
      }
      continue;
    }
    velocityReason[i] = 'ok';
    denseToRestartIndex[i] = i;
  }

  // ── 2. Bracket reasons (for each i, describing the (i, i+1) bracket) ──
  for (let i = 0; i < n; i++) {
    if (i === n - 1) {
      bracketReason[i] = 'last-frame';
      bracketSafe[i] = 0;
      continue;
    }
    const a = denseFrames[i];
    const b = denseFrames[i + 1];
    if (a.n !== b.n) {
      bracketReason[i] = 'bracket-n-mismatch';
      bracketSafe[i] = 0;
      continue;
    }
    if (!atomIdsEqual(a.atomIds, b.atomIds)) {
      bracketReason[i] = 'bracket-atomids-mismatch';
      bracketSafe[i] = 0;
      continue;
    }
    bracketReason[i] = 'ok';
    bracketSafe[i] = 1;
  }

  // ── 3. Hermite bracket flag (derived) ──
  // bracketSafe[i] === 1 already implies i < n-1 (the bracket loop sets
  // bracketSafe[n-1] = 0), so the i+1 < n guard is unnecessary.
  for (let i = 0; i < n; i++) {
    hermiteSafe[i] =
      bracketSafe[i] === 1 &&
      velocityReason[i] === 'ok' &&
      velocityReason[i + 1] === 'ok'
        ? 1
        : 0;
  }

  // ── 4. 4-frame window reasons ──
  for (let i = 0; i < n; i++) {
    if (i === 0 || i >= n - 2) {
      window4Reason[i] = 'timeline-edge';
      window4Safe[i] = 0;
      continue;
    }
    const f0 = denseFrames[i - 1];
    const f1 = denseFrames[i];
    const f2 = denseFrames[i + 1];
    const f3 = denseFrames[i + 2];
    if (f0.n !== f1.n || f1.n !== f2.n || f2.n !== f3.n) {
      window4Reason[i] = 'window-n-mismatch';
      window4Safe[i] = 0;
      continue;
    }
    if (
      !atomIdsEqual(f0.atomIds, f1.atomIds) ||
      !atomIdsEqual(f1.atomIds, f2.atomIds) ||
      !atomIdsEqual(f2.atomIds, f3.atomIds)
    ) {
      window4Reason[i] = 'window-atomids-mismatch';
      window4Safe[i] = 0;
      continue;
    }
    window4Reason[i] = 'ok';
    window4Safe[i] = 1;
  }

  return {
    denseToRestartIndex,
    velocityReason,
    bracketSafe,
    bracketReason,
    hermiteSafe,
    window4Safe,
    window4Reason,
  };
}

// ── Importer ──

export function importFullHistory(file: AtomDojoHistoryFileV1): LoadedFullHistory {
  const { simulation, atoms, timeline } = file;

  const denseFrames: NormalizedDenseFrame[] = timeline.denseFrames.map(f => ({
    frameId: f.frameId,
    timePs: f.timePs,
    n: f.n,
    atomIds: f.atomIds,
    positions: new Float64Array(f.positions),
    interaction: f.interaction,
    boundary: f.boundary,
  }));

  const restartFrames: NormalizedRestartFrame[] = timeline.restartFrames.map(f => ({
    frameId: f.frameId,
    timePs: f.timePs,
    n: f.n,
    atomIds: f.atomIds,
    positions: new Float64Array(f.positions),
    velocities: new Float64Array(f.velocities),
    bonds: convertBonds(f.bonds),
    config: f.config,
    interaction: f.interaction,
    boundary: f.boundary,
  }));

  const checkpoints: NormalizedCheckpoint[] = timeline.checkpoints.map(cp => ({
    checkpointId: cp.checkpointId,
    timePs: cp.timePs,
    physics: {
      n: cp.physics.n,
      atomIds: cp.physics.atomIds,
      positions: new Float64Array(cp.physics.positions),
      velocities: new Float64Array(cp.physics.velocities),
      bonds: convertBonds(cp.physics.bonds),
    },
    config: cp.config,
    interaction: cp.interaction,
    boundary: cp.boundary,
  }));

  // Precompute alignment flag + record file-level diagnostics
  const importDiagnostics: ImportDiagnostic[] = [];
  let restartAlignedToDense = restartFrames.length === denseFrames.length;
  if (restartFrames.length !== denseFrames.length) {
    importDiagnostics.push({
      severity: 'info',
      code: 'restart-count-mismatch',
      message: `Restart frame count (${restartFrames.length}) does not match dense frame count (${denseFrames.length}); Hermite disabled for this file.`,
    });
  } else {
    for (let i = 0; i < denseFrames.length; i++) {
      if (restartFrames[i].timePs !== denseFrames[i].timePs) {
        restartAlignedToDense = false;
        importDiagnostics.push({
          severity: 'info',
          code: 'restart-time-mismatch',
          message: `Restart frame ${i} time (${restartFrames[i].timePs}) does not match dense frame time (${denseFrames[i].timePs}); Hermite disabled for this file.`,
          frameIndex: i,
        });
        break;
      }
    }
  }

  // v1 wire format: velocities are Å/fs by producer convention.
  const velocityUnit: 'angstrom-per-fs' | 'unknown' = 'angstrom-per-fs';

  const interpolationCapability = computeInterpolationCapability(
    denseFrames,
    restartFrames,
    restartAlignedToDense,
    velocityUnit,
    importDiagnostics,
  );

  return {
    kind: 'full',
    simulation,
    atoms: atoms.atoms,
    denseFrames,
    restartFrames,
    checkpoints,
    restartAlignedToDense,
    velocityUnit,
    interpolationCapability,
    importDiagnostics,
  };
}
