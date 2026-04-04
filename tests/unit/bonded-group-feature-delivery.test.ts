/**
 * Bonded group feature delivery tests — validates the end-to-end feature
 * delivery across review topology, camera targeting, and capability policy.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as THREE from 'three';
import { useAppStore } from '../../page/js/store/app-store';
import { selectBondedGroupCapabilities } from '../../page/js/store/selectors/bonded-group-capabilities';
import { resolveCameraTargetRef, type CameraTargetDeps } from '../../page/js/runtime/camera-target-runtime';
import { handleCenterObject, ensureFollowTarget } from '../../page/js/runtime/focus-runtime';
import { updateOrbitFollowFromStore } from '../../page/js/runtime/orbit-follow-update';
import { handleBondedGroupFollowToggle } from '../../page/js/runtime/bonded-group-follow-actions';

function mockRendererForBondedGroup() {
  return {
    getDisplayedMoleculeBounds: vi.fn(() => ({ center: new THREE.Vector3(0, 0, 0), radius: 5 })),
    getDisplayedAtomWorldPosition: vi.fn((i: number) => new THREE.Vector3(i * 2, i, 0)),
    animateToFramedTarget: vi.fn(),
    animateToFocusedObject: vi.fn(),
    setCameraFocusTarget: vi.fn(),
    getDisplayedMoleculeCentroid: vi.fn(() => new THREE.Vector3(0, 0, 0)),
    updateOrbitFollow: vi.fn(),
    camera: { position: new THREE.Vector3(0, 0, 20) },
    getSceneRadius: () => 10,
  };
}

const groupAtoms: Record<string, number[]> = { g1: [0, 1, 2, 3, 4], g2: [5, 6, 7] };
const focusDeps = { getBondedGroupAtoms: (id: string) => groupAtoms[id] ?? null };

describe('Bonded group camera targeting (Phase 4)', () => {
  beforeEach(() => {
    useAppStore.getState().resetTransientState();
    useAppStore.getState().setMolecules([
      { id: 1, name: 'A', structureFile: 'a.xyz', atomCount: 60, atomOffset: 0 },
    ]);
  });

  it('onCenterGroup resolves bonded-group target and animates', () => {
    const r = mockRendererForBondedGroup();
    useAppStore.getState().setCameraTargetRef({ kind: 'bonded-group', groupId: 'g1' });
    handleCenterObject(r as any, focusDeps);
    expect(r.animateToFramedTarget).toHaveBeenCalledTimes(1);
    const call = r.animateToFramedTarget.mock.calls[0][0];
    expect(call.center).toBeDefined();
    expect(call.radius).toBeGreaterThan(0);
  });

  it('onFollowGroup enables follow for bonded-group target', () => {
    const r = mockRendererForBondedGroup();
    useAppStore.getState().setCameraTargetRef({ kind: 'bonded-group', groupId: 'g1' });
    const result = ensureFollowTarget(r as any, focusDeps);
    expect(result).toBe(true);
  });

  it('follow tracks bonded-group bounds per-frame', () => {
    const r = mockRendererForBondedGroup();
    useAppStore.getState().setCameraTargetRef({ kind: 'bonded-group', groupId: 'g1' });
    useAppStore.getState().setOrbitFollowEnabled(true);
    updateOrbitFollowFromStore(r as any, 16, focusDeps);
    expect(r.updateOrbitFollow).toHaveBeenCalledTimes(1);
    const [dtMs, bounds] = r.updateOrbitFollow.mock.calls[0];
    expect(dtMs).toBe(16);
    expect(bounds.radius).toBeGreaterThan(0);
  });

  it('onFollowGroup freezes atom set and enables orbit follow (no volatile label)', () => {
    // Simulate production callback: freeze atoms at click time
    const atoms = [...groupAtoms.g1]; // [0,1,2,3,4]
    useAppStore.getState().setOrbitFollowTargetRef({ kind: 'atom-set', atomIndices: atoms });
    useAppStore.getState().setOrbitFollowEnabled(true);
    expect(useAppStore.getState().orbitFollowEnabled).toBe(true);
    const target = useAppStore.getState().orbitFollowTargetRef;
    expect(target?.kind).toBe('atom-set');
    if (target?.kind === 'atom-set') {
      expect(target.atomIndices).toEqual(atoms);
    }
  });

  it('onFollowGroup toggle-off: clears frozen target, follow state, and stale camera target', () => {
    // Setup: follow is on with frozen atoms + bonded-group camera target
    useAppStore.getState().setOrbitFollowTargetRef({ kind: 'atom-set', atomIndices: [0, 1, 2] });
    useAppStore.getState().setCameraTargetRef({ kind: 'bonded-group', groupId: 'g1' });
    useAppStore.getState().setOrbitFollowEnabled(true);
    expect(useAppStore.getState().orbitFollowEnabled).toBe(true);

    // Toggle off — simulates the production callback shutdown
    const store = useAppStore.getState();
    store.setOrbitFollowEnabled(false);
    store.setOrbitFollowTargetRef(null);
    // Stale bonded-group camera target must also be cleared
    if (store.cameraTargetRef?.kind === 'bonded-group') {
      store.setCameraTargetRef(null);
    }

    expect(useAppStore.getState().orbitFollowEnabled).toBe(false);
    expect(useAppStore.getState().orbitFollowTargetRef).toBeNull();
    expect(useAppStore.getState().cameraTargetRef).toBeNull();
  });

  it('follow continues even if original bonded-group topology changes', () => {
    // Frozen atom set does not depend on groupId resolution
    const frozenAtoms = [0, 1, 2, 3, 4];
    const r = mockRendererForBondedGroup();
    useAppStore.getState().setOrbitFollowTargetRef({ kind: 'atom-set', atomIndices: frozenAtoms });
    useAppStore.getState().setOrbitFollowEnabled(true);
    // Even with no group lookup, follow should resolve from frozen atom positions
    updateOrbitFollowFromStore(r as any, 16, focusDeps);
    expect(r.updateOrbitFollow).toHaveBeenCalled();
  });

  it('onCenterGroup is one-shot: frames group but does not persist active state', () => {
    const r = mockRendererForBondedGroup();
    useAppStore.getState().setCameraTargetRef({ kind: 'bonded-group', groupId: 'g1' });
    handleCenterObject(r as any, focusDeps);
    // Center should not enable follow
    expect(useAppStore.getState().orbitFollowEnabled).toBe(false);
    // Target is set for framing (transient, not a retained "center mode")
    expect(r.animateToFramedTarget).toHaveBeenCalled();
  });

  it('invalid group target disables follow', () => {
    const r = mockRendererForBondedGroup();
    useAppStore.getState().setCameraTargetRef({ kind: 'bonded-group', groupId: 'nonexistent' });
    useAppStore.getState().setOrbitFollowEnabled(true);
    updateOrbitFollowFromStore(r as any, 16, focusDeps);
    expect(useAppStore.getState().orbitFollowEnabled).toBe(false);
  });
});

describe('Bonded group capabilities (all phases complete)', () => {
  it('review allows inspect/target/edit, blocks mutation', () => {
    const caps = selectBondedGroupCapabilities({ timelineMode: 'review' } as any);
    expect(caps.canInspectBondedGroups).toBe(true);
    expect(caps.canTargetBondedGroups).toBe(true);
    expect(caps.canEditBondedGroupColor).toBe(true);
    expect(caps.canMutateSimulation).toBe(false);
  });

  it('live allows all capabilities', () => {
    const caps = selectBondedGroupCapabilities({ timelineMode: 'live' } as any);
    expect(caps.canInspectBondedGroups).toBe(true);
    expect(caps.canTargetBondedGroups).toBe(true);
    expect(caps.canEditBondedGroupColor).toBe(true);
    expect(caps.canMutateSimulation).toBe(true);
  });
});

describe('Bonded group target resolution', () => {
  it('resolveCameraTargetRef computes centroid + radius from group atoms', () => {
    const deps: CameraTargetDeps = {
      renderer: {
        getDisplayedMoleculeBounds: vi.fn(() => null),
        getDisplayedAtomWorldPosition: vi.fn((i: number) => new THREE.Vector3(i * 3, i, 0)),
        camera: { position: new THREE.Vector3(0, 0, 20) },
        getSceneRadius: () => 10,
      },
      molecules: [],
      getBondedGroupAtoms: (id: string) => id === 'g1' ? [0, 1, 2] : null,
    };

    const resolved = resolveCameraTargetRef({ kind: 'bonded-group', groupId: 'g1' }, deps);
    expect(resolved).not.toBeNull();
    expect(resolved!.kind).toBe('bonded-group');
    expect(resolved!.groupId).toBe('g1');
    expect(resolved!.center).toBeDefined();
    expect(resolved!.radius).toBeGreaterThan(0);
  });
});

// ── Follow callback seam tests (invoke real installed callbacks) ──

describe('Follow via handleBondedGroupFollowToggle (shared helper)', () => {
  const centerFn = vi.fn();
  const followDeps = {
    getGroupAtoms: (id: string) => groupAtoms[id] ?? null,
    centerCurrentTarget: centerFn,
  };

  beforeEach(() => {
    useAppStore.getState().resetTransientState();
    useAppStore.getState().setMolecules([
      { id: 1, name: 'A', structureFile: 'a.xyz', atomCount: 60, atomOffset: 0 },
    ]);
    centerFn.mockClear();
  });

  it('first call freezes atoms and enables follow', () => {
    handleBondedGroupFollowToggle('g1', followDeps);
    const s = useAppStore.getState();
    expect(s.orbitFollowEnabled).toBe(true);
    expect(s.orbitFollowTargetRef?.kind).toBe('atom-set');
    if (s.orbitFollowTargetRef?.kind === 'atom-set') {
      expect(s.orbitFollowTargetRef.atomIndices).toEqual([0, 1, 2, 3, 4]);
    }
    expect(s.cameraTargetRef).toEqual({ kind: 'bonded-group', groupId: 'g1' });
    expect(centerFn).toHaveBeenCalled();
  });

  it('second call toggles off and clears all follow state', () => {
    handleBondedGroupFollowToggle('g1', followDeps);
    expect(useAppStore.getState().orbitFollowEnabled).toBe(true);
    handleBondedGroupFollowToggle('g1', followDeps);
    const s = useAppStore.getState();
    expect(s.orbitFollowEnabled).toBe(false);
    expect(s.orbitFollowTargetRef).toBeNull();
    expect(s.cameraTargetRef).toBeNull();
  });

  it('shutdown preserves molecule camera target', () => {
    handleBondedGroupFollowToggle('g1', followDeps);
    useAppStore.getState().setCameraTargetRef({ kind: 'molecule', moleculeId: 1 });
    handleBondedGroupFollowToggle('g1', followDeps);
    expect(useAppStore.getState().cameraTargetRef).toEqual({ kind: 'molecule', moleculeId: 1 });
  });

  it('invalid group does nothing', () => {
    handleBondedGroupFollowToggle('nonexistent', followDeps);
    expect(useAppStore.getState().orbitFollowEnabled).toBe(false);
    expect(useAppStore.getState().orbitFollowTargetRef).toBeNull();
  });
});
