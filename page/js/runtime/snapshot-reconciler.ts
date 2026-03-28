/**
 * Worker snapshot reconciler — runtime coordination helper.
 *
 * This is NOT a render utility. It owns the full worker-to-main
 * reconciliation contract, including side effects that go beyond rendering:
 * - Position sync from snapshot to physics.pos
 * - Atom-count mismatch detection (wall removal in worker)
 * - Renderer atom-count update and physics-ref rebinding
 * - Active interaction invalidation on atom remap
 * - Periodic bond refresh (counter owned internally)
 * - Renderer updateFromSnapshot() call
 *
 * Does NOT attach global listeners or write to window.
 */

import type { PhysicsEngine } from '../physics';
import type { Renderer } from '../renderer';
import type { StateMachine, Command } from '../state-machine';

export interface SnapshotReconciler {
  /** Apply a worker snapshot. Returns whether atom count changed (wall removal). */
  apply(snapshot: { positions: Float64Array; velocities?: Float64Array; n: number }): { atomCountChanged: boolean };
  /** Reset internal counter state (e.g., on scene clear). */
  reset(): void;
}

export function createSnapshotReconciler(deps: {
  physics: PhysicsEngine;
  renderer: Renderer;
  stateMachine: StateMachine;
  dispatch: (cmd: Command) => void;
}): SnapshotReconciler {
  let _bondRefreshCounter = 0;

  return {
    apply(snapshot) {
      const { physics, renderer, stateMachine, dispatch } = deps;
      let atomCountChanged = false;

      // Keep physics.n in sync with worker
      physics.n = snapshot.n;

      // Wall removal sync: worker returned fewer atoms than renderer expects
      if (snapshot.n !== renderer.getAtomCount()) {
        atomCountChanged = true;
        renderer.setAtomCount(snapshot.n);
        if (physics.pos) {
          const len = Math.min(snapshot.positions.length, physics.pos.length);
          physics.pos.set(snapshot.positions.subarray(0, len));
        }
        renderer.setPhysicsRef(physics);
        physics.updateBondList();
        // Invalidate active drag — atom indices changed after wall removal
        if (stateMachine.isInteracting()) {
          const cmd = stateMachine.forceIdle();
          if (cmd) dispatch(cmd);
        }
      }

      // Canonical position sync from snapshot
      if (physics.pos) {
        const syncLen = Math.min(snapshot.positions.length, physics.pos.length);
        physics.pos.set(snapshot.positions.subarray(0, syncLen));
      }

      // Velocity sync from snapshot (fixes momentum-loss on paused placement)
      if (snapshot.velocities && physics.vel) {
        const velLen = Math.min(snapshot.velocities.length, physics.vel.length);
        physics.vel.set(snapshot.velocities.subarray(0, velLen));
      }

      // Periodic bond refresh — every 20 frames
      _bondRefreshCounter++;
      if (_bondRefreshCounter >= 20) {
        _bondRefreshCounter = 0;
        physics.updateBondList();
      }

      // Renderer update
      renderer.updateFromSnapshot(snapshot.positions, snapshot.n);

      return { atomCountChanged };
    },

    reset() {
      _bondRefreshCounter = 0;
    },
  };
}
