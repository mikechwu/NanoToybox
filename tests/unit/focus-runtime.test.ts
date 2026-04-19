/**
 * Runtime-level tests for focus-runtime.ts focus policy helpers.
 *
 * Tests the actual molecule lookup, centroid resolution, and store updates
 * that happen when interaction or placement triggers a focus change.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as THREE from 'three';
import { useAppStore } from '../../lab/js/store/app-store';
import {
  focusMoleculeByAtom,
  findMoleculeForAtom,
  resolveReturnTarget,
} from '../../lab/js/runtime/camera/focus-runtime';

function mockRenderer(centroid: THREE.Vector3 | null = new THREE.Vector3(1, 2, 3)) {
  const bounds = centroid ? { center: centroid, radius: 3.5 } : null;
  return {
    getDisplayedMoleculeCentroid: vi.fn(() => centroid),
    getDisplayedMoleculeBounds: vi.fn(() => bounds),
    getDisplayedAtomWorldPosition: vi.fn((i: number) => centroid ? new THREE.Vector3(i, 0, 0) : null),
    setCameraFocusTarget: vi.fn(),
    animateToFocusedObject: vi.fn(),
    animateToFramedTarget: vi.fn(),
    camera: { position: new THREE.Vector3(0, 0, 15) },
    getSceneRadius: () => 10,
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

  it('updates lastFocusedMoleculeId without retargeting camera', () => {
    const r = mockRenderer(new THREE.Vector3(5, 6, 7));
    focusMoleculeByAtom(30, r);
    expect(useAppStore.getState().lastFocusedMoleculeId).toBe(10);
    // Should NOT retarget camera pivot on interaction start
    expect(r.setCameraFocusTarget).not.toHaveBeenCalled();
  });

  it('finds the second molecule for higher atom indices', () => {
    const r = mockRenderer();
    focusMoleculeByAtom(80, r);
    expect(useAppStore.getState().lastFocusedMoleculeId).toBe(20);
    expect(r.setCameraFocusTarget).not.toHaveBeenCalled();
  });

  it('no-ops when atom is outside any molecule range', () => {
    const r = mockRenderer();
    focusMoleculeByAtom(200, r);
    expect(r.setCameraFocusTarget).not.toHaveBeenCalled();
    expect(useAppStore.getState().lastFocusedMoleculeId).toBeNull();
  });

  it('no-ops when atom is outside range (centroid irrelevant)', () => {
    const r = mockRenderer(null);
    focusMoleculeByAtom(200, r);
    expect(useAppStore.getState().lastFocusedMoleculeId).toBeNull();
  });
});

describe('Scene-runtime caller contracts (Policy A: placement commit decoupled)', () => {
  beforeEach(() => {
    useAppStore.getState().resetTransientState();
  });

  it('placement commit does NOT retarget camera or change focus metadata', () => {
    // Policy A: placement commit neither moves camera nor changes lastFocusedMoleculeId.
    // Placement framing handles visibility; Center/Follow handle explicit focus.
    useAppStore.getState().setMolecules([
      { id: 1, name: 'A', structureFile: 'a.xyz', atomCount: 60, atomOffset: 0 },
      { id: 2, name: 'B', structureFile: 'b.xyz', atomCount: 40, atomOffset: 60 },
    ]);
    useAppStore.getState().setPlacementActive(true);

    const r = mockRenderer(new THREE.Vector3(10, 20, 30));
    // Simulate what scene-runtime.ts finalizeCommittedScene() now does:
    // NO focusNewestPlacedMolecule call — just recomputeFocusDistance equivalent
    // The renderer is NOT asked to retarget camera
    expect(r.setCameraFocusTarget).not.toHaveBeenCalled();
    expect(useAppStore.getState().lastFocusedMoleculeId).toBeNull();
  });

  it('non-placement commit (addMoleculeToScene) also does NOT retarget camera', () => {
    useAppStore.getState().setMolecules([
      { id: 1, name: 'A', structureFile: 'a.xyz', atomCount: 60, atomOffset: 0 },
    ]);

    const r = mockRenderer(new THREE.Vector3(10, 20, 30));
    // finalizeCommittedScene() no longer has focusNewestPlaced option
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

// ── Follow enable with no prior target (Phase 2) ──

import { handleCenterObject, ensureFollowTarget } from '../../lab/js/runtime/camera/focus-runtime';

describe('display-aware focus resolution (review mode)', () => {
  beforeEach(() => {
    useAppStore.getState().resetTransientState();
  });

  it('resolveReturnTarget uses getDisplayedMoleculeBounds', () => {
    useAppStore.getState().setMolecules([
      { id: 1, name: 'A', structureFile: 'a.xyz', atomCount: 60, atomOffset: 0 },
    ]);
    useAppStore.getState().setLastFocusedMoleculeId(1);

    // Mock: displayed bounds return review-frame position, live returns different
    const reviewCenter = new THREE.Vector3(10, 20, 30);
    const liveCenter = new THREE.Vector3(1, 2, 3);
    const r = {
      ...mockRenderer(liveCenter),
      getDisplayedMoleculeBounds: vi.fn(() => ({ center: reviewCenter, radius: 5 })),
      getDisplayedMoleculeCentroid: vi.fn(() => reviewCenter),
    };

    const target = resolveReturnTarget(r, 10);
    expect(target.position).toBe(reviewCenter);
    expect(r.getDisplayedMoleculeBounds).toHaveBeenCalledWith(0, 60);
  });

  it('handleCenterObject uses displayed bounds for animation', () => {
    useAppStore.getState().setMolecules([
      { id: 5, name: 'C60', structureFile: 'c60.xyz', atomCount: 60, atomOffset: 0 },
    ]);
    const r = mockRenderer(new THREE.Vector3(1, 2, 3));
    handleCenterObject(r);
    expect(r.animateToFramedTarget).toHaveBeenCalled();
    expect(useAppStore.getState().lastFocusedMoleculeId).toBe(5);
  });
});

describe('ensureFollowTarget contract', () => {
  beforeEach(() => {
    useAppStore.getState().resetTransientState();
  });

  it('returns false when no molecules exist', () => {
    useAppStore.getState().setMolecules([]);
    const r = mockRenderer();
    expect(ensureFollowTarget(r)).toBe(false);
  });

  it('returns true and keeps existing valid lastFocusedMoleculeId', () => {
    useAppStore.getState().setMolecules([
      { id: 1, name: 'A', structureFile: 'a.xyz', atomCount: 60, atomOffset: 0 },
    ]);
    useAppStore.getState().setLastFocusedMoleculeId(1);
    const r = mockRenderer();
    expect(ensureFollowTarget(r)).toBe(true);
    expect(useAppStore.getState().lastFocusedMoleculeId).toBe(1);
  });

  it('returns true and sets focus for single molecule', () => {
    useAppStore.getState().setMolecules([
      { id: 5, name: 'C60', structureFile: 'c60.xyz', atomCount: 60, atomOffset: 0 },
    ]);
    const r = mockRenderer();
    expect(ensureFollowTarget(r)).toBe(true);
    expect(useAppStore.getState().lastFocusedMoleculeId).toBe(5);
  });

  it('returns true and resolves nearest for multiple molecules with no prior focus', () => {
    useAppStore.getState().setMolecules([
      { id: 1, name: 'A', structureFile: 'a.xyz', atomCount: 60, atomOffset: 0 },
      { id: 2, name: 'B', structureFile: 'b.xyz', atomCount: 40, atomOffset: 60 },
    ]);
    const r = mockRenderer();
    expect(ensureFollowTarget(r)).toBe(true);
    expect(useAppStore.getState().lastFocusedMoleculeId).not.toBeNull();
  });

  it('returns true and resolves when lastFocusedMoleculeId is stale', () => {
    useAppStore.getState().setMolecules([
      { id: 1, name: 'A', structureFile: 'a.xyz', atomCount: 60, atomOffset: 0 },
    ]);
    useAppStore.getState().setLastFocusedMoleculeId(99); // stale
    const r = mockRenderer();
    expect(ensureFollowTarget(r)).toBe(true);
    expect(useAppStore.getState().lastFocusedMoleculeId).toBe(1);
  });
});

describe('Follow enable resolves a target', () => {
  beforeEach(() => {
    useAppStore.getState().resetTransientState();
  });

  it('handleCenterObject sets lastFocusedMoleculeId for single molecule (follow prerequisite)', () => {
    useAppStore.getState().setMolecules([
      { id: 5, name: 'C60', structureFile: 'c60.xyz', atomCount: 60, atomOffset: 0 },
    ]);
    const r = mockRenderer(new THREE.Vector3(1, 2, 3));
    handleCenterObject(r);
    expect(useAppStore.getState().lastFocusedMoleculeId).toBe(5);
  });

  it('handleCenterObject resolves nearest molecule when no prior focus', () => {
    useAppStore.getState().setMolecules([
      { id: 1, name: 'A', structureFile: 'a.xyz', atomCount: 60, atomOffset: 0 },
      { id: 2, name: 'B', structureFile: 'b.xyz', atomCount: 40, atomOffset: 60 },
    ]);
    const r = mockRenderer(new THREE.Vector3(1, 2, 3));
    handleCenterObject(r);
    expect(useAppStore.getState().lastFocusedMoleculeId).not.toBeNull();
    expect(r.animateToFramedTarget).toHaveBeenCalled();
  });

  it('follow enable + handleCenterObject gives the per-frame loop a valid target', () => {
    useAppStore.getState().setMolecules([
      { id: 10, name: 'C60', structureFile: 'c60.xyz', atomCount: 60, atomOffset: 0 },
    ]);
    useAppStore.getState().setOrbitFollowEnabled(true);
    const r = mockRenderer(new THREE.Vector3(1, 2, 3));
    handleCenterObject(r);
    // Per-frame follow loop needs both: orbitFollowEnabled AND lastFocusedMoleculeId
    const s = useAppStore.getState();
    expect(s.orbitFollowEnabled).toBe(true);
    expect(s.lastFocusedMoleculeId).toBe(10);
  });

  it('focusMoleculeByAtom does not change target when follow is active', () => {
    useAppStore.getState().setMolecules([
      { id: 1, name: 'A', structureFile: 'a.xyz', atomCount: 60, atomOffset: 0 },
      { id: 2, name: 'B', structureFile: 'b.xyz', atomCount: 40, atomOffset: 60 },
    ]);
    useAppStore.getState().setOrbitFollowEnabled(true);
    useAppStore.getState().setLastFocusedMoleculeId(1);
    const r = mockRenderer();
    focusMoleculeByAtom(80, r); // atom in molecule 2
    // Should NOT change target — follow freezes the tracked molecule
    expect(useAppStore.getState().lastFocusedMoleculeId).toBe(1);
  });
});
