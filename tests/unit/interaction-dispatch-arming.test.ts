/**
 * @vitest-environment jsdom
 */
/**
 * Tests that interaction-dispatch arms timeline recording on atom
 * interaction commands, regardless of worker state.
 *
 * This directly tests the real createInteractionDispatch function to
 * verify that markAtomInteractionStarted fires on startDrag, startMove,
 * startRotate, and flick — and does NOT fire on updateDrag, endDrag,
 * or other continuation events.
 *
 * Pins the regression where arming was inside the isWorkerActive() branch,
 * causing sync/local mode to never arm recording.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as THREE from 'three';
import { createInteractionDispatch } from '../../lab/js/runtime/interaction-dispatch';
import { useAppStore } from '../../lab/js/store/app-store';

function makeDeps(workerActive = false) {
  const physics = {
    startDrag: vi.fn(),
    endDrag: vi.fn(),
    startTranslate: vi.fn(),
    startRotateDrag: vi.fn(),
    updateDrag: vi.fn(),
    applyImpulse: vi.fn(),
  } as any;

  const renderer = {
    setHighlight: vi.fn(),
    showForceLine: vi.fn(),
    clearFeedback: vi.fn(),
    getAtomWorldPosition: vi.fn(() => new THREE.Vector3()),
    getMoleculeCentroid: vi.fn(() => new THREE.Vector3()),
    getMoleculeBounds: vi.fn(() => ({ center: new THREE.Vector3(), radius: 3.5 })),
    setCameraFocusTarget: vi.fn(),
    animateToFocusedObject: vi.fn(),
    camera: { position: new THREE.Vector3(0, 0, 15) },
    controls: { target: { set: vi.fn() }, update: vi.fn() },
  } as any;

  const stateMachine = {
    getSelectedAtom: vi.fn(() => 0),
    forceIdle: vi.fn(() => ({ action: 'forceIdle' })),
  } as any;

  const inputManager = {
    screenToWorldOnAtomPlane: vi.fn(() => [1, 2, 3]),
  } as any;

  const markAtomInteractionStarted = vi.fn();
  const sendWorkerInteraction = vi.fn();

  return {
    getPhysics: () => physics,
    getRenderer: () => renderer,
    getStateMachine: () => stateMachine,
    getInputManager: () => inputManager,
    isWorkerActive: () => workerActive,
    sendWorkerInteraction,
    markAtomInteractionStarted,
    updateStatus: vi.fn(),
    updateSceneStatus: vi.fn(),
    // Expose for assertions
    physics,
    renderer,
  };
}

describe('interaction-dispatch arming', () => {
  beforeEach(() => {
    useAppStore.getState().resetTransientState();
    useAppStore.getState().setMolecules([
      { id: 1, name: 'C60', structureFile: 'c60.xyz', atomCount: 60, atomOffset: 0 },
    ]);
  });

  // ── Arming actions: must arm regardless of worker state ──

  it('startDrag arms recording when worker is INACTIVE', () => {
    const deps = makeDeps(false);
    const dispatch = createInteractionDispatch(deps);
    dispatch({ action: 'startDrag', atom: 0 } as any);
    expect(deps.markAtomInteractionStarted).toHaveBeenCalledTimes(1);
  });

  it('startDrag arms recording when worker is ACTIVE', () => {
    const deps = makeDeps(true);
    const dispatch = createInteractionDispatch(deps);
    dispatch({ action: 'startDrag', atom: 0 } as any);
    expect(deps.markAtomInteractionStarted).toHaveBeenCalledTimes(1);
  });

  it('startMove arms recording when worker is inactive', () => {
    const deps = makeDeps(false);
    const dispatch = createInteractionDispatch(deps);
    dispatch({ action: 'startMove', atom: 0 } as any);
    expect(deps.markAtomInteractionStarted).toHaveBeenCalledTimes(1);
  });

  it('startRotate arms recording when worker is inactive', () => {
    const deps = makeDeps(false);
    const dispatch = createInteractionDispatch(deps);
    dispatch({ action: 'startRotate', atom: 0 } as any);
    expect(deps.markAtomInteractionStarted).toHaveBeenCalledTimes(1);
  });

  it('flick arms recording when worker is inactive', () => {
    const deps = makeDeps(false);
    const dispatch = createInteractionDispatch(deps);
    dispatch({ action: 'flick', atom: 0, vx: 10, vy: 5 } as any);
    expect(deps.markAtomInteractionStarted).toHaveBeenCalledTimes(1);
  });

  it('flick arms recording when worker is active', () => {
    const deps = makeDeps(true);
    const dispatch = createInteractionDispatch(deps);
    dispatch({ action: 'flick', atom: 0, vx: 10, vy: 5 } as any);
    expect(deps.markAtomInteractionStarted).toHaveBeenCalledTimes(1);
  });

  // ── Continuation events: must NOT arm ──

  it('updateDrag does not arm recording', () => {
    const deps = makeDeps(false);
    const dispatch = createInteractionDispatch(deps);
    dispatch({ action: 'updateDrag', screenX: 100, screenY: 200 } as any);
    expect(deps.markAtomInteractionStarted).not.toHaveBeenCalled();
  });

  it('endDrag does not arm recording', () => {
    const deps = makeDeps(false);
    const dispatch = createInteractionDispatch(deps);
    dispatch({ action: 'endDrag' } as any);
    expect(deps.markAtomInteractionStarted).not.toHaveBeenCalled();
  });

  it('updateMove does not arm recording', () => {
    const deps = makeDeps(false);
    const dispatch = createInteractionDispatch(deps);
    dispatch({ action: 'updateMove', screenX: 100, screenY: 200 } as any);
    expect(deps.markAtomInteractionStarted).not.toHaveBeenCalled();
  });

  it('endMove does not arm recording', () => {
    const deps = makeDeps(false);
    const dispatch = createInteractionDispatch(deps);
    dispatch({ action: 'endMove' } as any);
    expect(deps.markAtomInteractionStarted).not.toHaveBeenCalled();
  });

  it('updateRotate does not arm recording', () => {
    const deps = makeDeps(false);
    const dispatch = createInteractionDispatch(deps);
    dispatch({ action: 'updateRotate', screenX: 100, screenY: 200 } as any);
    expect(deps.markAtomInteractionStarted).not.toHaveBeenCalled();
  });

  it('endRotate does not arm recording', () => {
    const deps = makeDeps(false);
    const dispatch = createInteractionDispatch(deps);
    dispatch({ action: 'endRotate' } as any);
    expect(deps.markAtomInteractionStarted).not.toHaveBeenCalled();
  });

  it('highlight does not arm recording', () => {
    const deps = makeDeps(false);
    const dispatch = createInteractionDispatch(deps);
    dispatch({ action: 'highlight', atom: 5 } as any);
    expect(deps.markAtomInteractionStarted).not.toHaveBeenCalled();
  });

  it('clearHighlight does not arm recording', () => {
    const deps = makeDeps(false);
    const dispatch = createInteractionDispatch(deps);
    dispatch({ action: 'clearHighlight' } as any);
    expect(deps.markAtomInteractionStarted).not.toHaveBeenCalled();
  });

  // ── Worker mirroring still works independently of arming ──

  it('startDrag mirrors to worker when active (arming is separate)', () => {
    const deps = makeDeps(true);
    const dispatch = createInteractionDispatch(deps);
    dispatch({ action: 'startDrag', atom: 3 } as any);
    expect(deps.markAtomInteractionStarted).toHaveBeenCalledTimes(1);
    expect(deps.sendWorkerInteraction).toHaveBeenCalledWith({
      type: 'startDrag', atomIndex: 3, mode: 'atom',
    });
  });

  it('startDrag does not mirror to worker when inactive (arming still fires)', () => {
    const deps = makeDeps(false);
    const dispatch = createInteractionDispatch(deps);
    dispatch({ action: 'startDrag', atom: 3 } as any);
    expect(deps.markAtomInteractionStarted).toHaveBeenCalledTimes(1);
    expect(deps.sendWorkerInteraction).not.toHaveBeenCalled();
  });
});
