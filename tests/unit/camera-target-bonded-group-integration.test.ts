/**
 * Bonded-group camera target integration tests.
 *
 * Verifies that the generic camera target system works end-to-end for
 * bonded-group targets through the real focus-runtime entry points
 * (handleCenterObject, ensureFollowTarget, updateOrbitFollowFromStore).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as THREE from 'three';
import { useAppStore } from '../../lab/js/store/app-store';
import { handleCenterObject, ensureFollowTarget } from '../../lab/js/runtime/camera/focus-runtime';
import { updateOrbitFollowFromStore } from '../../lab/js/runtime/camera/orbit-follow-update';

function mockRendererWithGroupAtoms() {
  return {
    getDisplayedMoleculeBounds: vi.fn((offset: number, count: number) =>
      ({ center: new THREE.Vector3(offset, 0, 0), radius: 5 }),
    ),
    getDisplayedAtomWorldPosition: vi.fn((i: number) =>
      new THREE.Vector3(i * 2, i, 0),
    ),
    animateToFramedTarget: vi.fn(),
    animateToFocusedObject: vi.fn(),
    setCameraFocusTarget: vi.fn(),
    getDisplayedMoleculeCentroid: vi.fn(() => new THREE.Vector3(0, 0, 0)),
    updateOrbitFollow: vi.fn(),
    camera: { position: new THREE.Vector3(0, 0, 20) },
    getSceneRadius: () => 10,
  };
}

const groupAtoms = [0, 1, 2, 3, 4];
const focusDeps = {
  getBondedGroupAtoms: vi.fn((id: string) => id === 'g1' ? groupAtoms : null),
};

describe('Bonded-group camera target integration', () => {
  beforeEach(() => {
    useAppStore.getState().resetTransientState();
    useAppStore.getState().setMolecules([
      { id: 1, name: 'A', structureFile: 'a.xyz', atomCount: 60, atomOffset: 0 },
    ]);
  });

  it('handleCenterObject resolves bonded-group target via animateToFramedTarget', () => {
    const r = mockRendererWithGroupAtoms();
    useAppStore.getState().setCameraTargetRef({ kind: 'bonded-group', groupId: 'g1' });

    handleCenterObject(r as any, focusDeps);

    expect(r.animateToFramedTarget).toHaveBeenCalledTimes(1);
    const call = r.animateToFramedTarget.mock.calls[0][0];
    expect(call.center).toBeDefined();
    expect(call.radius).toBeGreaterThan(0);
    // Should NOT use the legacy molecule path
    expect(r.animateToFocusedObject).not.toHaveBeenCalled();
  });

  it('ensureFollowTarget succeeds for valid bonded-group target', () => {
    const r = mockRendererWithGroupAtoms();
    useAppStore.getState().setCameraTargetRef({ kind: 'bonded-group', groupId: 'g1' });

    const result = ensureFollowTarget(r as any, focusDeps);

    expect(result).toBe(true);
  });

  it('ensureFollowTarget falls back to default molecule for invalid bonded-group target', () => {
    const r = mockRendererWithGroupAtoms();
    useAppStore.getState().setCameraTargetRef({ kind: 'bonded-group', groupId: 'nonexistent' });

    const result = ensureFollowTarget(r as any, focusDeps);

    // Falls back to molecule default (since molecules exist), so still true
    // But the original bonded-group target is invalid
    expect(result).toBe(true); // default molecule fallback
  });

  it('updateOrbitFollowFromStore follows bonded-group target bounds', () => {
    const r = mockRendererWithGroupAtoms();
    useAppStore.getState().setCameraTargetRef({ kind: 'bonded-group', groupId: 'g1' });
    useAppStore.getState().setOrbitFollowEnabled(true);

    updateOrbitFollowFromStore(r as any, 16, focusDeps);

    expect(r.updateOrbitFollow).toHaveBeenCalledTimes(1);
    const [dtMs, bounds] = r.updateOrbitFollow.mock.calls[0];
    expect(dtMs).toBe(16);
    expect(bounds.center).toBeDefined();
    expect(bounds.radius).toBeGreaterThan(0);
  });

  it('updateOrbitFollowFromStore disables follow for invalid bonded-group', () => {
    const r = mockRendererWithGroupAtoms();
    useAppStore.getState().setCameraTargetRef({ kind: 'bonded-group', groupId: 'nonexistent' });
    useAppStore.getState().setOrbitFollowEnabled(true);

    updateOrbitFollowFromStore(r as any, 16, focusDeps);

    // Follow should be disabled because target is invalid
    expect(useAppStore.getState().orbitFollowEnabled).toBe(false);
    expect(r.updateOrbitFollow).not.toHaveBeenCalled();
  });
});
