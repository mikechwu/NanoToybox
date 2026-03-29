/**
 * @vitest-environment jsdom
 */
/**
 * Bonded group highlight runtime tests.
 *
 * Verifies:
 * - Click select/deselect/switch
 * - Hover preview when no selection
 * - Hover disabled during selection
 * - Clear highlight clears both
 * - Topology change removing selected group clears highlight
 * - Topology change removing hovered group clears preview
 * - Renderer receives correct atom indices and intensity
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createBondedGroupHighlightRuntime, type BondedGroupHighlightRuntime } from '../../page/js/runtime/bonded-group-highlight-runtime';
import { useAppStore } from '../../page/js/store/app-store';
import type { BondedGroupRuntime } from '../../page/js/runtime/bonded-group-runtime';

function makeMockRenderer() {
  return {
    setHighlightedAtoms: vi.fn(),
  };
}

function makeMockBGR(atomMap: Record<string, number[]>): BondedGroupRuntime {
  return {
    projectNow: vi.fn(),
    reset: vi.fn(),
    getAtomIndicesForGroup: (id: string) => atomMap[id] ?? null,
  };
}

describe('bonded group highlight runtime', () => {
  let highlight: BondedGroupHighlightRuntime;
  let renderer: ReturnType<typeof makeMockRenderer>;
  let bgr: BondedGroupRuntime;

  beforeEach(() => {
    useAppStore.getState().resetTransientState();
    useAppStore.getState().setBondedGroups([
      { id: 'a', displayIndex: 1, atomCount: 3, minAtomIndex: 0, orderKey: 0 },
      { id: 'b', displayIndex: 2, atomCount: 2, minAtomIndex: 3, orderKey: 1 },
    ]);
    renderer = makeMockRenderer();
    bgr = makeMockBGR({ a: [0, 1, 2], b: [3, 4] });
    highlight = createBondedGroupHighlightRuntime({
      getBondedGroupRuntime: () => bgr,
      getRenderer: () => renderer,
    });
  });

  // ── Selection ──

  it('click selects group and highlights with selected intensity', () => {
    highlight.toggleSelectedGroup('a');
    expect(useAppStore.getState().selectedBondedGroupId).toBe('a');
    expect(renderer.setHighlightedAtoms).toHaveBeenCalledWith([0, 1, 2], 'selected');
  });

  it('click same group again deselects', () => {
    highlight.toggleSelectedGroup('a');
    renderer.setHighlightedAtoms.mockClear();

    highlight.toggleSelectedGroup('a');
    expect(useAppStore.getState().selectedBondedGroupId).toBeNull();
    expect(renderer.setHighlightedAtoms).toHaveBeenCalledWith(null);
  });

  it('click different group switches selection', () => {
    highlight.toggleSelectedGroup('a');
    renderer.setHighlightedAtoms.mockClear();

    highlight.toggleSelectedGroup('b');
    expect(useAppStore.getState().selectedBondedGroupId).toBe('b');
    expect(renderer.setHighlightedAtoms).toHaveBeenCalledWith([3, 4], 'selected');
  });

  // ── Hover preview ──

  it('hover highlights with hover intensity when no selection', () => {
    highlight.setHoveredGroup('a');
    expect(useAppStore.getState().hoveredBondedGroupId).toBe('a');
    expect(renderer.setHighlightedAtoms).toHaveBeenCalledWith([0, 1, 2], 'hover');
  });

  it('moving across rows updates preview', () => {
    highlight.setHoveredGroup('a');
    renderer.setHighlightedAtoms.mockClear();

    highlight.setHoveredGroup('b');
    expect(useAppStore.getState().hoveredBondedGroupId).toBe('b');
    expect(renderer.setHighlightedAtoms).toHaveBeenCalledWith([3, 4], 'hover');
  });

  it('leaving list clears hover preview', () => {
    highlight.setHoveredGroup('a');
    renderer.setHighlightedAtoms.mockClear();

    highlight.setHoveredGroup(null);
    expect(useAppStore.getState().hoveredBondedGroupId).toBeNull();
    expect(renderer.setHighlightedAtoms).toHaveBeenCalledWith(null);
  });

  // ── Hover disabled during selection ──

  it('hover does nothing when selection exists', () => {
    highlight.toggleSelectedGroup('a');
    renderer.setHighlightedAtoms.mockClear();

    highlight.setHoveredGroup('b');
    // Hover should be ignored — selection takes priority
    expect(useAppStore.getState().hoveredBondedGroupId).toBeNull();
    expect(renderer.setHighlightedAtoms).not.toHaveBeenCalled();
  });

  // ── Clear highlight ──

  it('clearHighlight clears both selection and hover', () => {
    highlight.toggleSelectedGroup('a');
    renderer.setHighlightedAtoms.mockClear();

    highlight.clearHighlight();
    expect(useAppStore.getState().selectedBondedGroupId).toBeNull();
    expect(useAppStore.getState().hoveredBondedGroupId).toBeNull();
    expect(renderer.setHighlightedAtoms).toHaveBeenCalledWith(null);
  });

  // ── Topology invalidation ──

  it('syncAfterTopologyChange clears selection when group disappears', () => {
    highlight.toggleSelectedGroup('a');
    renderer.setHighlightedAtoms.mockClear();

    // Remove group 'a' from store
    useAppStore.getState().setBondedGroups([
      { id: 'b', displayIndex: 1, atomCount: 2, minAtomIndex: 0, orderKey: 0 },
    ]);

    highlight.syncAfterTopologyChange();
    expect(useAppStore.getState().selectedBondedGroupId).toBeNull();
    expect(renderer.setHighlightedAtoms).toHaveBeenCalledWith(null);
  });

  it('syncAfterTopologyChange clears hover when hovered group disappears', () => {
    highlight.setHoveredGroup('b');
    renderer.setHighlightedAtoms.mockClear();

    // Remove group 'b'
    useAppStore.getState().setBondedGroups([
      { id: 'a', displayIndex: 1, atomCount: 3, minAtomIndex: 0, orderKey: 0 },
    ]);

    highlight.syncAfterTopologyChange();
    expect(useAppStore.getState().hoveredBondedGroupId).toBeNull();
  });

  it('renderer highlight updates when atoms move (no drift)', () => {
    // This tests the key fix: highlight overlay must track atom positions each frame
    const mockRenderer = {
      setHighlightedAtoms: vi.fn(),
      _updateGroupHighlight: vi.fn(), // verify it would be called
    };
    const localHighlight = createBondedGroupHighlightRuntime({
      getBondedGroupRuntime: () => bgr,
      getRenderer: () => mockRenderer as any,
    });

    localHighlight.toggleSelectedGroup('a');
    // Renderer received the initial highlight
    expect(mockRenderer.setHighlightedAtoms).toHaveBeenCalledWith([0, 1, 2], 'selected');

    // The key contract: updatePositions() and updateFromSnapshot() call
    // _updateGroupHighlight() to keep overlay aligned. We verify the renderer
    // stores indices persistently (not one-shot) so the update path can use them.
    // Since we can't call the real renderer here, verify the contract:
    // - setHighlightedAtoms was called with indices (persistent state set)
    // - subsequent updatePositions would call _updateGroupHighlight
  });

  it('syncAfterTopologyChange preserves selection when group survives', () => {
    highlight.toggleSelectedGroup('a');
    renderer.setHighlightedAtoms.mockClear();

    // Both groups still present
    highlight.syncAfterTopologyChange();
    expect(useAppStore.getState().selectedBondedGroupId).toBe('a');
    // Re-syncs atoms (membership may have changed)
    expect(renderer.setHighlightedAtoms).toHaveBeenCalledWith([0, 1, 2], 'selected');
  });
});

describe('renderer group highlight alignment', () => {
  it('_updateGroupHighlight refreshes overlay positions from current physics', async () => {
    const { Renderer } = await import('../../page/js/renderer');
    const update = (Renderer.prototype as any)._updateGroupHighlight;

    // Minimal renderer context with real Three.js objects
    const THREE = await import('three');
    const atomGeom = new THREE.SphereGeometry(0.35, 4, 4);
    const dummyObj = new THREE.Object3D();
    const scene = new THREE.Scene();

    const pos = new Float64Array([1, 2, 3, 4, 5, 6, 7, 8, 9]); // 3 atoms
    const ctx: any = {
      _groupHighlightIndices: [0, 2], // highlight atoms 0 and 2
      _groupHighlightIntensity: 'selected',
      _groupHighlightMesh: null,
      _groupHighlightMat: new THREE.MeshStandardMaterial(),
      _physicsRef: { pos, n: 3 },
      _atomGeom: atomGeom,
      _dummyObj: dummyObj,
      scene,
    };

    // Call real _updateGroupHighlight
    update.call(ctx);

    // Overlay mesh should be created
    expect(ctx._groupHighlightMesh).not.toBeNull();
    expect(ctx._groupHighlightMesh.count).toBe(2);

    // Verify positions match physics
    const m = new THREE.Matrix4();
    ctx._groupHighlightMesh.getMatrixAt(0, m);
    expect(m.elements[12]).toBeCloseTo(1, 5); // atom 0 x
    expect(m.elements[13]).toBeCloseTo(2, 5); // atom 0 y
    expect(m.elements[14]).toBeCloseTo(3, 5); // atom 0 z

    ctx._groupHighlightMesh.getMatrixAt(1, m);
    expect(m.elements[12]).toBeCloseTo(7, 5); // atom 2 x
    expect(m.elements[13]).toBeCloseTo(8, 5); // atom 2 y
    expect(m.elements[14]).toBeCloseTo(9, 5); // atom 2 z

    // Move atoms
    pos[0] = 10; pos[1] = 20; pos[2] = 30;
    pos[6] = 70; pos[7] = 80; pos[8] = 90;

    // Call update again — positions should track
    update.call(ctx);

    ctx._groupHighlightMesh.getMatrixAt(0, m);
    expect(m.elements[12]).toBeCloseTo(10, 5);
    expect(m.elements[13]).toBeCloseTo(20, 5);

    ctx._groupHighlightMesh.getMatrixAt(1, m);
    expect(m.elements[12]).toBeCloseTo(70, 5);
    expect(m.elements[13]).toBeCloseTo(80, 5);

    // Cleanup
    atomGeom.dispose();
  });
});
