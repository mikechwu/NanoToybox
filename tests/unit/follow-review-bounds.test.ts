/**
 * Tests that orbit-follow uses display-aware bounds (review or live).
 *
 * Imports the real updateOrbitFollowFromStore helper from
 * runtime/orbit-follow-update.ts to test the shipped follow-loop path.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as THREE from 'three';
import { useAppStore } from '../../page/js/store/app-store';
import { updateOrbitFollowFromStore } from '../../page/js/runtime/orbit-follow-update';

describe('orbit-follow uses displayed bounds (real helper)', () => {
  beforeEach(() => {
    useAppStore.getState().resetTransientState();
  });

  it('calls getDisplayedMoleculeBounds, not getMoleculeBounds', () => {
    useAppStore.getState().setMolecules([
      { id: 1, name: 'C60', structureFile: 'c60.xyz', atomCount: 60, atomOffset: 0 },
    ]);
    useAppStore.getState().setLastFocusedMoleculeId(1);
    useAppStore.getState().setOrbitFollowEnabled(true);

    const renderer = {
      getMoleculeBounds: vi.fn(() => ({ center: new THREE.Vector3(1, 2, 3), radius: 5 })),
      getDisplayedMoleculeBounds: vi.fn(() => ({ center: new THREE.Vector3(10, 20, 30), radius: 5 })),
      updateOrbitFollow: vi.fn(),
    };

    updateOrbitFollowFromStore(renderer, 16);

    expect(renderer.getDisplayedMoleculeBounds).toHaveBeenCalledWith(0, 60);
    expect(renderer.getMoleculeBounds).not.toHaveBeenCalled();
    expect(renderer.updateOrbitFollow).toHaveBeenCalledWith(16, expect.objectContaining({
      center: expect.objectContaining({ x: 10, y: 20, z: 30 }),
    }));
  });

  it('review bounds differ from live bounds', () => {
    useAppStore.getState().setMolecules([
      { id: 1, name: 'C60', structureFile: 'c60.xyz', atomCount: 60, atomOffset: 0 },
    ]);
    useAppStore.getState().setLastFocusedMoleculeId(1);
    useAppStore.getState().setOrbitFollowEnabled(true);

    const renderer = {
      getDisplayedMoleculeBounds: vi.fn(() => ({ center: new THREE.Vector3(100, 200, 300), radius: 5 })),
      updateOrbitFollow: vi.fn(),
    };

    updateOrbitFollowFromStore(renderer, 16);

    const passedBounds = renderer.updateOrbitFollow.mock.calls[0][1];
    expect(passedBounds.center.x).toBe(100);
    expect(passedBounds.center.y).toBe(200);
  });

  it('does nothing when follow is off', () => {
    useAppStore.getState().setMolecules([
      { id: 1, name: 'C60', structureFile: 'c60.xyz', atomCount: 60, atomOffset: 0 },
    ]);
    useAppStore.getState().setLastFocusedMoleculeId(1);

    const renderer = {
      getDisplayedMoleculeBounds: vi.fn(),
      updateOrbitFollow: vi.fn(),
    };

    updateOrbitFollowFromStore(renderer, 16);
    expect(renderer.getDisplayedMoleculeBounds).not.toHaveBeenCalled();
  });

  it('does nothing when no focused molecule', () => {
    useAppStore.getState().setMolecules([
      { id: 1, name: 'C60', structureFile: 'c60.xyz', atomCount: 60, atomOffset: 0 },
    ]);
    useAppStore.getState().setOrbitFollowEnabled(true);
    // lastFocusedMoleculeId is null

    const renderer = {
      getDisplayedMoleculeBounds: vi.fn(),
      updateOrbitFollow: vi.fn(),
    };

    updateOrbitFollowFromStore(renderer, 16);
    expect(renderer.updateOrbitFollow).not.toHaveBeenCalled();
  });
});
