/**
 * Scene runtime — owns scene mutation wrappers and scene-to-UI projection.
 *
 * Owns: molecule commit/clear/add wrappers, scene-to-store projection
 *       (metadata, active/removed counts, chooser recent row), worker scene
 *       mirroring (append, clear, wall center sync), placement coachmark policy,
 *       worker config building, and scene serialization.
 * Depends on: scene.ts (commitMolecule, clearPlayground, addMoleculeToScene),
 *             loader (loadStructure), app-store, focus-runtime, coachmarks,
 *             PhysicsEngine, Renderer, StateMachine, PlacementController,
 *             WorkerRuntime, InputBindings, SnapshotReconciler.
 * Called by: main.ts composition root, ui-bindings.ts (commit/clear actions),
 *           placement callbacks.
 * Teardown: no persistent resources — stateless wrappers over injected deps.
 *
 * Does NOT own the frame loop, scheduler, or interaction dispatch.
 * Does NOT attach global listeners or write to window.
 */

import { CONFIG } from '../config';
import { commitMolecule, clearPlayground, addMoleculeToScene } from '../scene';
import { loadStructure } from '../loader';
import { useAppStore } from '../store/app-store';
// focusNewestPlacedMolecule intentionally NOT imported — placement commit
// does not change focus metadata or camera pivot (Policy A: placement framing
// is about visibility, not about changing what Center/Follow mean).
import { COACHMARKS } from '../ui/coachmarks';
import type { PhysicsEngine } from '../physics';
import type { Renderer } from '../renderer';
import type { StateMachine } from '../state-machine';
import type { PlacementController } from '../placement';
import type { WorkerRuntime } from './worker-lifecycle';
import type { InputBindings } from './input-bindings';
import type { SnapshotReconciler } from './snapshot-reconciler';

export interface SceneRuntime {
  setDockPlacementMode(active: boolean): void;
  updateChooserRecentRow(): void;
  updateSceneStatus(): void;
  updateActiveCountRow(): void;
  commitMolecule(filename: string, name: string, atoms: any[], bonds: any[], offset: number[]): void | Promise<void>;
  clearPlayground(): void | Promise<void>;
  addMoleculeToScene(filename: string, name: string, offset: number[]): Promise<void>;
  updateStatus(text: string): void;
  collectSceneAtoms(): import('../../../src/types/domain').AtomXYZ[];
  collectSceneBonds(): import('../../../src/types/interfaces').BondTuple[];
}

export interface SceneRuntimeDeps {
  getPhysics: () => PhysicsEngine;
  getRenderer: () => Renderer;
  getStateMachine: () => StateMachine;
  getPlacement: () => PlacementController | null;
  getStatusCtrl: () => { showCoachmark: (c: { id: string; text: string }) => void; hideCoachmark: (id: string) => void } | null;
  getWorkerRuntime: () => WorkerRuntime | null;
  getInputBindings: () => InputBindings | null;
  getSnapshotReconciler: () => SnapshotReconciler | null;
  getSession: () => {
    theme: string;
    textSize: string;
    isLoading: boolean;
    interactionMode: string;
    playback: { selectedSpeed: number; speedMode: string; effectiveSpeed: number; maxSpeed: number; paused: boolean };
    scene: { molecules: any[]; nextId: number; totalAtoms: number };
  };
  dispatch: (cmd: import('../state-machine').Command) => void;
  fullSchedulerReset: () => void;
  partialProfilerReset: () => void;
  recoverFromWorkerFailure: (reason: string, lastSnapshot?: import('./worker-lifecycle').RecoverySnapshot) => void;
  getPauseSyncPromise?: () => Promise<void> | null;
  onSceneMutated?: () => void;
}

export function createSceneRuntime(deps: SceneRuntimeDeps): SceneRuntime {
  function getSession() { return deps.getSession(); }

  /** Shared gate: awaits any in-flight pause sync before allowing paused mutations.
   *  All scene mutations that touch physics during pause should call this first. */
  async function awaitPauseSyncIfNeeded() {
    const pauseSync = deps.getPauseSyncPromise?.();
    if (pauseSync) await pauseSync;
  }

  /** Shared post-commit renderer sync. Every successful scene commit (initial
   *  load or placement) must call this so atoms AND bonds are visible.
   *  Does NOT retarget camera or change focus metadata — placement framing
   *  handles visibility; Center/Follow handle explicit focus. */
  function finalizeCommittedScene() {
    const physics = deps.getPhysics();
    const renderer = deps.getRenderer();
    renderer.setPhysicsRef(physics);
    renderer.updateSceneRadius();
    renderer.recomputeFocusDistance();
    renderer.updatePositions(physics);
  }

  return {
    setDockPlacementMode(active: boolean) {
      useAppStore.getState().setPlacementActive(active);
      if (active) {
        const sc = deps.getStatusCtrl();
        if (sc) sc.showCoachmark(COACHMARKS.placement);
      } else {
        const sc = deps.getStatusCtrl();
        if (sc) sc.hideCoachmark('placement');
      }
    },

    updateChooserRecentRow() {
      const p = deps.getPlacement();
      if (p && p.hasLastStructure()) {
        useAppStore.getState().setRecentStructure({
          file: p.getLastStructureFile(),
          name: p.getLastStructureName(),
        });
      } else {
        useAppStore.getState().setRecentStructure(null);
      }
    },

    updateSceneStatus() {
      const session = getSession();
      const store = useAppStore.getState();
      store.updateAtomCount(session.scene.totalAtoms);
      store.setMolecules(session.scene.molecules.map(m => ({
        id: m.id, name: m.name, structureFile: m.structureFile,
        atomCount: m.atomCount, atomOffset: m.atomOffset,
      })));
      this.updateActiveCountRow();
      const p = deps.getPlacement();
      if (!p || !p.loading) {
        store.setStatusText(null);
      }
    },

    updateActiveCountRow() {
      const physics = deps.getPhysics();
      const wr = deps.getWorkerRuntime();
      const session = getSession();
      let active: number, removed: number;
      if (wr && wr.isActive()) {
        active = physics.n;
        removed = Math.max(0, session.scene.totalAtoms - active);
      } else {
        active = physics.getActiveAtomCount();
        removed = physics.getWallRemovedCount();
      }
      useAppStore.getState().updateActiveCount(active, removed);
    },

    async commitMolecule(filename, name, atoms, bonds, offset) {
      await awaitPauseSyncIfNeeded();

      const physics = deps.getPhysics();
      const renderer = deps.getRenderer();
      const session = getSession();

      // Worker velocity authority: if worker mode is active and paused,
      // await an authoritative pos+vel sync from the worker BEFORE local append.
      // This guarantees physics.vel has the worker's true momentum, not stale
      // main-thread state. Without this, COM velocity is lost on resume.
      const wrGuard = deps.getWorkerRuntime();
      if (wrGuard && wrGuard.isActive() && session.playback.paused) {
        try {
          await wrGuard.syncStateNow();
        } catch (_e) {
          // Worker sync failed/timed out — reject so PlacementController sees failure
          console.warn('[scene-runtime] paused placement cancelled: worker sync unavailable');
          useAppStore.getState().setStatusText('Placement cancelled: worker sync unavailable');
          setTimeout(() => {
            if (useAppStore.getState().statusText === 'Placement cancelled: worker sync unavailable') {
              useAppStore.getState().setStatusText(null);
            }
          }, 3000);
          throw new Error('Placement cancelled: worker sync unavailable');
        }
        // Apply the fresh snapshot to local physics
        const snap = wrGuard.getLatestSnapshot();
        if (snap && snap.n === physics.n) {
          if (physics.pos) {
            const len = Math.min(snap.positions.length, physics.pos.length);
            physics.pos.set(snap.positions.subarray(0, len));
          }
          if (snap.velocities && physics.vel) {
            const len = Math.min(snap.velocities.length, physics.vel.length);
            physics.vel.set(snap.velocities.subarray(0, len));
          }
        }
      }

      commitMolecule(physics as any, renderer as any, filename, name, atoms, bonds, offset, session.scene, {
        syncInput: () => { const ib = deps.getInputBindings(); if (ib) ib.sync(); },
        resetProfiler: deps.partialProfilerReset,
        fitCamera: () => renderer.fitCamera(),
        updateSceneStatus: () => this.updateSceneStatus(),
      });
      finalizeCommittedScene();

      const wr = deps.getWorkerRuntime();
      if (wr && wr.isActive()) {
        wr.appendMolecule(atoms as any, bonds as any, offset as [number, number, number]).then((result) => {
          if (!result.ok) {
            // Worker append failed — scene divergence is unrecoverable.
            // Tear down worker mode completely and fall back to local sync.
            console.warn('[scene-runtime] worker append failed — tearing down worker, falling back to sync mode');
            wr.destroy();
            deps.recoverFromWorkerFailure('worker append failed');
            return;
          }
          wr.sendInteraction({
            type: 'updateWallCenter',
            atoms: (atoms as any[]).map((a: any) => ({ x: a.x, y: a.y, z: a.z })),
            offset: offset as [number, number, number],
          });
        });
      }
      deps.onSceneMutated?.();
    },

    async clearPlayground() {
      await awaitPauseSyncIfNeeded();
      const physics = deps.getPhysics();
      const renderer = deps.getRenderer();
      const sm = deps.getStateMachine();
      const session = getSession();
      clearPlayground(physics as any, renderer as any, sm, session.scene, {
        invalidatePlacement: () => { const p = deps.getPlacement(); if (p) p.invalidatePendingLoads(); },
        exitPlacement: () => { const p = deps.getPlacement(); if (p) p.exit(false); },
        forceIdle: () => deps.dispatch(sm.forceIdle()),
        syncInput: () => { const ib = deps.getInputBindings(); if (ib) ib.sync(); },
        resetScheduler: deps.fullSchedulerReset,
        updateSceneStatus: () => this.updateSceneStatus(),
      });

      useAppStore.getState().resetDiagnostics();
      useAppStore.getState().setLastFocusedMoleculeId(null);

      // Reset camera scene state (scene cleared → default distance, default radius)
      renderer.resetFocusDistance();
      renderer.updateSceneRadius();
      const sr = deps.getSnapshotReconciler();
      if (sr) sr.reset();

      const wr = deps.getWorkerRuntime();
      if (wr && wr.isActive()) {
        wr.bumpGeneration();
        wr.clearScene();
      }
      deps.onSceneMutated?.();
    },

    async addMoleculeToScene(filename, name, offset) {
      const physics = deps.getPhysics();
      const renderer = deps.getRenderer();
      const session = getSession();
      const committed = await addMoleculeToScene(filename, name, offset, {
        loadStructure, physics: physics as any, renderer: renderer as any,
        sceneState: session.scene,
        commitCallbacks: {
          syncInput: () => { const ib = deps.getInputBindings(); if (ib) ib.sync(); },
          resetProfiler: deps.partialProfilerReset,
          fitCamera: () => renderer.fitCamera(),
          updateSceneStatus: () => this.updateSceneStatus(),
        },
        updateStatus: (text) => this.updateStatus(text),
        setLoading: (v) => { deps.getSession().isLoading = v; },
      });
      if (committed) finalizeCommittedScene();
    },

    updateStatus(text: string) {
      useAppStore.getState().setStatusText(text === '' ? null : text);
    },

    collectSceneAtoms() {
      const atoms: import('../../../src/types/domain').AtomXYZ[] = [];
      for (const mol of getSession().scene.molecules) atoms.push(...mol.localAtoms);
      return atoms;
    },

    collectSceneBonds() {
      const bonds: import('../../../src/types/interfaces').BondTuple[] = [];
      let atomOffset = 0;
      for (const mol of getSession().scene.molecules) {
        for (const b of mol.localBonds) bonds.push([b[0] + atomOffset, b[1] + atomOffset, b[2]]);
        atomOffset += mol.atomCount;
      }
      return bonds;
    },

  };
}
