/**
 * @vitest-environment jsdom
 */
/**
 * Wrapper-level tests for `SceneRuntime.hydrateFromWatchSeed` — the
 * production entry point. These cover the adapter logic that the
 * standalone transaction tests deliberately skip:
 *   - missing-deps → fail closed with 'runtime-not-ready'
 *   - HydrateResult.reason → useAppStore.setStatusError mapping
 *   - onHydrated side effects (updateSceneStatus + onSceneMutated)
 *   - pause-sync awaited before hydrate
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createSceneRuntime, type SceneRuntimeDeps } from '../../lab/js/runtime/scene-runtime';
import { createAtomMetadataRegistry } from '../../lab/js/runtime/timeline/atom-metadata-registry';
import { createTimelineAtomIdentityTracker } from '../../lab/js/runtime/timeline/timeline-atom-identity';
import { useAppStore } from '../../lab/js/store/app-store';
import type {
  WatchLabSceneSeed,
  WatchToLabHandoffPayload,
} from '../../src/watch-lab-handoff/watch-lab-handoff-shared';

function seed(): WatchLabSceneSeed {
  return {
    atoms: [{ id: 0, element: 'C' }, { id: 1, element: 'H' }],
    positions: [0, 0, 0, 1.4, 0, 0],
    velocities: [0, 0, 0, 0, 0, 0],
    bonds: [{ a: 0, b: 1, distance: 1.4 }],
    boundary: {
      mode: 'contain', wallRadius: 50, wallCenter: [0, 0, 0],
      wallCenterSet: true, removedCount: 0, damping: 0.1,
    },
    config: { damping: 0.1, kDrag: 1, kRotate: 1, dtFs: 0.5, dampingRefDurationFs: 100 },
    colorAssignments: [], camera: null, provenance: { historyKind: 'full', velocitySource: 'restart' as const, velocitiesAreApproximated: false, unresolvedVelocityFraction: 0 },
  };
}

function sourceMeta(): WatchToLabHandoffPayload['sourceMeta'] {
  return { fileName: 'x.atomdojo', fileKind: 'full', shareCode: null, timePs: 1, frameId: 0 };
}

/** Lightweight physics mock meeting the hydrate's `HydrateFromWatchSeedDeps.physics`
 *  slice. Not exported from the shared fixture module because this
 *  test wants full control over what throws when. */
function makePhysics() {
  const s = {
    n: 0,
    pos: new Float64Array(3 * 100),
    vel: new Float64Array(3 * 100),
    bonds: [] as [number, number, number][],
  };
  return {
    get n() { return s.n; },
    get pos() { return s.pos; },
    get vel() { return s.vel; },
    clearScene: vi.fn(() => { s.n = 0; s.bonds = []; }),
    appendMolecule: vi.fn((atoms: { element: string; x: number; y: number; z: number }[], bonds: [number, number, number][], offset: number[]) => {
      const atomOffset = s.n;
      for (let i = 0; i < atoms.length; i++) {
        const i3 = (s.n + i) * 3;
        s.pos[i3] = atoms[i].x + offset[0];
        s.pos[i3 + 1] = atoms[i].y + offset[1];
        s.pos[i3 + 2] = atoms[i].z + offset[2];
      }
      s.n += atoms.length;
      for (const b of bonds) s.bonds.push([b[0], b[1], b[2]] as [number, number, number]);
      return { atomOffset, atomCount: atoms.length };
    }),
    createCheckpoint: vi.fn(() => ({
      n: s.n,
      pos: new Float64Array(s.pos.subarray(0, s.n * 3)),
      vel: new Float64Array(s.vel.subarray(0, s.n * 3)),
      bonds: s.bonds.map((b) => [b[0], b[1], b[2]] as [number, number, number]),
    })),
    restoreCheckpoint: vi.fn((cp: { n: number; pos: Float64Array; vel: Float64Array; bonds: [number, number, number][] }) => {
      s.n = cp.n;
      s.pos.set(cp.pos.subarray(0, cp.n * 3));
      s.vel.set(cp.vel.subarray(0, cp.n * 3));
      s.bonds = cp.bonds.map((b) => [b[0], b[1], b[2]] as [number, number, number]);
    }),
    getBoundarySnapshot: vi.fn(() => ({
      mode: 'contain' as const,
      wallRadius: 100,
      wallCenter: [0, 0, 0] as [number, number, number],
      wallCenterSet: false,
      removedCount: 0,
      damping: 0.05,
    })),
    restoreBoundarySnapshot: vi.fn(),
    setTimeConfig: vi.fn(),
    getDamping: vi.fn(() => 0.0),
    getDragStrength: vi.fn(() => 3.0),
    getRotateStrength: vi.fn(() => 7.0),
    setDamping: vi.fn(),
    setDragStrength: vi.fn(),
    setRotateStrength: vi.fn(),
    setWallMode: vi.fn(),
    refreshTopology: vi.fn(),
    getBonds: vi.fn(() => s.bonds.map((b) => [b[0], b[1], b[2]] as [number, number, number])),
    // Extra methods the real PhysicsEngine has that SceneRuntime queries
    // on its commit path — not touched during hydrate but needed to
    // satisfy the type. Sketch a minimal stub.
    getWallMode: vi.fn(() => 'contain' as const),
  };
}

function makeRenderer() {
  return {
    clearAllMeshes: vi.fn(),
    ensureCapacityForAppend: vi.fn(),
    populateAppendedAtoms: vi.fn(),
    setPhysicsRef: vi.fn(),
    updateSceneRadius: vi.fn(),
    recomputeFocusDistance: vi.fn(),
    updatePositions: vi.fn(),
    fitCamera: vi.fn(),
  };
}

function makeDeps(overrides: Partial<SceneRuntimeDeps> = {}, workerBehavior: 'resolve' | 'reject' | 'inactive' = 'resolve') {
  const physics = makePhysics();
  const renderer = makeRenderer();
  const registry = createAtomMetadataRegistry();
  const tracker = createTimelineAtomIdentityTracker();
  const session = {
    theme: 'light',
    textSize: 'normal',
    isLoading: false,
    interactionMode: 'drag',
    playback: { selectedSpeed: 1, speedMode: 'normal', effectiveSpeed: 1, maxSpeed: 4, paused: false },
    scene: { molecules: [] as unknown as never[], nextId: 1, totalAtoms: 0 },
  };
  const onSceneMutated = vi.fn();
  const workerRuntime = workerBehavior === 'inactive' ? null : {
    isActive: () => true,
    clearScene: vi.fn(() => Promise.resolve({ ok: true })),
    appendMolecule: vi.fn(() =>
      workerBehavior === 'resolve' ? Promise.resolve({ ok: true }) : Promise.reject(new Error('worker refused')),
    ),
    // Stub the other WorkerRuntime methods we don't call in this test.
  };
  const deps: SceneRuntimeDeps = {
    getPhysics: () => physics as never,
    getRenderer: () => renderer as never,
    getStateMachine: () => ({ forceIdle: () => {} }) as never,
    getPlacement: () => null,
    getStatusCtrl: () => null,
    getWorkerRuntime: () => workerRuntime as never,
    getInputBindings: () => null,
    getSnapshotReconciler: () => null,
    getSession: () => session,
    dispatch: vi.fn(),
    fullSchedulerReset: vi.fn(),
    partialProfilerReset: vi.fn(),
    recoverFromWorkerFailure: vi.fn(),
    getAtomIdentityTracker: () => tracker,
    getAtomMetadataRegistry: () => registry,
    onSceneMutated,
    ...overrides,
  };
  return { deps, physics, renderer, registry, tracker, session, onSceneMutated, workerRuntime };
}

describe('SceneRuntime.hydrateFromWatchSeed — wrapper adapter layer', () => {
  beforeEach(() => {
    useAppStore.getState().resetTransientState();
    useAppStore.getState().setStatusError(null);
  });
  afterEach(() => {
    useAppStore.getState().setStatusError(null);
  });

  it('success: status error stays null + onSceneMutated fires', async () => {
    const { deps, onSceneMutated } = makeDeps({}, 'resolve');
    const runtime = createSceneRuntime(deps);
    const result = await runtime.hydrateFromWatchSeed(seed(), sourceMeta());
    expect(result.status).toBe('ok');
    expect(onSceneMutated).toHaveBeenCalledTimes(1);
    expect(useAppStore.getState().statusError).toBeNull();
  });

  it('missing registry/tracker → runtime-not-ready + specific user-facing copy', async () => {
    const { deps } = makeDeps({}, 'resolve');
    // Override to simulate boot-order bug where timeline subsystem hasn't installed yet.
    const runtime = createSceneRuntime({
      ...deps,
      getAtomIdentityTracker: () => null,
      getAtomMetadataRegistry: () => null,
    });
    const result = await runtime.hydrateFromWatchSeed(seed(), sourceMeta());
    expect(result).toMatchObject({ status: 'error', reason: 'runtime-not-ready' });
    const err = useAppStore.getState().statusError ?? '';
    expect(err).toMatch(/internal subsystems aren.t ready/i);
  });

  it('missing registry alone → runtime-not-ready (tracker present is not sufficient)', async () => {
    const { deps } = makeDeps({}, 'resolve');
    const runtime = createSceneRuntime({
      ...deps,
      getAtomMetadataRegistry: () => null,
    });
    const result = await runtime.hydrateFromWatchSeed(seed(), sourceMeta());
    expect(result.status).toBe('error');
    if (result.status === 'error') expect(result.reason).toBe('runtime-not-ready');
  });

  it('worker rejection → mapped to worker-restore-rejected copy (not a generic error)', async () => {
    const { deps } = makeDeps({}, 'reject');
    const runtime = createSceneRuntime(deps);
    const result = await runtime.hydrateFromWatchSeed(seed(), sourceMeta());
    expect(result).toMatchObject({ status: 'error', reason: 'worker-restore-rejected' });
    const err = useAppStore.getState().statusError ?? '';
    expect(err).toMatch(/simulation worker/i);
  });

  it('pause-sync promise is awaited before the hydrate transaction runs', async () => {
    let pauseResolved = false;
    const pauseDone = new Promise<void>((resolve) => {
      setTimeout(() => { pauseResolved = true; resolve(); }, 40);
    });
    const { deps, physics } = makeDeps({
      getPauseSyncPromise: () => pauseDone,
    }, 'resolve');
    const runtime = createSceneRuntime(deps);
    await runtime.hydrateFromWatchSeed(seed(), sourceMeta());
    // Physics `clearScene` should only fire AFTER the pause-sync promise
    // resolved — both observably-true because the hydrate awaits, and
    // directly-observable via the `pauseResolved` flag.
    expect(pauseResolved).toBe(true);
    expect(physics.clearScene).toHaveBeenCalled();
  });

  it('onHydrated success path fires updateSceneStatus via onSceneMutated observer', async () => {
    // The wrapper's onHydrated calls `this.updateSceneStatus()` + the
    // external `onSceneMutated` callback. updateSceneStatus itself
    // writes to the store; verify the external observer fires too
    // (our mock captures that).
    const { deps, onSceneMutated } = makeDeps({}, 'resolve');
    const runtime = createSceneRuntime(deps);
    await runtime.hydrateFromWatchSeed(seed(), sourceMeta());
    expect(onSceneMutated).toHaveBeenCalledTimes(1);
  });

  it('rollback (worker rejection) does NOT fire onSceneMutated', async () => {
    const { deps, onSceneMutated } = makeDeps({}, 'reject');
    const runtime = createSceneRuntime(deps);
    await runtime.hydrateFromWatchSeed(seed(), sourceMeta());
    // onSceneMutated runs only on the success-finalize path via
    // `onHydrated`, so a rollback must leave it unfired.
    expect(onSceneMutated).not.toHaveBeenCalled();
  });

  it('hydration lock: setHydrationActive(true) fires before the transaction and setHydrationActive(false) fires on success', async () => {
    const calls: boolean[] = [];
    const { deps } = makeDeps({
      setHydrationActive: (active: boolean) => calls.push(active),
    }, 'resolve');
    const runtime = createSceneRuntime(deps);
    const result = await runtime.hydrateFromWatchSeed(seed(), sourceMeta());
    expect(result.status).toBe('ok');
    // Exactly one transition on, one off — in that order.
    expect(calls).toEqual([true, false]);
  });

  it('hydration lock: setHydrationActive(false) still fires when the transaction rolls back (worker rejection)', async () => {
    const calls: boolean[] = [];
    const { deps } = makeDeps({
      setHydrationActive: (active: boolean) => calls.push(active),
    }, 'reject');
    const runtime = createSceneRuntime(deps);
    await runtime.hydrateFromWatchSeed(seed(), sourceMeta());
    // Critical: the lock MUST clear on rollback, otherwise the frame
    // runtime would stay frozen after a failed hydrate.
    expect(calls).toEqual([true, false]);
  });

  it('statusError copy distinguishes registry-register-threw from other reasons', async () => {
    const { deps, registry } = makeDeps({}, 'resolve');
    // Force the registry to throw on register so we hit the
    // registry-register-threw branch.
    registry.registerAppendedAtoms = vi.fn(() => { throw new Error('boom'); });
    const runtime = createSceneRuntime(deps);
    const result = await runtime.hydrateFromWatchSeed(seed(), sourceMeta());
    expect(result.status).toBe('error');
    if (result.status === 'error') expect(result.reason).toBe('registry-register-threw');
    const err = useAppStore.getState().statusError ?? '';
    expect(err).toMatch(/register/i);
  });
});
