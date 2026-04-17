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
import type { AtomMetadataRegistry } from './atom-metadata-registry';
import type { TimelineAtomIdentityTracker } from './timeline-atom-identity';
import {
  hydrateFromWatchSeed as hydrateTransaction,
  type HydrateResult,
  type HydrateFailureReason,
} from './hydrate-from-watch-seed';
import type {
  WatchLabSceneSeed,
  WatchToLabHandoffPayload,
} from '../../../src/watch-lab-handoff/watch-lab-handoff-shared';

export interface SceneRuntime {
  setDockPlacementMode(active: boolean): void;
  updateChooserRecentRow(): void;
  updateSceneStatus(): void;
  updateActiveCountRow(): void;
  commitMolecule(filename: string, name: string, atoms: import('../placement').StructureAtom[], bonds: import('../../../src/types/interfaces').BondTuple[], offset: number[]): void | Promise<void>;
  clearPlayground(): void | Promise<void>;
  addMoleculeToScene(filename: string, name: string, offset: number[]): Promise<void>;
  updateStatus(text: string): void;
  collectSceneAtoms(): import('../../../src/types/domain').AtomXYZ[];
  collectSceneBonds(): import('../../../src/types/interfaces').BondTuple[];
  /**
   * Hydrate the scene from a Watch-produced seed (plan §7.1). The
   * SceneRuntime is the production entry point — it wraps the
   * standalone transactional module with live physics / renderer /
   * worker / registry / tracker / session-scene bindings, then
   * translates `HydrateResult.reason` values into the
   * Watch-and-Lab-shared status-error surface so failures are visible
   * to users rather than console-only. Callers (today: Lab boot
   * consume) simply `await` and branch on `.status`.
   */
  hydrateFromWatchSeed(
    seed: WatchLabSceneSeed,
    sourceMeta: WatchToLabHandoffPayload['sourceMeta'],
  ): Promise<HydrateResult>;
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
  /** Accessors the Watch → Lab hydrate path needs. Deferred getters
   *  (not direct references) so main.ts can wire them after the
   *  timeline subsystem — the authoritative owner of both objects —
   *  is constructed. Returns null pre-wire-up; the wrapper fails
   *  closed in that case. */
  getAtomIdentityTracker?: () => TimelineAtomIdentityTracker | null;
  getAtomMetadataRegistry?: () => AtomMetadataRegistry | null;
  dispatch: (cmd: import('../state-machine').Command) => void;
  fullSchedulerReset: () => void;
  partialProfilerReset: () => void;
  recoverFromWorkerFailure: (reason: string, lastSnapshot?: import('./worker-lifecycle').RecoverySnapshot) => void;
  getPauseSyncPromise?: () => Promise<void> | null;
  /** Hydration-lock setter — main.ts owns the flag that the rAF frame
   *  loop reads via `FrameRuntimeSurface.isHydrating()`. The scene-
   *  runtime's `hydrateFromWatchSeed` passes this through to the
   *  transactional module so stale worker snapshots can't clobber
   *  physics during the async commit. Null when the host environment
   *  has no frame loop (tests that mock worker as inactive). */
  setHydrationActive?: (active: boolean) => void;
  onSceneMutated?: () => void;
  /** Called after successful molecule commit with append metadata + structure atoms. */
  onMoleculeCommitted?: (info: { atomOffset: number; atomCount: number; atoms: { element: string }[]; filename: string; name: string }) => void;
}

/** User-facing copy for each classified `HydrateResult.reason`. The
 *  SceneRuntime wrapper surfaces these via `useAppStore.setStatusError`
 *  so the Lab StatusBar live-region (rev 6 Ax11) announces them to
 *  screen readers alongside the visual surface. Keep copy short + free
 *  of internal jargon; users who see these messages cannot do anything
 *  about the underlying cause except retry or fall back. */
const HYDRATE_FAILURE_COPY: Record<HydrateFailureReason, string> = {
  'worker-restore-rejected':
    'Couldn\u2019t load that scene into Lab\u2019s simulation worker. Open Lab normally and try again.',
  'physics-commit-threw':
    'Couldn\u2019t apply that scene to Lab\u2019s physics engine. Open Lab normally and try again.',
  'renderer-stage-threw':
    'Lab\u2019s visual layer couldn\u2019t initialize that scene. Open Lab normally and try again.',
  'registry-register-threw':
    'Couldn\u2019t register that scene\u2019s atoms with Lab. Open Lab normally and try again.',
  'rollback-also-failed':
    'Something went wrong loading that scene and Lab couldn\u2019t recover. Please reload the page.',
  'runtime-not-ready':
    'Lab can\u2019t apply a Watch scene right now — internal subsystems aren\u2019t ready. Please reload the page.',
};

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

      const commitResult = commitMolecule(physics as any, renderer as any, filename, name, atoms, bonds, offset, session.scene, {
        syncInput: () => { const ib = deps.getInputBindings(); if (ib) ib.sync(); },
        resetProfiler: deps.partialProfilerReset,
        fitCamera: () => renderer.fitCamera(),
        updateSceneStatus: () => this.updateSceneStatus(),
      });
      // Notify identity tracker/metadata registry of the append
      if (deps.onMoleculeCommitted) {
        deps.onMoleculeCommitted({
          atomOffset: commitResult.atomOffset,
          atomCount: commitResult.atomCount,
          atoms: atoms.map(a => ({ element: a.element })),
          filename, name,
        });
      }
      finalizeCommittedScene();

      const wr = deps.getWorkerRuntime();
      if (wr && wr.isActive()) {
        // Await the worker ack before returning. Fire-and-forget
        // `.then(...)` left the `commitMolecule` promise resolved
        // before the worker had committed, and an unswallowed
        // rejection would escape as `unhandledrejection`. Treat
        // `{ok: false}` identically to a throw: tear down worker
        // mode, surface a user-visible error, and let the
        // recovery path take over — same contract as before, but
        // synchronous with the caller's await chain. `sendInteraction`
        // only fires on successful append so we never post
        // `updateWallCenter` against a torn-down worker.
        let ok = false;
        try {
          const result = await wr.appendMolecule(atoms as any, bonds as any, offset as [number, number, number]);
          ok = result.ok;
        } catch (err) {
          console.warn('[scene-runtime] worker append threw — tearing down worker, falling back to sync mode:', err);
          ok = false;
        }
        if (!ok) {
          console.warn('[scene-runtime] worker append failed — tearing down worker, falling back to sync mode');
          wr.destroy();
          deps.recoverFromWorkerFailure('worker append failed');
          useAppStore.getState().setStatusError(
            'Simulation worker is unavailable. Running locally — performance may be reduced.',
          );
        } else {
          wr.sendInteraction({
            type: 'updateWallCenter',
            atoms: (atoms as any[]).map((a: any) => ({ x: a.x, y: a.y, z: a.z })),
            offset: offset as [number, number, number],
          });
        }
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

    async hydrateFromWatchSeed(seed, sourceMeta) {
      // Bind live deps into the standalone transaction. Missing
      // registry / tracker (main.ts not wired yet, or a test harness)
      // fails closed with a classified result so the caller can
      // surface the same error-banner path as genuine transaction
      // failures.
      const registry = deps.getAtomMetadataRegistry?.() ?? null;
      const tracker = deps.getAtomIdentityTracker?.() ?? null;
      if (!registry || !tracker) {
        // Adapter-layer failure: the timeline subsystem is the canonical
        // owner of the tracker + registry, and it's installed later in
        // boot than scene-runtime creation. If we get here, the caller
        // invoked `hydrateFromWatchSeed` before that wire-up — a
        // boot-order bug, not a physics bug. Route through the dedicated
        // `runtime-not-ready` reason so diagnostics stay honest.
        useAppStore.getState().setStatusError(HYDRATE_FAILURE_COPY['runtime-not-ready']);
        return { status: 'error', reason: 'runtime-not-ready' };
      }
      const physics = deps.getPhysics();
      const renderer = deps.getRenderer();
      const workerRuntime = deps.getWorkerRuntime();

      // Await any in-flight pause sync before mutating physics (same
      // contract as commit/clear paths above).
      await awaitPauseSyncIfNeeded();

      const result = await hydrateTransaction(seed, sourceMeta, {
        physics,
        renderer,
        worker: workerRuntime
          ? {
              isActive: () => workerRuntime.isActive(),
              clearScene: () => workerRuntime.clearScene(),
              appendMolecule: (atoms, bonds, offset) =>
                workerRuntime.appendMolecule(atoms, bonds, offset),
            }
          : null,
        sceneState: getSession().scene as unknown as import('../scene').SceneState,
        registry,
        tracker,
        setHydrationActive: deps.setHydrationActive,
        onHydrated: () => {
          // Reuse the existing post-commit path so bonded groups /
          // timeline / store projections all see the new scene in a
          // single pass — same mechanism `commitMolecule` uses.
          this.updateSceneStatus();
          deps.onSceneMutated?.();
          // Renderer sync (camera framing, focus distance) mirrors
          // `finalizeCommittedScene`. The hydrate module already
          // called these, but finalizeCommittedScene also runs
          // updatePositions — harmless to call twice, cheap.
          finalizeCommittedScene();
        },
      });

      if (result.status === 'error') {
        useAppStore.getState().setStatusError(
          HYDRATE_FAILURE_COPY[result.reason] ?? HYDRATE_FAILURE_COPY['rollback-also-failed'],
        );
        // Diagnostic log keeps the root cause in devtools; the error
        // banner above is what users see.
        // eslint-disable-next-line no-console
        console.warn('[lab.hydrate]', result.reason, result.cause ?? '');
      }
      return result;
    },
  };
}
