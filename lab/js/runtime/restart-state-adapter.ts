/**
 * Restart state adapter — owns serialization, capture, and application
 * of RestartState across the timeline subsystem.
 *
 * Owns: serializeForWorkerRestore, applyRestartState, captureRestartFrameData —
 *       the three restart-state translation surfaces.
 * Depends on: PhysicsEngine (pos/vel/bonds/boundary read + restoreCheckpoint),
 *             simulation-timeline types (RestartState, TimelinePhysicsConfig),
 *             timeline-context-capture (interaction + boundary snapshot capture).
 * Called by: simulation-timeline-coordinator.ts (capture + restore), worker-lifecycle.ts (serialize).
 * Teardown: stateless functions — no teardown needed.
 *
 * Restart restores physical state (pos, vel, bonds, boundary, config)
 * but NOT active interaction (drag/move/rotate). Restoring interaction
 * without matching pointer input creates ghost spring forces.
 */

import type { PhysicsEngine } from '../physics';
import type { RestartState, TimelinePhysicsConfig } from './simulation-timeline';
import type { PhysicsConfig, WorkerCommand } from '../../../src/types/worker-protocol';
import type { AtomXYZ } from '../../../src/types/domain';
import type { BondTuple } from '../../../src/types/interfaces';
import { captureInteractionState, captureBoundaryState, type TimelineInteractionState, type TimelineBoundaryState } from './timeline-context-capture';

function cloneBondTuple(b: BondTuple): BondTuple {
  return [b[0], b[1], b[2]];
}

// ── Worker restore payload ──

export interface WorkerRestorePayload {
  config: PhysicsConfig;
  atoms: AtomXYZ[];
  bonds: BondTuple[];
  velocities: Float64Array;
  boundary: Extract<WorkerCommand, { type: 'restoreState' }>['boundary'];
}

/** Serialize current physics state into a worker-restore payload.
 *  Does NOT include interaction — restart clears drag to prevent ghost forces. */
export function serializeForWorkerRestore(
  physics: PhysicsEngine,
  buildConfig: () => PhysicsConfig,
): WorkerRestorePayload {
  const atoms: AtomXYZ[] = [];
  for (let i = 0; i < physics.n; i++) {
    const i3 = i * 3;
    atoms.push({ x: physics.pos[i3], y: physics.pos[i3 + 1], z: physics.pos[i3 + 2] });
  }
  return {
    config: buildConfig(),
    atoms,
    bonds: physics.getBonds().map(cloneBondTuple),
    velocities: new Float64Array(physics.vel.subarray(0, physics.n * 3)),
    boundary: physics.getBoundarySnapshot(),
  };
}

// ── Main-thread restore ──

/** Apply a RestartState to the physics engine (main-thread restore).
 *  Restores physical state and config. Clears any lingering drag. */
export function applyRestartState(physics: PhysicsEngine, rs: RestartState): void {
  physics.restoreCheckpoint({
    n: rs.n,
    pos: new Float64Array(rs.positions),
    vel: new Float64Array(rs.velocities),
    bonds: rs.bonds.map(cloneBondTuple),
  });
  physics.restoreBoundarySnapshot(rs.boundary);
  physics.setDamping(rs.config.damping);
  physics.setDragStrength(rs.config.kDrag);
  physics.setRotateStrength(rs.config.kRotate);
  if (physics.dragAtom >= 0) physics.endDrag();
}

// ── Restart-frame capture ──

/** Data needed for a restart frame — captured from current reconciled physics. */
export interface RestartFrameData {
  n: number;
  positions: Float64Array;
  velocities: Float64Array;
  bonds: BondTuple[];
  config: TimelinePhysicsConfig;
  interaction: TimelineInteractionState;
  boundary: TimelineBoundaryState;
}

/** Capture restart-frame data from current reconciled physics state.
 *  Always reads from physics.pos/vel (post-reconciliation single authority). */
export function captureRestartFrameData(physics: PhysicsEngine): RestartFrameData {
  return {
    n: physics.n,
    positions: physics.pos.subarray(0, physics.n * 3),
    velocities: physics.vel.subarray(0, physics.n * 3),
    bonds: physics.getBonds().map(cloneBondTuple),
    config: {
      damping: physics.getDamping(),
      kDrag: physics.getDragStrength(),
      kRotate: physics.getRotateStrength(),
      dtFs: physics.getDtFs(),
      dampingRefDurationFs: physics.dampingRefDurationFs,
    },
    interaction: captureInteractionState(physics),
    boundary: captureBoundaryState(physics),
  };
}
