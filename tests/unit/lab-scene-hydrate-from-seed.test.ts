/**
 * @vitest-environment jsdom
 */
/**
 * `hydrateFromWatchSeed` transaction — §7.1 acceptance tests.
 *
 * Covers the full commit/rollback contract with lightweight mocks for
 * each authority. The mocks record calls so the test asserts on
 * observable order + state, not implementation internals.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  hydrateFromWatchSeed,
  WATCH_HANDOFF_MARKER,
  type HydrateFromWatchSeedDeps,
  type PhysicsCheckpoint,
  type BoundarySnapshot,
} from '../../lab/js/runtime/hydrate-from-watch-seed';
import type { SceneState } from '../../lab/js/scene';
import type {
  WatchLabSceneSeed,
  WatchToLabHandoffPayload,
} from '../../src/watch-lab-handoff/watch-lab-handoff-shared';
import { createAtomMetadataRegistry } from '../../lab/js/runtime/atom-metadata-registry';
import { createTimelineAtomIdentityTracker } from '../../lab/js/runtime/timeline-atom-identity';

// ── Fixtures ────────────────────────────────────────────────────────────

function seedFixture(): WatchLabSceneSeed {
  return {
    atoms: [
      { id: 0, element: 'C' },
      { id: 1, element: 'H' },
    ],
    positions: [0, 0, 0, 1.4, 0, 0],
    velocities: [0.01, 0, 0, -0.01, 0, 0],
    bonds: [{ a: 0, b: 1, distance: 1.4 }],
    boundary: {
      mode: 'contain',
      wallRadius: 50,
      wallCenter: [0, 0, 0],
      wallCenterSet: true,
      removedCount: 0,
      damping: 0.1,
    },
    config: { damping: 0.1, kDrag: 1, kRotate: 1, dtFs: 0.5, dampingRefDurationFs: 100 },
    provenance: { historyKind: 'full', velocitiesAreApproximated: false },
  };
}

function sourceMetaFixture(): WatchToLabHandoffPayload['sourceMeta'] {
  return { fileName: 'scene.atomdojo', fileKind: 'full', shareCode: null, timePs: 2.5, frameId: 0 };
}

function makePriorSceneWithOneMolecule(): SceneState {
  return {
    totalAtoms: 60,
    nextId: 2,
    molecules: [{
      id: 1,
      name: 'C60',
      structureFile: 'c60.xyz',
      atomCount: 60,
      atomOffset: 0,
      localAtoms: Array.from({ length: 60 }, (_, i) => ({
        element: 'C', x: i * 0.1, y: 0, z: 0,
      })),
      localBonds: [],
    }],
  };
}

function makeMockPhysics() {
  const state = {
    n: 60,
    pos: new Float64Array(60 * 3),
    vel: new Float64Array(60 * 3),
    bonds: [] as [number, number, number][],
    boundary: {
      mode: 'contain',
      wallRadius: 100,
      wallCenter: [0, 0, 0] as [number, number, number],
      wallCenterSet: false,
      removedCount: 0,
      damping: 0.05,
    } as BoundarySnapshot,
  };
  // Seed the pre-hydrate positions so a rollback restores non-trivial state.
  for (let i = 0; i < 60; i++) state.pos[i * 3] = i * 0.1;

  return {
    physics: {
      get n() { return state.n; },
      get pos() { return state.pos; },
      get vel() { return state.vel; },
      clearScene: vi.fn(() => {
        state.n = 0;
        state.bonds = [];
      }),
      createCheckpoint: vi.fn((): PhysicsCheckpoint => ({
        n: state.n,
        pos: new Float64Array(state.pos.subarray(0, state.n * 3)),
        vel: new Float64Array(state.vel.subarray(0, state.n * 3)),
        bonds: state.bonds.map((b) => [b[0], b[1], b[2]] as [number, number, number]),
      })),
      restoreCheckpoint: vi.fn((cp: PhysicsCheckpoint) => {
        state.n = cp.n;
        const size = cp.n * 3;
        if (state.pos.length < size) state.pos = new Float64Array(size);
        if (state.vel.length < size) state.vel = new Float64Array(size);
        state.pos.set(cp.pos.subarray(0, size));
        state.vel.set(cp.vel.subarray(0, size));
        state.bonds = cp.bonds.map((b) => [b[0], b[1], b[2]] as [number, number, number]);
      }),
      getBoundarySnapshot: vi.fn((): BoundarySnapshot => ({
        mode: state.boundary.mode,
        wallRadius: state.boundary.wallRadius,
        wallCenter: [...state.boundary.wallCenter] as [number, number, number],
        wallCenterSet: state.boundary.wallCenterSet,
        removedCount: state.boundary.removedCount,
        damping: state.boundary.damping,
      })),
      restoreBoundarySnapshot: vi.fn((snap: BoundarySnapshot) => {
        state.boundary = {
          mode: snap.mode,
          wallRadius: snap.wallRadius,
          wallCenter: [...snap.wallCenter] as [number, number, number],
          wallCenterSet: snap.wallCenterSet,
          removedCount: snap.removedCount,
          damping: snap.damping,
        };
      }),
      appendMolecule: vi.fn((atoms: { element: string; x: number; y: number; z: number }[], bonds: [number, number, number][], offset: number[]) => {
        const atomOffset = state.n;
        const size = (state.n + atoms.length) * 3;
        if (state.pos.length < size) {
          const grown = new Float64Array(Math.max(size, state.pos.length * 2));
          grown.set(state.pos);
          state.pos = grown;
        }
        if (state.vel.length < size) {
          const grown = new Float64Array(Math.max(size, state.vel.length * 2));
          grown.set(state.vel);
          state.vel = grown;
        }
        for (let i = 0; i < atoms.length; i++) {
          const i3 = (state.n + i) * 3;
          state.pos[i3] = atoms[i].x + offset[0];
          state.pos[i3 + 1] = atoms[i].y + offset[1];
          state.pos[i3 + 2] = atoms[i].z + offset[2];
        }
        state.n += atoms.length;
        for (const b of bonds) state.bonds.push([b[0], b[1], b[2]] as [number, number, number]);
        return { atomOffset, atomCount: atoms.length };
      }),
      setTimeConfig: vi.fn(),
      setDamping: vi.fn(),
      setDragStrength: vi.fn(),
      setRotateStrength: vi.fn(),
      setWallMode: vi.fn(),
      refreshTopology: vi.fn(),
      getBonds: vi.fn(() => state.bonds.map((b) => [b[0], b[1], b[2]] as [number, number, number])),
    },
    state, // exposed for assertions
  };
}

function makeMockRenderer() {
  return {
    clearAllMeshes: vi.fn(),
    ensureCapacityForAppend: vi.fn(),
    populateAppendedAtoms: vi.fn(),
    setPhysicsRef: vi.fn(),
    updateSceneRadius: vi.fn(),
    recomputeFocusDistance: vi.fn(),
    updatePositions: vi.fn(),
  };
}

function makeMockWorker(behavior: 'resolve' | 'reject' | 'inactive') {
  if (behavior === 'inactive') {
    return {
      isActive: vi.fn(() => false),
      clearScene: vi.fn(() => Promise.resolve({ ok: true })),
      appendMolecule: vi.fn(() => Promise.resolve({ ok: true })),
    };
  }
  return {
    isActive: vi.fn(() => true),
    clearScene: vi.fn(() =>
      behavior === 'resolve' ? Promise.resolve({ ok: true }) : Promise.resolve({ ok: false }),
    ),
    appendMolecule: vi.fn(() =>
      behavior === 'resolve' ? Promise.resolve({ ok: true }) : Promise.reject(new Error('worker refused')),
    ),
  };
}

function makeDeps(
  overrides: Partial<HydrateFromWatchSeedDeps> = {},
  workerBehavior: 'resolve' | 'reject' | 'inactive' = 'resolve',
): HydrateFromWatchSeedDeps & { _mockPhysics: ReturnType<typeof makeMockPhysics> } {
  const { physics, state } = makeMockPhysics();
  void state;
  const renderer = makeMockRenderer();
  const worker = makeMockWorker(workerBehavior);
  const sceneState = makePriorSceneWithOneMolecule();
  const registry = createAtomMetadataRegistry();
  // Pre-seed registry + tracker so a prior scene exists and rollback
  // has something non-trivial to restore.
  registry.registerAppendedAtoms(
    Array.from({ length: 60 }, (_, i) => i),
    Array.from({ length: 60 }, () => ({ element: 'C' })),
  );
  const tracker = createTimelineAtomIdentityTracker();
  tracker.handleAppend(0, 60);
  return {
    physics,
    renderer,
    worker,
    sceneState,
    registry,
    tracker,
    _mockPhysics: makeMockPhysics(),
    ...overrides,
  };
}

// ── Tests ───────────────────────────────────────────────────────────────

describe('hydrateFromWatchSeed — success path', () => {
  it('returns ok + commits across every authority', async () => {
    const deps = makeDeps({}, 'resolve');
    const onHydrated = vi.fn();
    const result = await hydrateFromWatchSeed(seedFixture(), sourceMetaFixture(), { ...deps, onHydrated });
    expect(result).toEqual({ status: 'ok', atomCount: 2 });

    // physics — commit now uses appendMolecule (the same primitive as
    // Lab-native `commitMolecule`), not restoreCheckpoint.
    expect(deps.physics.clearScene).toHaveBeenCalledTimes(1);
    expect(deps.physics.appendMolecule).toHaveBeenCalledTimes(1);
    expect(deps.physics.restoreBoundarySnapshot).toHaveBeenCalled();
    expect(deps.physics.setTimeConfig).toHaveBeenCalledWith(0.5, 200, 100);

    // worker — clearScene + appendMolecule pair mirrors the commit
    // path and avoids the restoreState silent-failure trap.
    expect(deps.worker!.clearScene).toHaveBeenCalledTimes(1);
    expect(deps.worker!.appendMolecule).toHaveBeenCalledTimes(1);

    // renderer — clear+stage, then populate in the finalize phase
    expect(deps.renderer.clearAllMeshes).toHaveBeenCalled();
    expect(deps.renderer.populateAppendedAtoms).toHaveBeenCalledWith(
      [
        { element: 'C', x: 0, y: 0, z: 0 },
        { element: 'H', x: 1.4, y: 0, z: 0 },
      ],
      0,
    );

    // scene state — synthetic molecule replaces prior content
    expect(deps.sceneState.molecules).toHaveLength(1);
    expect(deps.sceneState.molecules[0].structureFile).toBe(WATCH_HANDOFF_MARKER);
    expect(deps.sceneState.molecules[0].atomCount).toBe(2);
    expect(deps.sceneState.totalAtoms).toBe(2);

    // onHydrated notified with provenance + sourceMeta
    expect(onHydrated).toHaveBeenCalledWith(expect.objectContaining({
      atomCount: 2,
      sourceMeta: sourceMetaFixture(),
      provenance: { historyKind: 'full', velocitiesAreApproximated: false },
    }));
  });

  // NOTE: the previous test "skips worker commit when worker is
  // inactive but still commits main-thread" was removed as part of
  // the 2026-04-16 flash-to-C60 bug fix. That "silent skip"
  // behavior was the bug: if the real worker exists but isn't yet
  // initialized (boot race), skipping the commit left the worker on
  // the pre-hydrate default scene, which then emitted frameResults
  // that clobbered the main-thread seed via the reconciler. The new
  // contract is tested below: `isActive() === false` → wait, then
  // rollback if it never flips. Only `worker === null` (no worker
  // at all) still skips.

  it('worker active at call time: commits (clearScene + appendMolecule) and returns ok', async () => {
    // Main.ts boot awaits `_workerInitPromise` before invoking the
    // hydrate, so by the time the transactional module runs the
    // worker is always active on the happy path. This test pins
    // that contract: an active worker MUST be driven through
    // `clearScene + appendMolecule` — silent skip is the original
    // 2026-04-16 flash-to-C60 bug.
    const deps = makeDeps({}, 'resolve');
    const result = await hydrateFromWatchSeed(seedFixture(), sourceMetaFixture(), deps);
    expect(result).toEqual({ status: 'ok', atomCount: 2 });
    expect(deps.worker!.clearScene).toHaveBeenCalledTimes(1);
    expect(deps.worker!.appendMolecule).toHaveBeenCalledTimes(1);
  });

  it('worker NOT active at call time: rolls back with worker-restore-rejected (fail-fast, no poll)', async () => {
    // Contract: main.ts awaits `_workerInitPromise` upstream. If we
    // reach the hydrate with `isActive() === false`, the worker was
    // torn down (init failed, lifecycle onFailure fired). Committing
    // main-thread-only would leave the two physics authorities out
    // of sync and the next frameResult would revert the scene —
    // fail closed instead so the user sees "couldn't hydrate" and
    // the default-scene fallback can take over.
    //
    // Synchronous check (no polling): a setTimeout loop would
    // false-positive in backgrounded tabs (visibility-throttled
    // timers) AND block rollback unnecessarily. The upstream
    // `_workerInitPromise` await is the only timing gate we need.
    const deps = makeDeps({}, 'resolve');
    deps.worker = {
      isActive: vi.fn(() => false),
      clearScene: vi.fn(() => Promise.resolve({ ok: true })),
      appendMolecule: vi.fn(() => Promise.resolve({ ok: true })),
    };
    const result = await hydrateFromWatchSeed(seedFixture(), sourceMetaFixture(), deps);
    expect(result).toMatchObject({ status: 'error', reason: 'worker-restore-rejected' });
    expect(deps.worker!.clearScene).not.toHaveBeenCalled();
    expect(deps.worker!.appendMolecule).not.toHaveBeenCalled();
  });

  it('skips worker commit when worker dep is null', async () => {
    const deps = { ...makeDeps({}, 'inactive'), worker: null };
    const result = await hydrateFromWatchSeed(seedFixture(), sourceMetaFixture(), deps);
    expect(result.status).toBe('ok');
  });
});

describe('hydrateFromWatchSeed — rollback on each throw path', () => {
  it('physics.appendMolecule throws at commit → rollback fires, onHydrated never called', async () => {
    const deps = makeDeps({}, 'resolve');
    const onHydrated = vi.fn();
    // Throw unconditionally on the commit's appendMolecule. Rollback
    // uses restoreCheckpoint, so the rollback path itself is independent.
    deps.physics.appendMolecule = vi.fn(() => { throw new Error('physics commit failed'); });
    const result = await hydrateFromWatchSeed(seedFixture(), sourceMetaFixture(), { ...deps, onHydrated });
    expect(result).toMatchObject({ status: 'error', reason: 'physics-commit-threw' });
    expect(onHydrated).not.toHaveBeenCalled();
  });

  it('renderer.clearAllMeshes throws at stage → rollback fires, onHydrated never called', async () => {
    const deps = makeDeps({}, 'resolve');
    const onHydrated = vi.fn();
    // Throw on the first clearAllMeshes call (stage); subsequent calls
    // (rollback rebuild) succeed.
    let clearCount = 0;
    deps.renderer.clearAllMeshes = vi.fn(() => {
      clearCount++;
      if (clearCount === 1) throw new Error('renderer stage failed');
    });
    const result = await hydrateFromWatchSeed(seedFixture(), sourceMetaFixture(), { ...deps, onHydrated });
    expect(result).toMatchObject({ status: 'error', reason: 'renderer-stage-threw' });
    expect(onHydrated).not.toHaveBeenCalled();
    // Scene state must still match the pre-call state (C60).
    expect(deps.sceneState.molecules).toHaveLength(1);
    expect(deps.sceneState.molecules[0].structureFile).toBe('c60.xyz');
  });

  it('registry.registerAppendedAtoms throws at finalize → rollback fires, onHydrated never called', async () => {
    const deps = makeDeps({}, 'resolve');
    const onHydrated = vi.fn();
    deps.registry.registerAppendedAtoms = vi.fn(() => { throw new Error('registry failed'); });
    const result = await hydrateFromWatchSeed(seedFixture(), sourceMetaFixture(), { ...deps, onHydrated });
    expect(result).toMatchObject({ status: 'error', reason: 'registry-register-threw' });
    expect(onHydrated).not.toHaveBeenCalled();
    // @watch-handoff sentinel MUST NOT leak even though we got all the
    // way to the finalize step.
    expect(deps.sceneState.molecules.every((m) => m.structureFile !== WATCH_HANDOFF_MARKER)).toBe(true);
    expect(deps.sceneState.molecules).toHaveLength(1);
    expect(deps.sceneState.molecules[0].structureFile).toBe('c60.xyz');
  });

  it('worker rejection → rollback fires, onHydrated never called', async () => {
    // Reinforcement of the existing worker-reject test with explicit
    // onHydrated negative assertion so the "commit callback only
    // fires on success" contract is locked for every rollback reason.
    const deps = makeDeps({}, 'reject');
    const onHydrated = vi.fn();
    const result = await hydrateFromWatchSeed(seedFixture(), sourceMetaFixture(), { ...deps, onHydrated });
    expect(result).toMatchObject({ status: 'error', reason: 'worker-restore-rejected' });
    expect(onHydrated).not.toHaveBeenCalled();
  });
});

describe('hydrateFromWatchSeed — rollback (existing invariants)', () => {
  it('worker rejection triggers full rollback: scene, registry, tracker, physics all restored', async () => {
    const deps = makeDeps({}, 'reject');
    // Record pre-call state.
    const priorRegistry = deps.registry.getAtomTable();
    const priorTrackerAssigned = deps.tracker.getTotalAssigned();
    const priorMolecules = JSON.parse(JSON.stringify(deps.sceneState.molecules));
    const priorTotalAtoms = deps.sceneState.totalAtoms;
    const priorNextId = deps.sceneState.nextId;

    const result = await hydrateFromWatchSeed(seedFixture(), sourceMetaFixture(), deps);
    expect(result).toMatchObject({ status: 'error', reason: 'worker-restore-rejected' });

    // Scene restored byte-for-byte.
    expect(deps.sceneState.molecules).toEqual(priorMolecules);
    expect(deps.sceneState.totalAtoms).toBe(priorTotalAtoms);
    expect(deps.sceneState.nextId).toBe(priorNextId);

    // Registry restored.
    expect(deps.registry.getAtomTable()).toEqual(priorRegistry);
    // Tracker restored.
    expect(deps.tracker.getTotalAssigned()).toBe(priorTrackerAssigned);

    // Physics rollback calls restoreCheckpoint with the captured
    // pre-hydrate state. Commit path uses appendMolecule (no
    // restoreCheckpoint), so this is exactly ONE call in the rollback.
    expect(vi.mocked(deps.physics.restoreCheckpoint).mock.calls.length).toBe(1);
    // Renderer rebuilt from prior scene.
    expect(deps.renderer.clearAllMeshes).toHaveBeenCalledTimes(2); // stage + rebuild
  });

  it('no @watch-handoff molecule leaks into sceneState after rollback', async () => {
    const deps = makeDeps({}, 'reject');
    await hydrateFromWatchSeed(seedFixture(), sourceMetaFixture(), deps);
    expect(deps.sceneState.molecules.every((m) => m.structureFile !== WATCH_HANDOFF_MARKER)).toBe(true);
  });

  it('on rollback with an active worker, re-syncs worker against the restored main-thread state', async () => {
    const deps = makeDeps({}, 'reject');
    await hydrateFromWatchSeed(seedFixture(), sourceMetaFixture(), deps);
    // Rollback's worker re-sync uses clearScene + appendMolecule on
    // the restored main-thread state. The original rejected commit
    // also called clearScene (which succeeded with ok:true in 'reject'
    // behavior) + appendMolecule (which rejected). Net: clearScene at
    // least twice (commit attempt + rollback re-sync).
    expect(vi.mocked(deps.worker!.clearScene).mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});

describe('hydrateFromWatchSeed — timing fidelity', () => {
  it('propagates authoritative dampingRefDurationFs through to physics.setTimeConfig', async () => {
    const deps = makeDeps({}, 'resolve');
    const customSeed = { ...seedFixture(), config: { damping: 0.1, kDrag: 1, kRotate: 1, dtFs: 0.25, dampingRefDurationFs: 137 } };
    await hydrateFromWatchSeed(customSeed, sourceMetaFixture(), deps);
    // Three-arg form — final argument is the duration.
    expect(deps.physics.setTimeConfig).toHaveBeenCalledWith(0.25, expect.any(Number), 137);
  });
});

describe('hydrateFromWatchSeed — synthetic molecule shape', () => {
  it('uses sourceMeta.fileName as molecule name and @watch-handoff marker as structureFile', async () => {
    const deps = makeDeps({}, 'resolve');
    await hydrateFromWatchSeed(seedFixture(), { ...sourceMetaFixture(), fileName: 'custom.atomdojo' }, deps);
    const mol = deps.sceneState.molecules[0];
    expect(mol.name).toBe('custom.atomdojo');
    expect(mol.structureFile).toBe(WATCH_HANDOFF_MARKER);
    expect(mol.atomOffset).toBe(0);
    expect(mol.atomCount).toBe(2);
    expect(mol.localAtoms).toHaveLength(2);
    expect(mol.localBonds).toHaveLength(1);
  });

  it('falls back to "Remixed scene" when fileName is null', async () => {
    const deps = makeDeps({}, 'resolve');
    await hydrateFromWatchSeed(seedFixture(), { ...sourceMetaFixture(), fileName: null }, deps);
    expect(deps.sceneState.molecules[0].name).toBe('Remixed scene');
  });
});
