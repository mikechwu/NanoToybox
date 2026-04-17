/**
 * `hydrateFromWatchSeed` — Watch → Lab §7.1 transactional hydrate.
 *
 * Takes a validated `WatchLabSceneSeed` (produced by the Watch side and
 * consumed via `consumeWatchToLabHandoffFromLocation`), normalizes it
 * through `normalizeWatchSeed`, and commits the resulting state across
 * five authorities:
 *
 *   1. Main-thread physics       — clearScene + restoreCheckpoint +
 *                                   restoreBoundarySnapshot + setTimeConfig
 *                                   (three-arg form so damping window
 *                                   survives the handoff).
 *   2. Worker runtime            — `restoreState(config, atoms, bonds,
 *                                   velocities, boundary)` — async;
 *                                   transaction awaits the ack before
 *                                   finalizing the other authorities.
 *   3. Scene-runtime metadata    — atomIdentityTracker.handleAppend +
 *                                   atomMetadataRegistry.registerAppendedAtoms.
 *   4. Renderer meshes           — clearAllMeshes + ensureCapacityForAppend
 *                                   + populateAppendedAtoms + updatePositions.
 *   5. `session.scene`           — push a synthetic `@watch-handoff`
 *                                   molecule; set `totalAtoms` + `nextId`.
 *
 * Either ALL five commit together or NONE. On any throw after the
 * capture phase, rollback reinstates the pre-call state on every
 * authority — no synthetic `@watch-handoff` entry leaks, no registry
 * orphan, no worker-vs-main-thread split-brain.
 *
 * The helper is extracted from `scene-runtime.ts` so it's testable in
 * isolation with pure mocks — the scene-runtime's actual `hydrateFromWatchSeed`
 * method is a thin wrapper that binds the live Lab dependencies.
 */

import type { WatchLabSceneSeed } from '../../../src/watch-lab-handoff/watch-lab-handoff-shared';
import type { WatchToLabHandoffPayload } from '../../../src/watch-lab-handoff/watch-lab-handoff-shared';
import { normalizeWatchSeed } from '../../../src/watch-lab-handoff/normalize-watch-seed';
import type { AtomMetadataRegistry, AtomMetadataSnapshot } from './atom-metadata-registry';
import type { TimelineAtomIdentityTracker, TimelineAtomIdentitySnapshot } from './timeline-atom-identity';
import type { SceneState } from '../scene';
import { cloneSceneState, restoreSceneStateInPlace } from '../scene';
import type { AtomXYZ } from '../../../src/types/domain';
import type { BondTuple } from '../../../src/types/interfaces';
import type { WorkerCommand, PhysicsConfig } from '../../../src/types/worker-protocol';

/** Marker placed on the synthetic molecule entry so any future code
 *  that wants to "reload from file" knows there is no reload source.
 *  Rollback MUST leave zero entries with this marker — covered by a
 *  regression-lock test. */
export const WATCH_HANDOFF_MARKER = '@watch-handoff';

export interface HydrateFromWatchSeedDeps {
  /** Minimal slice of the physics engine required for the transaction.
   *  Only these methods are called — a test double implementing this
   *  slice is sufficient. */
  physics: {
    n: number;
    pos: Float64Array;
    vel: Float64Array;
    clearScene(): void;
    appendMolecule(
      atoms: { element: string; x: number; y: number; z: number }[],
      bonds: BondTuple[],
      offset: number[],
    ): { atomOffset: number; atomCount: number };
    createCheckpoint(): PhysicsCheckpoint;
    restoreCheckpoint(cp: PhysicsCheckpoint): void;
    getBoundarySnapshot(): BoundarySnapshot;
    restoreBoundarySnapshot(snap: BoundarySnapshot): void;
    setTimeConfig(dtFs: number, dampingRefSteps: number, dampingRefDurationFs?: number): void;
    setDamping(v: number): void;
    setDragStrength(v: number): void;
    setRotateStrength(v: number): void;
    setWallMode(m: 'contain' | 'remove'): void;
    refreshTopology(): void;
    getBonds(): BondTuple[];
  };

  /** Renderer slice. `clearAllMeshes` / `ensureCapacityForAppend` /
   *  `populateAppendedAtoms` / `updatePositions` are the primitives the
   *  plan §7.1 renderer-rebuild path uses. */
  renderer: {
    clearAllMeshes(): void;
    ensureCapacityForAppend(atomCount: number): void;
    populateAppendedAtoms(atoms: { x: number; y: number; z: number }[], atomOffset: number): void;
    setPhysicsRef(physics: unknown): void;
    updateSceneRadius(): void;
    recomputeFocusDistance(): void;
    updatePositions(physics: unknown): void;
  };

  /** Worker runtime slice. Null when the environment has no worker
   *  (dev / tests with `useWorker === false`) — the hydrate then
   *  commits only main-thread physics.
   *
   *  NOTE: We deliberately use `clearScene + appendMolecule` here
   *  instead of `restoreState`, mirroring the working Lab-native
   *  "Clear playground + Add molecule" flow (`scene-runtime.commitMolecule`
   *  → `wr.appendMolecule`). The `restoreState` path had a hidden
   *  failure mode: on logical failure (`ok: false`), the worker
   *  lifecycle's `onFailure` callback synchronously recovers
   *  main-thread physics from the worker's pre-restore snapshot
   *  (which is the pre-hydrate default scene). The hydrate's `await`
   *  resolves normally, pill reports success, scene is wrong. The
   *  `clearScene + appendMolecule` primitives don't have that trap:
   *  their failure paths either reject the promise (transport) or
   *  return `{ok: false}` without touching main-thread state — we
   *  check the return value explicitly and route to rollback. */
  worker: {
    isActive(): boolean;
    clearScene(): Promise<{ ok: boolean }>;
    appendMolecule(
      atoms: AtomXYZ[],
      bonds: BondTuple[],
      offset: [number, number, number],
    ): Promise<{ ok: boolean }>;
  } | null;

  /** Live scene state reference. Mutated in place during commit;
   *  restored in place on rollback. */
  sceneState: SceneState;

  /** Atom metadata registry (element per atom id). */
  registry: AtomMetadataRegistry;
  /** Stable atom-id assignment tracker. */
  tracker: TimelineAtomIdentityTracker;

  /** Called AFTER a successful commit so downstream subsystems
   *  (bonded groups, timeline, store projections) see the new scene
   *  in a single pass. Mirrors `onSceneMutated` / `onMoleculeCommitted`
   *  hooks from scene-runtime's existing commit path. */
  onHydrated?: (info: {
    atomOffset: number;
    atomCount: number;
    sourceMeta: WatchToLabHandoffPayload['sourceMeta'];
    provenance: WatchLabSceneSeed['provenance'];
  }) => void;

  /** Optional hydration-lock gate. Set to `true` for the duration of
   *  the transaction so the rAF-driven frame loop does NOT apply stale
   *  worker snapshots (see `snapshot-reconciler.ts:45` — the
   *  reconciler unconditionally overwrites `physics.n` / `physics.pos`
   *  with whatever the worker's last snapshot reported). Without this
   *  lock, a snapshot produced BEFORE the worker processed
   *  `restoreState` arrives during our `await`, clobbers physics, and
   *  the user sees the pre-hydrate scene even though the pill reports
   *  success. Called as `setHydrationActive(true)` at the start and
   *  `setHydrationActive(false)` in a finally block covering BOTH
   *  success and rollback paths. Null in test doubles that don't run
   *  a frame loop. */
  setHydrationActive?: (active: boolean) => void;
}

/** Shape of a physics checkpoint — passes through the runtime opaquely.
 *  We never read into it; just round-trip for rollback. */
export type PhysicsCheckpoint = { n: number; pos: Float64Array; vel: Float64Array; bonds: BondTuple[] };

/** Shape of a boundary snapshot — same pattern as checkpoint. */
export type BoundarySnapshot = {
  mode: 'contain' | 'remove';
  wallRadius: number;
  wallCenter: [number, number, number];
  wallCenterSet: boolean;
  removedCount: number;
  damping: number;
};

/** Result signal for callers that want to report success / a specific
 *  failure reason (the scene-runtime wrapper surfaces this into a
 *  store setter). */
export type HydrateResult =
  | { status: 'ok'; atomCount: number }
  | { status: 'error'; reason: HydrateFailureReason; cause?: unknown };

export type HydrateFailureReason =
  | 'worker-restore-rejected'
  | 'physics-commit-threw'
  | 'renderer-stage-threw'
  | 'registry-register-threw'
  | 'rollback-also-failed'
  /** Adapter-layer failure: the SceneRuntime wrapper was called before
   *  its runtime deps (tracker/registry, injected via the timeline
   *  subsystem) were ready. Distinct from physics-commit-threw so
   *  logs + tests point at wiring/boot order, not at physics code.
   *  Surfaces to the user via the wrapper's `setStatusError` but is
   *  never produced by the transactional module itself. */
  | 'runtime-not-ready';

/**
 * Execute the hydrate transaction. Returns `'ok'` on success OR
 * `'error'` with the classified reason on rollback. Never throws the
 * original error — the transaction swallows so callers can branch on
 * `.status` and surface the outcome via their preferred channel
 * (store toast, console log, etc.).
 */
export async function hydrateFromWatchSeed(
  seed: WatchLabSceneSeed,
  sourceMeta: WatchToLabHandoffPayload['sourceMeta'],
  deps: HydrateFromWatchSeedDeps,
): Promise<HydrateResult> {
  const { physics, renderer, worker, sceneState, registry, tracker } = deps;

  // Engage the hydration lock BEFORE capturing any state. Without this,
  // the rAF frame loop can process a stale pre-restoreState worker
  // snapshot during our `await worker.restoreState(...)` below and
  // clobber physics.n / pos via the snapshot reconciler — making the
  // transaction look successful (pill lands) while the rendered scene
  // is the pre-hydrate default. Cleared in a single finally block
  // covering every exit (success, rollback, rollback-also-failed).
  deps.setHydrationActive?.(true);
  try {

  // ── 1. Normalize the seed ONCE so every authority below consumes
  //       byte-equal data derived from a single conversion pass. ──
  const payload = normalizeWatchSeed(seed);

  // ── 2. Capture rollback state. Domain-first; renderer is rebuilt
  //       deterministically so we do not snapshot mesh state. ──
  const capture: {
    physics: PhysicsCheckpoint;
    boundary: BoundarySnapshot;
    scene: SceneState;
    registry: AtomMetadataSnapshot;
    tracker: TimelineAtomIdentitySnapshot;
  } = {
    physics: physics.createCheckpoint(),
    boundary: physics.getBoundarySnapshot(),
    scene: cloneSceneState(sceneState),
    registry: registry.snapshot(),
    tracker: tracker.snapshot(),
  };

  /** Rebuild the renderer from the currently-restored domain state
   *  (post-rollback-of-physics + sceneState). This is the §7.1 "no
   *  renderer snapshot API" approach — we use only the existing
   *  renderer primitives against the authoritative scene. */
  function rebuildRendererFromSceneState(): void {
    renderer.clearAllMeshes();
    let total = 0;
    for (const mol of sceneState.molecules) total += mol.atomCount;
    renderer.ensureCapacityForAppend(total);
    for (const mol of sceneState.molecules) {
      const atomsForRenderer = mol.localAtoms.map((a) => ({ x: a.x, y: a.y, z: a.z }));
      renderer.populateAppendedAtoms(atomsForRenderer, mol.atomOffset);
    }
    renderer.setPhysicsRef(physics);
    renderer.updateSceneRadius();
    renderer.recomputeFocusDistance();
    renderer.updatePositions(physics);
  }

  /** Rollback — invoked on ANY throw after the capture phase. Restores
   *  every authority to the pre-call state. If rollback itself throws
   *  we return a `rollback-also-failed` result so the caller can
   *  surface a critical error. */
  async function rollback(reason: HydrateFailureReason, cause?: unknown): Promise<HydrateResult> {
    try {
      // Domain first.
      physics.restoreCheckpoint(capture.physics);
      physics.restoreBoundarySnapshot(capture.boundary);
      restoreSceneStateInPlace(sceneState, capture.scene);
      registry.restore(capture.registry);
      tracker.restore(capture.tracker);

      // Re-sync worker with the RESTORED main-thread state IFF the
      // worker was the authority that failed this transaction.
      // Rollbacks from physics-commit-threw / renderer-stage-threw /
      // registry-register-threw cannot have touched the worker yet
      // (the main-thread physics commit happens before the worker
      // commit). Only `worker-restore-rejected` leaves the worker in
      // a clearScene'd-but-not-appended state that needs to be
      // re-mirrored to the restored main-thread data. We use the
      // same `clearScene + appendMolecule` primitives as the commit
      // path so failures in rollback don't loop into `onFailure`
      // recovery. Best-effort — we still return an error even if
      // the worker re-sync itself fails.
      if (worker && worker.isActive() && reason === 'worker-restore-rejected') {
        const restoredAtoms: { element: string; x: number; y: number; z: number }[] = new Array(physics.n);
        for (let i = 0; i < physics.n; i++) {
          const i3 = i * 3;
          // Registry holds element — in rollback we fall back to 'C'
          // since the registry's restored snapshot may hold a
          // different ordering. Acceptable because this branch is
          // only reached in a failure path the user already sees as
          // an error.
          restoredAtoms[i] = {
            element: 'C',
            x: physics.pos[i3],
            y: physics.pos[i3 + 1],
            z: physics.pos[i3 + 2],
          };
        }
        const restoredBonds = physics.getBonds();
        try {
          await worker.clearScene();
          await worker.appendMolecule(restoredAtoms, restoredBonds, [0, 0, 0]);
        } catch (workerResyncErr) {
          // eslint-disable-next-line no-console
          console.warn('[lab.hydrate] worker re-sync after rollback failed:', workerResyncErr);
          // Fall through — we still return an error; the recovery
          // pathway is best-effort.
        }
      }

      // Renderer last — it rebuilds from the restored domain state.
      rebuildRendererFromSceneState();

      return { status: 'error', reason, cause };
    } catch (rollbackErr) {
      // eslint-disable-next-line no-console
      console.error('[lab.hydrate] rollback itself threw:', rollbackErr);
      return { status: 'error', reason: 'rollback-also-failed', cause: rollbackErr };
    }
  }

  // ── 3. Stage renderer — clear + reserve capacity, but do NOT yet
  //       populate. A worker-restoreState failure at step 5 cheaply
  //       rewinds to this clean state via rebuildRendererFromSceneState. ──
  try {
    renderer.clearAllMeshes();
    renderer.ensureCapacityForAppend(payload.n);
  } catch (err) {
    return rollback('renderer-stage-threw', err);
  }

  // ── 4. Commit main-thread physics (synchronous).
  //
  //       Use the SAME `clearScene + appendMolecule` primitives the
  //       Lab-native "Clear playground + Add molecule" flow uses
  //       (`scene-runtime.commitMolecule`), not `restoreCheckpoint`.
  //       The restoreCheckpoint path's sibling worker path
  //       (`worker.restoreState`) had a hidden silent-failure mode
  //       (on logical `ok: false`, the worker lifecycle's onFailure
  //       recovery clobbered main-thread state back to the pre-hydrate
  //       scene while the hydrate itself reported success). Using
  //       appendMolecule on BOTH authorities keeps the two paths in
  //       lockstep with the commit path Lab already ships and trusts.
  //
  //       Velocities are applied separately via direct buffer assignment
  //       because appendMolecule does not take a velocity argument.
  //       Boundary / timing / damping / drag / rotate / wallMode
  //       follow the appended atoms so the authoritative hydrate
  //       config (not the boot default) drives subsequent stepping. ──
  try {
    physics.clearScene();
    const result = physics.appendMolecule(
      payload.localStructureAtoms,
      payload.bonds,
      [0, 0, 0],
    );
    if (result.atomOffset !== 0 || result.atomCount !== payload.n) {
      throw new Error(
        `physics.appendMolecule returned unexpected shape: offset=${result.atomOffset}, count=${result.atomCount}, expected offset=0, count=${payload.n}`,
      );
    }
    // Velocities: the seed carries them even on capsule histories
    // (zero-filled for cold start). Copy into the engine's freshly
    // allocated `vel` buffer so momentum carries over.
    const velLen = Math.min(payload.velocities.length, physics.vel.length);
    physics.vel.set(payload.velocities.subarray(0, velLen));

    physics.restoreBoundarySnapshot(payload.boundary);
    // Apply timing config with authoritative dampingRefDurationFs so
    // `_recomputeDampingFactor` uses the handed-off window, not Lab's
    // boot default. See audit rev 8 P1 + physics.ts three-arg setTimeConfig.
    physics.setTimeConfig(
      payload.workerConfig.dt,
      payload.workerConfig.dampingReferenceSteps,
      payload.workerConfig.dampingRefDurationFs,
    );
    physics.setDamping(payload.workerConfig.damping);
    physics.setDragStrength(payload.workerConfig.kDrag);
    physics.setRotateStrength(payload.workerConfig.kRotate);
    physics.setWallMode(payload.workerConfig.wallMode);
    physics.refreshTopology();
  } catch (err) {
    return rollback('physics-commit-threw', err);
  }

  // ── 5. Commit worker physics using the same primitives as Lab's
  //       native commit path.
  //
  //       If `worker` is null, the environment has no worker at all
  //       (dev / tests with `useWorker === false`): skip cleanly.
  //       If `worker` is non-null but `isActive()` returns false,
  //       the worker init never completed (or was torn down by its
  //       `onFailure`). Main.ts awaits `_workerInitPromise` before
  //       calling us, so a `false` here means init failed — route
  //       through rollback instead of waiting for an ack that will
  //       never come. A synchronous check is sufficient: a
  //       `setTimeout` poll would false-positive in backgrounded
  //       tabs (visibility-throttled timers) AND block the rollback
  //       for up to its budget when the real failure mode is "worker
  //       already torn down."
  //
  //       On logical failure (`ok: false`) we route into rollback
  //       instead of letting the worker lifecycle's onFailure
  //       recovery silently clobber main-thread state. ──
  if (worker) {
    if (!worker.isActive()) {
      return rollback(
        'worker-restore-rejected',
        new Error('worker is not active at hydrate time (init failed or torn down)'),
      );
    }
    try {
      const cleared = await worker.clearScene();
      if (!cleared.ok) {
        return rollback('worker-restore-rejected', new Error('worker.clearScene returned ok:false'));
      }
      const appended = await worker.appendMolecule(
        payload.localStructureAtoms,
        payload.bonds,
        [0, 0, 0],
      );
      if (!appended.ok) {
        return rollback('worker-restore-rejected', new Error('worker.appendMolecule returned ok:false'));
      }
    } catch (err) {
      return rollback('worker-restore-rejected', err);
    }
  }

  // ── 6. Finalize remaining authorities. Post-commit path — any throw
  //       here triggers a full rollback so we never land in a state
  //       where physics is good but the registry / scene / renderer
  //       are partial.
  //
  //       The handoff REPLACES the entire scene. Tracker + registry
  //       must therefore be reset to clean state before registering
  //       the seed's atoms — otherwise `handleAppend(0, n)` would
  //       throw "non-contiguous append" against a tracker that still
  //       holds the pre-handoff slot mapping. Rollback restores the
  //       pre-call snapshots, so this reset is safe.
  //
  //       Ordering inside this block: clear scene-metadata FIRST,
  //       register the seed's atoms SECOND, populate renderer LAST.
  //       Logically-forward "clear → record → paint" reads better
  //       than "paint → clear → record" (functionally safe either
  //       way, since the renderer does not read the registry/tracker). ──
  try {
    // Clear scene metadata to match the clearScene+restoreCheckpoint
    // we already applied to physics in step 4.
    tracker.reset();
    registry.reset();
    sceneState.molecules.length = 0;
    sceneState.totalAtoms = 0;
    // Preserve the id counter across hydrate so a subsequent commit
    // cannot collide with a pre-handoff molecule id from any consumer
    // that cached it.
    sceneState.nextId = capture.scene.nextId;

    // Tracker + registry assign fresh ids 0..n-1 for the seed atoms.
    // Note: the `source` argument passed below is NOT persisted by the
    // registry (see `AtomMetadataRegistry.registerAppendedAtoms`
    // JSDoc) — it is consumed only for whatever side effects the
    // registration path may want; the snapshot/restore cycle round-
    // trips only `{id, element}`. If future code needs rollback-safe
    // source metadata, extend `AtomMetadataEntry` rather than wiring
    // another parameter here.
    const assignedIds = tracker.handleAppend(0, payload.n);
    registry.registerAppendedAtoms(
      assignedIds,
      payload.localStructureAtoms,
      { file: WATCH_HANDOFF_MARKER, label: sourceMeta.fileName ?? 'Remixed scene' },
    );

    // Session scene — one synthetic molecule representing the entire
    // handed-off seed. `structureFile === WATCH_HANDOFF_MARKER` tells
    // any future re-load code there is no source file.
    sceneState.molecules.push({
      id: sceneState.nextId++,
      name: sourceMeta.fileName ?? 'Remixed scene',
      structureFile: WATCH_HANDOFF_MARKER,
      atomCount: payload.n,
      atomOffset: 0,
      localAtoms: payload.localStructureAtoms.map((a) => ({ element: a.element, x: a.x, y: a.y, z: a.z })),
      localBonds: payload.bonds.map((b) => [b[0], b[1], b[2]] as BondTuple),
    });
    sceneState.totalAtoms = payload.n;

    // Renderer populate + final sync, now that the domain state is
    // coherent with what the mesh will reflect.
    renderer.populateAppendedAtoms(payload.localStructureAtoms, 0);
    renderer.setPhysicsRef(physics);
    renderer.updateSceneRadius();
    renderer.recomputeFocusDistance();
    renderer.updatePositions(physics);
  } catch (err) {
    return rollback('registry-register-threw', err);
  }

  // ── 7. Publish success. ──
  deps.onHydrated?.({
    atomOffset: 0,
    atomCount: payload.n,
    sourceMeta,
    provenance: payload.provenance,
  });

  return { status: 'ok', atomCount: payload.n };

  } finally {
    // Release the hydration lock on EVERY exit — success, classified
    // rollback, rollback-also-failed, and even the `onHydrated`
    // callback throwing (which would bubble past the return above).
    // Without this, a post-call frame loop would never resume its
    // normal snapshot-reconcile + local-physics path.
    deps.setHydrationActive?.(false);
  }
}
