/**
 * Runtime-level tests for focus-runtime.ts focus policy helpers.
 *
 * Tests the actual molecule lookup, centroid resolution, and store updates
 * that happen when interaction or placement triggers a focus change.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as THREE from 'three';
import { useAppStore } from '../../page/js/store/app-store';
import {
  focusMoleculeByAtom,
  focusNewestPlacedMolecule,
  findMoleculeForAtom,
} from '../../page/js/runtime/focus-runtime';

function mockRenderer(centroid: THREE.Vector3 | null = new THREE.Vector3(1, 2, 3)) {
  return {
    getMoleculeCentroid: vi.fn(() => centroid),
    getMoleculeBounds: vi.fn(() => centroid ? { center: centroid, radius: 3.5 } : null),
    setCameraFocusTarget: vi.fn(),
    animateToFocusedObject: vi.fn(),
    camera: { position: new THREE.Vector3(0, 0, 15) },
  };
}

describe('findMoleculeForAtom', () => {
  const molecules = [
    { id: 1, name: 'A', structureFile: 'a.xyz', atomCount: 60, atomOffset: 0 },
    { id: 2, name: 'B', structureFile: 'b.xyz', atomCount: 40, atomOffset: 60 },
  ];

  it('finds the correct molecule for an atom in the first molecule', () => {
    expect(findMoleculeForAtom(0, molecules)?.id).toBe(1);
    expect(findMoleculeForAtom(59, molecules)?.id).toBe(1);
  });

  it('finds the correct molecule for an atom in the second molecule', () => {
    expect(findMoleculeForAtom(60, molecules)?.id).toBe(2);
    expect(findMoleculeForAtom(99, molecules)?.id).toBe(2);
  });

  it('returns null for an atom outside any molecule range', () => {
    expect(findMoleculeForAtom(100, molecules)).toBeNull();
    expect(findMoleculeForAtom(-1, molecules)).toBeNull();
  });

  it('returns null for empty molecule list', () => {
    expect(findMoleculeForAtom(0, [])).toBeNull();
  });
});

describe('focusMoleculeByAtom', () => {
  beforeEach(() => {
    useAppStore.getState().resetTransientState();
    useAppStore.getState().setMolecules([
      { id: 10, name: 'C60', structureFile: 'c60.xyz', atomCount: 60, atomOffset: 0 },
      { id: 20, name: 'CNT', structureFile: 'cnt.xyz', atomCount: 100, atomOffset: 60 },
    ]);
  });

  it('calls setCameraFocusTarget with molecule centroid', () => {
    const r = mockRenderer(new THREE.Vector3(5, 6, 7));
    focusMoleculeByAtom(30, r);
    expect(r.getMoleculeCentroid).toHaveBeenCalledWith(0, 60);
    expect(r.setCameraFocusTarget).toHaveBeenCalledWith(new THREE.Vector3(5, 6, 7));
  });

  it('sets lastFocusedMoleculeId to the correct molecule', () => {
    const r = mockRenderer();
    focusMoleculeByAtom(30, r);
    expect(useAppStore.getState().lastFocusedMoleculeId).toBe(10);
  });

  it('finds the second molecule for higher atom indices', () => {
    const r = mockRenderer();
    focusMoleculeByAtom(80, r);
    expect(r.getMoleculeCentroid).toHaveBeenCalledWith(60, 100);
    expect(useAppStore.getState().lastFocusedMoleculeId).toBe(20);
  });

  it('no-ops when atom is outside any molecule range', () => {
    const r = mockRenderer();
    focusMoleculeByAtom(200, r);
    expect(r.setCameraFocusTarget).not.toHaveBeenCalled();
    expect(useAppStore.getState().lastFocusedMoleculeId).toBeNull();
  });

  it('no-ops when centroid is null (physics unavailable)', () => {
    const r = mockRenderer(null);
    focusMoleculeByAtom(30, r);
    expect(r.setCameraFocusTarget).not.toHaveBeenCalled();
    expect(useAppStore.getState().lastFocusedMoleculeId).toBeNull();
  });
});

describe('focusNewestPlacedMolecule', () => {
  beforeEach(() => {
    useAppStore.getState().resetTransientState();
  });

  it('focuses the last molecule in the list', () => {
    useAppStore.getState().setMolecules([
      { id: 1, name: 'A', structureFile: 'a.xyz', atomCount: 60, atomOffset: 0 },
      { id: 2, name: 'B', structureFile: 'b.xyz', atomCount: 40, atomOffset: 60 },
    ]);
    const r = mockRenderer(new THREE.Vector3(10, 20, 30));
    focusNewestPlacedMolecule(r);
    expect(r.getMoleculeCentroid).toHaveBeenCalledWith(60, 40);
    expect(r.setCameraFocusTarget).toHaveBeenCalledWith(new THREE.Vector3(10, 20, 30));
    expect(useAppStore.getState().lastFocusedMoleculeId).toBe(2);
  });

  it('no-ops when molecule list is empty', () => {
    const r = mockRenderer();
    focusNewestPlacedMolecule(r);
    expect(r.setCameraFocusTarget).not.toHaveBeenCalled();
  });

  it('no-ops when centroid is null', () => {
    useAppStore.getState().setMolecules([
      { id: 1, name: 'A', structureFile: 'a.xyz', atomCount: 60, atomOffset: 0 },
    ]);
    const r = mockRenderer(null);
    focusNewestPlacedMolecule(r);
    expect(r.setCameraFocusTarget).not.toHaveBeenCalled();
    expect(useAppStore.getState().lastFocusedMoleculeId).toBeNull();
  });
});

describe('Scene-runtime caller contracts', () => {
  beforeEach(() => {
    useAppStore.getState().resetTransientState();
  });

  it('placement commit focuses newest molecule only when placementActive is true', () => {
    useAppStore.getState().setMolecules([
      { id: 1, name: 'A', structureFile: 'a.xyz', atomCount: 60, atomOffset: 0 },
    ]);
    useAppStore.getState().setPlacementActive(true);

    const r = mockRenderer(new THREE.Vector3(10, 20, 30));
    // Same guard scene-runtime uses: only focus when placementActive
    if (useAppStore.getState().placementActive) {
      focusNewestPlacedMolecule(r);
    }
    expect(r.setCameraFocusTarget).toHaveBeenCalled();
    expect(useAppStore.getState().lastFocusedMoleculeId).toBe(1);
  });

  it('placement commit does NOT focus when placementActive is false', () => {
    useAppStore.getState().setMolecules([
      { id: 1, name: 'A', structureFile: 'a.xyz', atomCount: 60, atomOffset: 0 },
    ]);

    const r = mockRenderer(new THREE.Vector3(10, 20, 30));
    if (useAppStore.getState().placementActive) {
      focusNewestPlacedMolecule(r);
    }
    expect(r.setCameraFocusTarget).not.toHaveBeenCalled();
    expect(useAppStore.getState().lastFocusedMoleculeId).toBeNull();
  });

  it('clearPlayground path clears lastFocusedMoleculeId', () => {
    useAppStore.getState().setLastFocusedMoleculeId(42);
    expect(useAppStore.getState().lastFocusedMoleculeId).toBe(42);
    useAppStore.getState().setLastFocusedMoleculeId(null);
    expect(useAppStore.getState().lastFocusedMoleculeId).toBeNull();
  });
});
