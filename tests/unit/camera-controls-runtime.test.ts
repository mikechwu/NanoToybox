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

  it('clears pickFocusActive when pick-focus is active', () => {
    useAppStore.getState().setPickFocusActive(true);
    const overlay = createOverlayRuntime({ getStatusCtrl: () => null });
    overlay.close();
    expect(useAppStore.getState().pickFocusActive).toBe(false);
  });

  it('clears both cameraHelpOpen and pickFocusActive together', () => {
    useAppStore.getState().setCameraHelpOpen(true);
    useAppStore.getState().setPickFocusActive(true);
    const overlay = createOverlayRuntime({ getStatusCtrl: () => null });
    overlay.close();
    expect(useAppStore.getState().cameraHelpOpen).toBe(false);
    expect(useAppStore.getState().pickFocusActive).toBe(false);
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
  let mockRenderer: { getMoleculeCentroid: any; setCameraFocusTarget: any };

  beforeEach(() => {
    useAppStore.getState().resetTransientState();
    mockRenderer = {
      getMoleculeCentroid: vi.fn(() => new THREE.Vector3(1, 2, 3)),
      setCameraFocusTarget: vi.fn(),
    };
  });

  it('zero molecules: no-op, no pick-focus', () => {
    useAppStore.getState().setMolecules([]);
    handleCenterObject(mockRenderer);
    expect(useAppStore.getState().pickFocusActive).toBe(false);
    expect(mockRenderer.setCameraFocusTarget).not.toHaveBeenCalled();
  });

  it('one molecule: direct center, no pick-focus', () => {
    useAppStore.getState().setMolecules([
      { id: 1, name: 'C60', structureFile: 'c60.xyz', atomCount: 60, atomOffset: 0 },
    ]);
    handleCenterObject(mockRenderer);
    expect(useAppStore.getState().pickFocusActive).toBe(false);
    expect(mockRenderer.setCameraFocusTarget).toHaveBeenCalled();
    expect(useAppStore.getState().lastFocusedMoleculeId).toBe(1);
  });

  it('valid last-focused molecule: direct center, no pick-focus', () => {
    useAppStore.getState().setMolecules([
      { id: 1, name: 'C60', structureFile: 'c60.xyz', atomCount: 60, atomOffset: 0 },
      { id: 2, name: 'CNT', structureFile: 'cnt.xyz', atomCount: 100, atomOffset: 60 },
    ]);
    useAppStore.getState().setLastFocusedMoleculeId(2);
    handleCenterObject(mockRenderer);
    expect(useAppStore.getState().pickFocusActive).toBe(false);
    expect(mockRenderer.setCameraFocusTarget).toHaveBeenCalled();
    expect(mockRenderer.getMoleculeCentroid).toHaveBeenCalledWith(60, 100);
  });

  it('multiple molecules, no valid focus: enters pick-focus', () => {
    useAppStore.getState().setMolecules([
      { id: 1, name: 'C60', structureFile: 'c60.xyz', atomCount: 60, atomOffset: 0 },
      { id: 2, name: 'CNT', structureFile: 'cnt.xyz', atomCount: 100, atomOffset: 60 },
    ]);
    handleCenterObject(mockRenderer);
    expect(useAppStore.getState().pickFocusActive).toBe(true);
    expect(mockRenderer.setCameraFocusTarget).not.toHaveBeenCalled();
  });

  it('multiple molecules, stale focused ID: enters pick-focus', () => {
    useAppStore.getState().setMolecules([
      { id: 1, name: 'C60', structureFile: 'c60.xyz', atomCount: 60, atomOffset: 0 },
      { id: 2, name: 'CNT', structureFile: 'cnt.xyz', atomCount: 100, atomOffset: 60 },
    ]);
    useAppStore.getState().setLastFocusedMoleculeId(99);
    handleCenterObject(mockRenderer);
    expect(useAppStore.getState().pickFocusActive).toBe(true);
    expect(mockRenderer.setCameraFocusTarget).not.toHaveBeenCalled();
  });
});

// ── Pick-focus interception in interaction-dispatch ──

import { createInteractionDispatch } from '../../page/js/runtime/interaction-dispatch';

describe('interaction-dispatch pick-focus interception', () => {
  beforeEach(() => {
    useAppStore.getState().resetTransientState();
    useAppStore.getState().setMolecules([
      { id: 1, name: 'C60', structureFile: 'c60.xyz', atomCount: 60, atomOffset: 0 },
    ]);
  });

  function makeMockDispatchDeps() {
    // Stable mock instances — same objects returned on every getter call
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
      setCameraFocusTarget: vi.fn(),
      getCanvas: vi.fn(() => document.createElement('canvas')),
      camera: {},
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
      updateStatus: vi.fn(),
      updateSceneStatus: vi.fn(),
      physics,
      renderer,
    };
  }

  it('intercepts startDrag when pickFocusActive and clears the flag', () => {
    useAppStore.getState().setPickFocusActive(true);
    const mockDeps = makeMockDispatchDeps();
    const dispatch = createInteractionDispatch(mockDeps);
    const result = dispatch({ action: 'startDrag', atom: 30 } as any);
    // Pick-focus consumed the command
    expect(useAppStore.getState().pickFocusActive).toBe(false);
    expect(useAppStore.getState().lastFocusedMoleculeId).toBe(1);
    expect(mockDeps.renderer.setCameraFocusTarget).toHaveBeenCalled();
    // Normal interaction did NOT start (stable mock — same instance)
    expect(mockDeps.physics.startDrag).not.toHaveBeenCalled();
    expect(result.dragTarget).toBeNull();
  });

  it('intercepts startMove when pickFocusActive', () => {
    useAppStore.getState().setPickFocusActive(true);
    const mockDeps = makeMockDispatchDeps();
    const dispatch = createInteractionDispatch(mockDeps);
    dispatch({ action: 'startMove', atom: 5 } as any);
    expect(useAppStore.getState().pickFocusActive).toBe(false);
    expect(mockDeps.physics.startTranslate).not.toHaveBeenCalled();
  });

  it('intercepts startRotate when pickFocusActive', () => {
    useAppStore.getState().setPickFocusActive(true);
    const mockDeps = makeMockDispatchDeps();
    const dispatch = createInteractionDispatch(mockDeps);
    dispatch({ action: 'startRotate', atom: 10 } as any);
    expect(useAppStore.getState().pickFocusActive).toBe(false);
    expect(mockDeps.physics.startRotateDrag).not.toHaveBeenCalled();
  });

  it('does NOT intercept when pickFocusActive is false — normal interaction starts', () => {
    // pickFocusActive defaults to false after reset
    const mockDeps = makeMockDispatchDeps();
    const dispatch = createInteractionDispatch(mockDeps);
    dispatch({ action: 'startDrag', atom: 5 } as any);
    // Normal interaction should have started (same stable physics mock)
    expect(mockDeps.physics.startDrag).toHaveBeenCalledWith(5);
    expect(useAppStore.getState().pickFocusActive).toBe(false);
  });
});
