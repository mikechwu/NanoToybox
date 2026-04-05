/**
 * Tests for per-frame drag target refresh.
 *
 * Verifies that the drag target is reprojected every frame from current
 * atom position + stored screen coords, not just on pointer events.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as THREE from 'three';
import { createDragTargetRefresh, dragRefreshAction, type DragTargetRefresh } from '../../lab/js/runtime/drag-target-refresh';

function mockPhysics(dragAtom = 0) {
  return {
    dragAtom,
    updateDrag: vi.fn(),
  };
}

function mockRenderer(atomPos = new THREE.Vector3(5, 5, 5), atomCount = 10) {
  return {
    getAtomWorldPosition: vi.fn(() => atomPos),
    getAtomCount: vi.fn(() => atomCount),
    showForceLine: vi.fn(),
  } as any;
}

function mockInputManager(worldTarget = [10, 20, 30]) {
  return {
    screenToWorldOnAtomPlane: vi.fn(() => worldTarget),
  } as any;
}

describe('DragTargetRefresh', () => {
  let refresh: DragTargetRefresh;

  beforeEach(() => {
    refresh = createDragTargetRefresh();
  });

  it('starts inactive', () => {
    expect(refresh.isActive()).toBe(false);
  });

  it('does nothing when inactive', () => {
    const physics = mockPhysics();
    const renderer = mockRenderer();
    const im = mockInputManager();
    expect(refresh.refresh(physics, renderer, im)).toBe(false);
    expect(physics.updateDrag).not.toHaveBeenCalled();
  });

  it('does nothing when active but no pointer tracked', () => {
    refresh.activate();
    const physics = mockPhysics();
    const renderer = mockRenderer();
    const im = mockInputManager();
    expect(refresh.refresh(physics, renderer, im)).toBe(false);
  });

  it('refreshes target when active with pointer', () => {
    refresh.activate();
    refresh.updatePointer(100, 200);
    const physics = mockPhysics();
    const renderer = mockRenderer();
    const im = mockInputManager([15, 25, 35]);

    expect(refresh.refresh(physics, renderer, im)).toBe(true);

    expect(im.screenToWorldOnAtomPlane).toHaveBeenCalledWith(100, 200, expect.any(THREE.Vector3));
    expect(physics.updateDrag).toHaveBeenCalledWith(15, 25, 35);
    expect(renderer.showForceLine).toHaveBeenCalledWith(0, 15, 25, 35);
  });

  it('deactivate clears state', () => {
    refresh.activate();
    refresh.updatePointer(100, 200);
    refresh.deactivate();

    expect(refresh.isActive()).toBe(false);

    const physics = mockPhysics();
    const renderer = mockRenderer();
    const im = mockInputManager();
    expect(refresh.refresh(physics, renderer, im)).toBe(false);
  });

  // ── Exit path coverage ──

  it('deactivation after cancelInteraction stops refresh', () => {
    refresh.activate();
    refresh.updatePointer(50, 60);
    // Simulate cancelInteraction → deactivate
    refresh.deactivate();
    expect(refresh.isActive()).toBe(false);
    expect(refresh.refresh(mockPhysics(), mockRenderer(), mockInputManager())).toBe(false);
  });

  it('deactivation after forceIdle stops refresh', () => {
    refresh.activate();
    refresh.updatePointer(50, 60);
    // Simulate forceIdle → deactivate
    refresh.deactivate();
    expect(refresh.isActive()).toBe(false);
    expect(refresh.refresh(mockPhysics(), mockRenderer(), mockInputManager())).toBe(false);
  });

  // ── Invalid atom guard ──

  it('auto-deactivates when dragAtom exceeds atom count', () => {
    refresh.activate();
    refresh.updatePointer(100, 200);
    const physics = mockPhysics(50); // atom 50
    const renderer = mockRenderer(new THREE.Vector3(5, 5, 5), 10); // only 10 atoms

    expect(refresh.refresh(physics, renderer, mockInputManager())).toBe(false);
    expect(refresh.isActive()).toBe(false); // auto-deactivated
  });

  it('auto-deactivates when dragAtom becomes -1 (physics cleared drag)', () => {
    refresh.activate();
    refresh.updatePointer(100, 200);
    const physics = mockPhysics(-1); // physics cleared the drag internally

    expect(refresh.refresh(physics, mockRenderer(), mockInputManager())).toBe(false);
    expect(refresh.isActive()).toBe(false); // auto-deactivated
  });

  it('keeps working when dragAtom is within range', () => {
    refresh.activate();
    refresh.updatePointer(100, 200);
    const physics = mockPhysics(5); // atom 5
    const renderer = mockRenderer(new THREE.Vector3(5, 5, 5), 10); // 10 atoms

    expect(refresh.refresh(physics, renderer, mockInputManager())).toBe(true);
  });

  // ── Worker mirroring lifecycle ──

  it('mirrors to worker on each frame while active', () => {
    refresh.activate();
    refresh.updatePointer(100, 200);
    const sendWorker = vi.fn();
    const physics = mockPhysics();
    const renderer = mockRenderer();
    const im = mockInputManager([7, 8, 9]);

    // Frame 1
    refresh.refresh(physics, renderer, im, sendWorker);
    expect(sendWorker).toHaveBeenCalledTimes(1);

    // Frame 2
    refresh.refresh(physics, renderer, im, sendWorker);
    expect(sendWorker).toHaveBeenCalledTimes(2);

    // Frame 3
    refresh.refresh(physics, renderer, im, sendWorker);
    expect(sendWorker).toHaveBeenCalledTimes(3);
  });

  it('stops worker mirroring after deactivate', () => {
    refresh.activate();
    refresh.updatePointer(100, 200);
    const sendWorker = vi.fn();
    const physics = mockPhysics();
    const renderer = mockRenderer();
    const im = mockInputManager([7, 8, 9]);

    refresh.refresh(physics, renderer, im, sendWorker);
    expect(sendWorker).toHaveBeenCalledTimes(1);

    refresh.deactivate();

    refresh.refresh(physics, renderer, im, sendWorker);
    expect(sendWorker).toHaveBeenCalledTimes(1); // no new call
  });

  it('does not mirror to worker when callback is undefined', () => {
    refresh.activate();
    refresh.updatePointer(100, 200);
    const physics = mockPhysics();
    const renderer = mockRenderer();
    const im = mockInputManager([7, 8, 9]);

    refresh.refresh(physics, renderer, im, undefined);
    expect(physics.updateDrag).toHaveBeenCalled();
  });

  // ── Regression: atom moves while pointer held still ──

  it('world target changes when atom moves even if pointer is still', () => {
    refresh.activate();
    refresh.updatePointer(100, 200);

    // Frame 1: atom at (5,5,5), target resolves to (10,20,30)
    const physics = mockPhysics();
    const renderer1 = mockRenderer(new THREE.Vector3(5, 5, 5));
    const im1 = mockInputManager([10, 20, 30]);
    refresh.refresh(physics, renderer1, im1);
    expect(physics.updateDrag).toHaveBeenCalledWith(10, 20, 30);

    // Frame 2: atom moved to (8,8,8), same screen coords but different projection
    physics.updateDrag.mockClear();
    const renderer2 = mockRenderer(new THREE.Vector3(8, 8, 8));
    const im2 = mockInputManager([12, 22, 32]);
    refresh.refresh(physics, renderer2, im2);
    expect(physics.updateDrag).toHaveBeenCalledWith(12, 22, 32);

    // The world target changed even though pointer didn't move
    expect(im2.screenToWorldOnAtomPlane).toHaveBeenCalledWith(100, 200, expect.any(THREE.Vector3));
  });
});

// ── dragRefreshAction wiring map ──

describe('dragRefreshAction', () => {
  it('maps start actions to activate', () => {
    expect(dragRefreshAction('startDrag')).toBe('activate');
    expect(dragRefreshAction('startMove')).toBe('activate');
    expect(dragRefreshAction('startRotate')).toBe('activate');
  });

  it('maps update actions to update-pointer', () => {
    expect(dragRefreshAction('updateDrag')).toBe('update-pointer');
    expect(dragRefreshAction('updateMove')).toBe('update-pointer');
    expect(dragRefreshAction('updateRotate')).toBe('update-pointer');
  });

  it('maps end/cancel/force actions to deactivate', () => {
    expect(dragRefreshAction('endDrag')).toBe('deactivate');
    expect(dragRefreshAction('endMove')).toBe('deactivate');
    expect(dragRefreshAction('endRotate')).toBe('deactivate');
    expect(dragRefreshAction('flick')).toBe('deactivate');
    expect(dragRefreshAction('cancelInteraction')).toBe('deactivate');
    expect(dragRefreshAction('forceIdle')).toBe('deactivate');
  });

  it('returns null for unrelated actions', () => {
    expect(dragRefreshAction('highlight')).toBeNull();
    expect(dragRefreshAction('hover')).toBeNull();
  });
});
