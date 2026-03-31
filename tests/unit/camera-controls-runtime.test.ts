/**
 * Runtime behavior tests for Phase 2 camera controls.
 *
 * Tests the actual runtime paths:
 * - overlay-runtime.close() clearing camera transient UI
 * - handleCenterObject from focus-runtime (same code main.ts ships)
 * - interaction-dispatch pick-focus interception (startDrag/Move/Rotate consumed)
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as THREE from 'three';
import { useAppStore } from '../../page/js/store/app-store';
import { createOverlayRuntime } from '../../page/js/runtime/overlay-runtime';

// ── overlay-runtime.close() behavior ──

describe('overlay-runtime.close() clears camera transient UI', () => {
  beforeEach(() => {
    useAppStore.getState().resetTransientState();
  });

  it('clears cameraHelpOpen when help is open', () => {
    useAppStore.getState().setCameraHelpOpen(true);
    const overlay = createOverlayRuntime({ getStatusCtrl: () => null });
    overlay.close();
    expect(useAppStore.getState().cameraHelpOpen).toBe(false);
  });


  it('also closes active sheet', () => {
    useAppStore.getState().openSheet('settings');
    useAppStore.getState().setCameraHelpOpen(true);
    const overlay = createOverlayRuntime({ getStatusCtrl: () => null });
    overlay.close();
    expect(useAppStore.getState().activeSheet).toBeNull();
    expect(useAppStore.getState().cameraHelpOpen).toBe(false);
  });
});

// ── Center Object callback behavior ──

// ── Center Object: tests call the real handleCenterObject from focus-runtime ──

import { handleCenterObject } from '../../page/js/runtime/focus-runtime';

describe('Center Object (handleCenterObject from focus-runtime)', () => {
  let mockRenderer: { getMoleculeCentroid: any; getMoleculeBounds: any; setCameraFocusTarget: any; animateToFocusedObject: any; camera: any; getSceneRadius: () => number };

  beforeEach(() => {
    useAppStore.getState().resetTransientState();
    mockRenderer = {
      getMoleculeCentroid: vi.fn(() => new THREE.Vector3(1, 2, 3)),
      getMoleculeBounds: vi.fn(() => ({ center: new THREE.Vector3(1, 2, 3), radius: 3.5 })),
      setCameraFocusTarget: vi.fn(),
      animateToFocusedObject: vi.fn(),
      camera: { position: new THREE.Vector3(0, 0, 15) },
      getSceneRadius: () => 10,
    };
  });

  it('zero molecules: no-op, no pick-focus', () => {
    useAppStore.getState().setMolecules([]);
    handleCenterObject(mockRenderer);
    expect(mockRenderer.setCameraFocusTarget).not.toHaveBeenCalled();
  });

  it('one molecule: animated center, no pick-focus', () => {
    useAppStore.getState().setMolecules([
      { id: 1, name: 'C60', structureFile: 'c60.xyz', atomCount: 60, atomOffset: 0 },
    ]);
    handleCenterObject(mockRenderer);
    expect(mockRenderer.animateToFocusedObject).toHaveBeenCalled();
    expect(useAppStore.getState().lastFocusedMoleculeId).toBe(1);
  });

  it('valid last-focused molecule: animated center, no pick-focus', () => {
    useAppStore.getState().setMolecules([
      { id: 1, name: 'C60', structureFile: 'c60.xyz', atomCount: 60, atomOffset: 0 },
      { id: 2, name: 'CNT', structureFile: 'cnt.xyz', atomCount: 100, atomOffset: 60 },
    ]);
    useAppStore.getState().setLastFocusedMoleculeId(2);
    handleCenterObject(mockRenderer);
    expect(mockRenderer.animateToFocusedObject).toHaveBeenCalled();
  });

  it('multiple molecules, no valid focus: centers nearest molecule', () => {
    useAppStore.getState().setMolecules([
      { id: 1, name: 'C60', structureFile: 'c60.xyz', atomCount: 60, atomOffset: 0 },
      { id: 2, name: 'CNT', structureFile: 'cnt.xyz', atomCount: 100, atomOffset: 60 },
    ]);
    handleCenterObject(mockRenderer);
    // No pick-focus mode — centers nearest molecule directly
    expect(mockRenderer.animateToFocusedObject).toHaveBeenCalled();
    expect(useAppStore.getState().lastFocusedMoleculeId).not.toBeNull();
  });

  it('multiple molecules, stale focused ID: centers nearest molecule', () => {
    useAppStore.getState().setMolecules([
      { id: 1, name: 'C60', structureFile: 'c60.xyz', atomCount: 60, atomOffset: 0 },
      { id: 2, name: 'CNT', structureFile: 'cnt.xyz', atomCount: 100, atomOffset: 60 },
    ]);
    useAppStore.getState().setLastFocusedMoleculeId(99);
    handleCenterObject(mockRenderer);
    expect(mockRenderer.animateToFocusedObject).toHaveBeenCalled();
  });
});

// ── Interaction dispatch — normal start (no pick-focus) ──

import { createInteractionDispatch } from '../../page/js/runtime/interaction-dispatch';

describe('interaction-dispatch normal start', () => {
  beforeEach(() => {
    useAppStore.getState().resetTransientState();
    useAppStore.getState().setMolecules([
      { id: 1, name: 'C60', structureFile: 'c60.xyz', atomCount: 60, atomOffset: 0 },
    ]);
  });

  function makeMockDispatchDeps() {
    const physics = {
      startDrag: vi.fn(),
      endDrag: vi.fn(),
      startTranslate: vi.fn(),
      startRotateDrag: vi.fn(),
      updateDrag: vi.fn(),
      applyImpulse: vi.fn(),
    } as any;
    const renderer = {
      getMoleculeCentroid: vi.fn(() => new THREE.Vector3(5, 5, 5)),
      getMoleculeBounds: vi.fn(() => ({ center: new THREE.Vector3(5, 5, 5), radius: 3.5 })),
      setCameraFocusTarget: vi.fn(),
      animateToFocusedObject: vi.fn(),
      getCanvas: vi.fn(() => document.createElement('canvas')),
      camera: { position: new THREE.Vector3(0, 0, 15) },
      controls: { target: { set: vi.fn() }, update: vi.fn() },
      setHighlight: vi.fn(),
      showForceLine: vi.fn(),
      clearFeedback: vi.fn(),
      getAtomWorldPosition: vi.fn(() => new THREE.Vector3()),
    } as any;
    const stateMachine = {
      getSelectedAtom: vi.fn(() => -1),
      forceIdle: vi.fn(() => ({ action: 'forceIdle' })),
    } as any;
    const inputManager = {
      screenToWorldOnAtomPlane: vi.fn(() => [0, 0, 0]),
    } as any;
    return {
      getPhysics: () => physics,
      getRenderer: () => renderer,
      getStateMachine: () => stateMachine,
      getInputManager: () => inputManager,
      getStatusCtrl: () => null,
      isWorkerActive: () => false,
      sendWorkerInteraction: vi.fn(),
      markAtomInteractionStarted: vi.fn(),
      updateStatus: vi.fn(),
      updateSceneStatus: vi.fn(),
      physics,
      renderer,
    };
  }

  it('startDrag starts normal interaction (no pick-focus interception)', () => {
    const mockDeps = makeMockDispatchDeps();
    const dispatch = createInteractionDispatch(mockDeps);
    dispatch({ action: 'startDrag', atom: 5 } as any);
    expect(mockDeps.physics.startDrag).toHaveBeenCalledWith(5);
  });
});

// ── Paused worker placement visual sync (scene-runtime integration) ──

import { createSceneRuntime } from '../../page/js/runtime/scene-runtime';

describe('paused worker placement calls renderer.updatePositions', () => {
  it('paused + worker active → renderer.updatePositions called after commit', async () => {
    useAppStore.getState().resetTransientState();
    useAppStore.getState().setPlacementActive(true);

    const updatePositions = vi.fn();
    const mockRenderer = {
      setPhysicsRef: vi.fn(),
      updateSceneRadius: vi.fn(),
      recomputeFocusDistance: vi.fn(),
      fitCamera: vi.fn(),
      getMoleculeCentroid: vi.fn(() => new THREE.Vector3(0, 0, 0)),
      getMoleculeBounds: vi.fn(() => ({ center: new THREE.Vector3(0, 0, 0), radius: 3 })),
      setCameraFocusTarget: vi.fn(),
      animateToFocusedObject: vi.fn(),
      getSceneRadius: () => 10,
      camera: { position: new THREE.Vector3(0, 0, 15) },
      updatePositions,
    } as any;

    const mockWorkerRuntime = {
      isActive: () => true,
      appendMolecule: vi.fn(async () => ({ ok: true, sceneVersion: 2, atomOffset: 0, atomsAppended: 1, totalAtomCount: 1 })),
      sendInteraction: vi.fn(),
      getLatestSnapshot: () => ({ positions: new Float64Array(3), velocities: new Float64Array(3), n: 1 }),
      syncStateNow: vi.fn(async () => {}),
    };

    const mockPhysics = {
      n: 1, pos: new Float64Array(3), vel: new Float64Array(3),
      createCheckpoint: vi.fn(() => ({})), restoreCheckpoint: vi.fn(),
      appendMolecule: vi.fn(() => ({ atomOffset: 0, atomsAppended: 1 })),
      assertPostAppendInvariants: vi.fn(), updateWallCenter: vi.fn(), updateWallRadius: vi.fn(),
      getBonds: () => [], updateBondList: vi.fn(), rebuildComponents: vi.fn(),
    } as any;
    mockRenderer.ensureCapacityForAppend = vi.fn();
    mockRenderer.populateAppendedAtoms = vi.fn();

    const scene = createSceneRuntime({
      getPhysics: () => mockPhysics,
      getRenderer: () => mockRenderer,
      getStateMachine: () => ({} as any),
      getPlacement: () => null,
      getStatusCtrl: () => null,
      getWorkerRuntime: () => mockWorkerRuntime as any,
      getInputBindings: () => ({ sync: vi.fn() } as any),
      getSnapshotReconciler: () => null,
      getSession: () => ({
        theme: 'light', textSize: 'normal', isLoading: false, interactionMode: 'atom',
        playback: { selectedSpeed: 1, speedMode: 'fixed', effectiveSpeed: 1, maxSpeed: 1, paused: true },
        scene: { molecules: [], nextId: 1, totalAtoms: 0 },
      }),
      dispatch: vi.fn(),
      fullSchedulerReset: vi.fn(),
      partialProfilerReset: vi.fn(),
      recoverFromWorkerFailure: vi.fn(),
    });

    // commitMolecule triggers the paused-worker visual sync (now async for velocity sync)
    await scene.commitMolecule('c60.xyz', 'C60', [{ x: 0, y: 0, z: 0, element: 'C' }], [], [0, 0, 0]);

    expect(updatePositions).toHaveBeenCalled();
  });

  it('running (not paused) → updatePositions called (shared finalization)', async () => {
    useAppStore.getState().resetTransientState();

    const updatePositions = vi.fn();
    const mockRenderer = {
      setPhysicsRef: vi.fn(), updateSceneRadius: vi.fn(), recomputeFocusDistance: vi.fn(),
      fitCamera: vi.fn(), getMoleculeCentroid: vi.fn(() => new THREE.Vector3(0, 0, 0)),
      getMoleculeBounds: vi.fn(() => ({ center: new THREE.Vector3(0, 0, 0), radius: 3 })),
      setCameraFocusTarget: vi.fn(), animateToFocusedObject: vi.fn(),
      getSceneRadius: () => 10, camera: { position: new THREE.Vector3(0, 0, 15) },
      updatePositions,
    } as any;

    const mockPhysics = {
      n: 1, pos: new Float64Array(3), vel: new Float64Array(3),
      createCheckpoint: vi.fn(() => ({})), restoreCheckpoint: vi.fn(),
      appendMolecule: vi.fn(() => ({ atomOffset: 0, atomsAppended: 1 })),
      assertPostAppendInvariants: vi.fn(), updateWallCenter: vi.fn(), updateWallRadius: vi.fn(),
      getBonds: () => [], updateBondList: vi.fn(), rebuildComponents: vi.fn(),
    } as any;
    mockRenderer.ensureCapacityForAppend = vi.fn();
    mockRenderer.populateAppendedAtoms = vi.fn();

    const scene = createSceneRuntime({
      getPhysics: () => mockPhysics,
      getRenderer: () => mockRenderer,
      getStateMachine: () => ({} as any),
      getPlacement: () => null, getStatusCtrl: () => null,
      getWorkerRuntime: () => ({ isActive: () => true, appendMolecule: vi.fn(async () => ({ ok: true })), sendInteraction: vi.fn(), getLatestSnapshot: () => null } as any),
      getInputBindings: () => ({ sync: vi.fn() } as any),
      getSnapshotReconciler: () => null,
      getSession: () => ({
        theme: 'light', textSize: 'normal', isLoading: false, interactionMode: 'atom',
        playback: { selectedSpeed: 1, speedMode: 'fixed', effectiveSpeed: 1, maxSpeed: 1, paused: false },
        scene: { molecules: [], nextId: 1, totalAtoms: 0 },
      }),
      dispatch: vi.fn(), fullSchedulerReset: vi.fn(), partialProfilerReset: vi.fn(),
      recoverFromWorkerFailure: vi.fn(),
    });

    await scene.commitMolecule('c60.xyz', 'C60', [{ x: 0, y: 0, z: 0, element: 'C' }], [], [0, 0, 0]);

    expect(updatePositions).toHaveBeenCalled();
  });

  it('paused + worker active → pre-append copies worker velocities to local physics', async () => {
    useAppStore.getState().resetTransientState();
    useAppStore.getState().setPlacementActive(true);

    const updatePositions = vi.fn();
    const mockRenderer = {
      setPhysicsRef: vi.fn(), updateSceneRadius: vi.fn(), recomputeFocusDistance: vi.fn(),
      fitCamera: vi.fn(), getMoleculeCentroid: vi.fn(() => new THREE.Vector3(0, 0, 0)),
      getMoleculeBounds: vi.fn(() => ({ center: new THREE.Vector3(0, 0, 0), radius: 3 })),
      setCameraFocusTarget: vi.fn(), animateToFocusedObject: vi.fn(),
      getSceneRadius: () => 10, camera: { position: new THREE.Vector3(0, 0, 15) },
      updatePositions, ensureCapacityForAppend: vi.fn(), populateAppendedAtoms: vi.fn(),
    } as any;

    // Local physics has stale velocity (0,0,0)
    const localVel = new Float64Array([0, 0, 0]);
    // Worker snapshot has authoritative velocity (1,2,3)
    const workerVel = new Float64Array([1, 2, 3]);

    const mockPhysics = {
      n: 1, pos: new Float64Array(3), vel: localVel,
      createCheckpoint: vi.fn(() => ({})), restoreCheckpoint: vi.fn(),
      appendMolecule: vi.fn(() => ({ atomOffset: 0, atomsAppended: 1 })),
      assertPostAppendInvariants: vi.fn(), updateWallCenter: vi.fn(), updateWallRadius: vi.fn(),
      getBonds: () => [], updateBondList: vi.fn(), rebuildComponents: vi.fn(),
    } as any;

    const syncStateNow = vi.fn(async () => {});
    const mockWorkerRuntime = {
      isActive: () => true,
      appendMolecule: vi.fn(async () => ({ ok: true })),
      sendInteraction: vi.fn(),
      getLatestSnapshot: () => ({ positions: new Float64Array(3), velocities: workerVel, n: 1 }),
      syncStateNow,
    };

    const scene = createSceneRuntime({
      getPhysics: () => mockPhysics,
      getRenderer: () => mockRenderer,
      getStateMachine: () => ({} as any),
      getPlacement: () => null, getStatusCtrl: () => null,
      getWorkerRuntime: () => mockWorkerRuntime as any,
      getInputBindings: () => ({ sync: vi.fn() } as any),
      getSnapshotReconciler: () => null,
      getSession: () => ({
        theme: 'light', textSize: 'normal', isLoading: false, interactionMode: 'atom',
        playback: { selectedSpeed: 1, speedMode: 'fixed', effectiveSpeed: 1, maxSpeed: 1, paused: true },
        scene: { molecules: [], nextId: 1, totalAtoms: 0 },
      }),
      dispatch: vi.fn(), fullSchedulerReset: vi.fn(), partialProfilerReset: vi.fn(),
      recoverFromWorkerFailure: vi.fn(),
    });

    await scene.commitMolecule('c60.xyz', 'C60', [{ x: 0, y: 0, z: 0, element: 'C' }], [], [0, 0, 0]);

    // syncStateNow was awaited before append
    expect(syncStateNow).toHaveBeenCalled();
    // Local physics.vel should now have the worker's authoritative velocity
    expect(localVel[0]).toBe(1);
    expect(localVel[1]).toBe(2);
    expect(localVel[2]).toBe(3);
  });

  it('failed addMoleculeToScene does NOT call finalization', async () => {
    useAppStore.getState().resetTransientState();

    const updatePositions = vi.fn();
    const setPhysicsRef = vi.fn();
    const mockRenderer = {
      setPhysicsRef, updateSceneRadius: vi.fn(), recomputeFocusDistance: vi.fn(),
      fitCamera: vi.fn(), updatePositions,
      ensureCapacityForAppend: vi.fn(), populateAppendedAtoms: vi.fn(),
    } as any;

    const mockPhysics = { n: 0, pos: new Float64Array(0), vel: new Float64Array(0) } as any;

    // Mock loadStructure to reject
    const origLoadStructure = await import('../../page/js/loader');
    const loadSpy = vi.spyOn(origLoadStructure, 'loadStructure').mockRejectedValue(new Error('test load failure'));

    const scene = createSceneRuntime({
      getPhysics: () => mockPhysics,
      getRenderer: () => mockRenderer,
      getStateMachine: () => ({} as any),
      getPlacement: () => null, getStatusCtrl: () => null,
      getWorkerRuntime: () => null,
      getInputBindings: () => null,
      getSnapshotReconciler: () => null,
      getSession: () => ({
        theme: 'light', textSize: 'normal', isLoading: false, interactionMode: 'atom',
        playback: { selectedSpeed: 1, speedMode: 'fixed', effectiveSpeed: 1, maxSpeed: 1, paused: false },
        scene: { molecules: [], nextId: 1, totalAtoms: 0 },
      }),
      dispatch: vi.fn(), fullSchedulerReset: vi.fn(), partialProfilerReset: vi.fn(),
      recoverFromWorkerFailure: vi.fn(),
    });

    await scene.addMoleculeToScene('nonexistent.xyz', 'Test', [0, 0, 0]);

    expect(setPhysicsRef).not.toHaveBeenCalled();
    expect(updatePositions).not.toHaveBeenCalled();

    loadSpy.mockRestore();
  });
});
