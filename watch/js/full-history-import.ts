/**
 * Full history importer — normalizes v1 file data into playback-ready model.
 *
 * Conversions performed:
 *   - number[] → Float64Array for positions/velocities
 *   - { a, b, distance } → [a, b, distance] for bonds
 *   - Precomputes restartAlignedToDense flag
 *
 * All frame types (dense, restart, checkpoint) are normalized consistently.
 * Checkpoints are normalized but not consumed by v1 playback.
 */

import type { AtomDojoHistoryFileV1, AtomInfoV1, SimulationMetaV1, PhysicsConfigV1 } from '../../src/history/history-file-v1';

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

export interface LoadedFullHistory {
  kind: 'full';
  simulation: SimulationMetaV1;
  atoms: AtomInfoV1[];
  denseFrames: NormalizedDenseFrame[];
  restartFrames: NormalizedRestartFrame[];
  /** Checkpoints are normalized but not consumed by v1 playback or topology. */
  checkpoints: NormalizedCheckpoint[];
  restartAlignedToDense: boolean;
}

// ── Conversion helpers ──

function convertBonds(bonds: { a: number; b: number; distance: number }[]): [number, number, number][] {
  return bonds.map(b => [b.a, b.b, b.distance]);
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

  // Precompute alignment flag
  let restartAlignedToDense = restartFrames.length === denseFrames.length;
  if (restartAlignedToDense) {
    for (let i = 0; i < denseFrames.length; i++) {
      if (restartFrames[i].timePs !== denseFrames[i].timePs) {
        restartAlignedToDense = false;
        break;
      }
    }
  }

  return {
    kind: 'full',
    simulation,
    atoms: atoms.atoms,
    denseFrames,
    restartFrames,
    checkpoints,
    restartAlignedToDense,
  };
}
