/**
 * @vitest-environment jsdom
 */
/**
 * Bonded group highlight runtime tests — persistent atom tracking semantics.
 *
 * Verifies:
 * - Selection captures frozen atom snapshot at click time
 * - Tracked atoms persist when group merges/splits/disappears
 * - Joined atoms do not gain highlight
 * - Departed atoms keep highlight
 * - Hover preview uses live membership only
 * - Hover disabled when tracked set exists
 * - Invalid atom indices filtered against physics.n
 * - Clear Highlight clears persistent tracked set
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createBondedGroupHighlightRuntime, type BondedGroupHighlightRuntime } from '../../page/js/runtime/bonded-group-highlight-runtime';
import { useAppStore } from '../../page/js/store/app-store';
import type { BondedGroupRuntime } from '../../page/js/runtime/bonded-group-runtime';

// Mock canTrackBondedGroupHighlightNow — default true for semantic tests,
// individual tests override to false for gating verification.
const mockCanTrack = vi.fn(() => true);
vi.mock('../../page/js/store/selectors/bonded-group-capabilities', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../page/js/store/selectors/bonded-group-capabilities')>();
  return { ...actual, canTrackBondedGroupHighlightNow: () => mockCanTrack() };
});

function makeMockRenderer() {
  return { setHighlightedAtoms: vi.fn() };
}

function makeMockBGR(atomMap: Record<string, number[]>): BondedGroupRuntime {
  return {
    projectNow: vi.fn(),
    reset: vi.fn(),
    getAtomIndicesForGroup: (id: string) => atomMap[id] ?? null,
    getDisplaySourceKind: () => 'live' as const,
  };
}

function makeMockPhysics(n: number) {
  return { n };
}

describe('persistent atom tracking', () => {
  let highlight: BondedGroupHighlightRuntime;
  let renderer: ReturnType<typeof makeMockRenderer>;
  let bgr: BondedGroupRuntime;
  let physics: { n: number };

  beforeEach(() => {
    useAppStore.getState().resetTransientState();
    useAppStore.getState().setBondedGroups([
      { id: 'a', displayIndex: 1, atomCount: 3, minAtomIndex: 0, orderKey: 0 },
      { id: 'b', displayIndex: 2, atomCount: 2, minAtomIndex: 3, orderKey: 1 },
    ]);
    renderer = makeMockRenderer();
    bgr = makeMockBGR({ a: [0, 1, 2], b: [3, 4] });
    physics = makeMockPhysics(5);
    highlight = createBondedGroupHighlightRuntime({
      getBondedGroupRuntime: () => bgr,
      getRenderer: () => renderer,
      getPhysics: () => physics,
    });
  });

  // ── 1. Selection captures atom snapshot ──

  it('selection freezes atom set at click time', () => {
    highlight.toggleSelectedGroup('a');

    expect(useAppStore.getState().hasTrackedBondedHighlight).toBe(true);
    expect(renderer.setHighlightedAtoms).toHaveBeenCalledWith([0, 1, 2], 'selected');
  });

  // ── 2. Joined atoms do not gain highlight ──

  it('joined atoms do not gain highlight after selection', () => {
    highlight.toggleSelectedGroup('a');
    renderer.setHighlightedAtoms.mockClear();

    // Group A now includes atom 5, 6 — but tracked set stays frozen
    (bgr as any).getAtomIndicesForGroup = (id: string) =>
      id === 'a' ? [0, 1, 2, 5, 6] : id === 'b' ? [3, 4] : null;

    highlight.syncToRenderer();

    // Still renders original frozen set [0,1,2], not [0,1,2,5,6]
    expect(renderer.setHighlightedAtoms).toHaveBeenCalledWith([0, 1, 2], 'selected');
  });

  // ── 3. Departed atoms keep highlight ──

  it('departed atoms keep highlight after selection', () => {
    highlight.toggleSelectedGroup('a');
    renderer.setHighlightedAtoms.mockClear();

    // Group A shrank to [1] — but tracked set stays frozen
    (bgr as any).getAtomIndicesForGroup = (id: string) =>
      id === 'a' ? [1] : id === 'b' ? [3, 4] : null;

    highlight.syncToRenderer();

    // Still renders original frozen set [0,1,2]
    expect(renderer.setHighlightedAtoms).toHaveBeenCalledWith([0, 1, 2], 'selected');
  });

  // ── 4. Selected group disappears but highlight persists ──

  it('tracked highlight persists when selected group disappears', () => {
    highlight.toggleSelectedGroup('a');
    renderer.setHighlightedAtoms.mockClear();

    // Group A no longer exists in the list
    useAppStore.getState().setBondedGroups([
      { id: 'b', displayIndex: 1, atomCount: 5, minAtomIndex: 0, orderKey: 0 },
    ]);

    highlight.syncAfterTopologyChange();

    // Selected row ID cleared (group gone from list)
    expect(useAppStore.getState().selectedBondedGroupId).toBeNull();
    // But tracked atoms persist!
    expect(useAppStore.getState().hasTrackedBondedHighlight).toBe(true);
    // Renderer still shows the frozen set
    expect(renderer.setHighlightedAtoms).toHaveBeenCalledWith([0, 1, 2], 'selected');
  });

  // ── 5. Clear Highlight clears persistent tracked set ──

  it('clearHighlight clears tracked atoms and renderer', () => {
    highlight.toggleSelectedGroup('a');
    renderer.setHighlightedAtoms.mockClear();

    highlight.clearHighlight();

    expect(useAppStore.getState().hasTrackedBondedHighlight).toBe(false);
    expect(useAppStore.getState().selectedBondedGroupId).toBeNull();
    expect(renderer.setHighlightedAtoms).toHaveBeenCalledWith(null);
  });

  // ── 6. Hover previews live membership when no tracked set ──

  it('hover uses live group membership, not frozen', () => {
    // No selection active
    highlight.setHoveredGroup('b');
    expect(renderer.setHighlightedAtoms).toHaveBeenCalledWith([3, 4], 'hover');

    // Group B gains an atom
    renderer.setHighlightedAtoms.mockClear();
    (bgr as any).getAtomIndicesForGroup = (id: string) =>
      id === 'b' ? [3, 4, 5] : null;

    highlight.setHoveredGroup('b');
    expect(renderer.setHighlightedAtoms).toHaveBeenCalledWith([3, 4, 5], 'hover');
  });

  // ── 7. Hover disabled when tracked highlight exists ──

  it('hover ignored when tracked highlight exists', () => {
    highlight.toggleSelectedGroup('a');
    renderer.setHighlightedAtoms.mockClear();

    highlight.setHoveredGroup('b');
    // Hover is blocked — tracked set takes priority
    expect(useAppStore.getState().hoveredBondedGroupId).toBeNull();
    expect(renderer.setHighlightedAtoms).not.toHaveBeenCalled();
  });

  it('hover still blocked when selected ID is null but tracked atoms remain', () => {
    highlight.toggleSelectedGroup('a');
    // Simulate group disappearing — ID cleared but tracked atoms persist
    useAppStore.getState().setSelectedBondedGroup(null);
    renderer.setHighlightedAtoms.mockClear();

    highlight.setHoveredGroup('b');
    // Still blocked — tracked atoms exist
    expect(useAppStore.getState().hoveredBondedGroupId).toBeNull();
    expect(renderer.setHighlightedAtoms).not.toHaveBeenCalled();
  });

  it('hover clearing (null) still works when tracked atoms exist', () => {
    // Set hover first, then select — hover should be clearable
    useAppStore.getState().setHoveredBondedGroup('b');
    highlight.toggleSelectedGroup('a');
    renderer.setHighlightedAtoms.mockClear();

    // Clear hover (e.g. mouse leaves list) — should succeed even with tracked atoms
    highlight.setHoveredGroup(null);
    expect(useAppStore.getState().hoveredBondedGroupId).toBeNull();
  });

  // ── 8. Invalid atom indices filtered ──

  it('filters invalid atom indices when physics shrinks', () => {
    highlight.toggleSelectedGroup('a'); // tracked: [0, 1, 2]
    renderer.setHighlightedAtoms.mockClear();

    // Physics now has only 2 atoms (atoms 2+ removed)
    physics.n = 2;

    highlight.syncToRenderer();
    // Only [0, 1] are valid
    expect(renderer.setHighlightedAtoms).toHaveBeenCalledWith([0, 1], 'selected');
  });

  it('auto-clears tracked highlight when all indices become invalid', () => {
    highlight.toggleSelectedGroup('a'); // tracked: [0, 1, 2]
    renderer.setHighlightedAtoms.mockClear();

    // Physics now has 0 atoms
    physics.n = 0;

    highlight.syncToRenderer();
    expect(useAppStore.getState().hasTrackedBondedHighlight).toBe(false);
    expect(renderer.setHighlightedAtoms).toHaveBeenCalledWith(null);
  });

  // ── Selection toggling ──

  it('click same group again deselects and clears tracked atoms', () => {
    highlight.toggleSelectedGroup('a');
    renderer.setHighlightedAtoms.mockClear();

    highlight.toggleSelectedGroup('a');
    expect(useAppStore.getState().selectedBondedGroupId).toBeNull();
    expect(useAppStore.getState().hasTrackedBondedHighlight).toBe(false);
    expect(renderer.setHighlightedAtoms).toHaveBeenCalledWith(null);
  });

  it('click different group switches to new frozen set', () => {
    highlight.toggleSelectedGroup('a');
    renderer.setHighlightedAtoms.mockClear();

    highlight.toggleSelectedGroup('b');
    expect(useAppStore.getState().selectedBondedGroupId).toBe('b');
    expect(useAppStore.getState().hasTrackedBondedHighlight).toBe(true);
    expect(renderer.setHighlightedAtoms).toHaveBeenCalledWith([3, 4], 'selected');
  });

  // ── Topology: hover disappears ──

  it('topology change clears stale hover', () => {
    highlight.setHoveredGroup('b');
    renderer.setHighlightedAtoms.mockClear();

    useAppStore.getState().setBondedGroups([
      { id: 'a', displayIndex: 1, atomCount: 3, minAtomIndex: 0, orderKey: 0 },
    ]);

    highlight.syncAfterTopologyChange();
    expect(useAppStore.getState().hoveredBondedGroupId).toBeNull();
  });
});

describe('tracked highlight gating (canTrackBondedGroupHighlight: false)', () => {
  let highlight: BondedGroupHighlightRuntime;
  let renderer: ReturnType<typeof makeMockRenderer>;

  beforeEach(() => {
    useAppStore.getState().resetTransientState();
    useAppStore.getState().setBondedGroups([
      { id: 'a', displayIndex: 1, atomCount: 3, minAtomIndex: 0, orderKey: 0 },
    ]);
    renderer = makeMockRenderer();
    mockCanTrack.mockReturnValue(false);
    highlight = createBondedGroupHighlightRuntime({
      getBondedGroupRuntime: () => makeMockBGR({ a: [0, 1, 2] }),
      getRenderer: () => renderer,
      getPhysics: () => ({ n: 5 }),
    });
  });

  afterEach(() => { mockCanTrack.mockReturnValue(true); });

  it('toggleSelectedGroup no-ops when canTrackBondedGroupHighlight is false', () => {
    highlight.toggleSelectedGroup('a');
    expect(useAppStore.getState().selectedBondedGroupId).toBeNull();
    expect(useAppStore.getState().hasTrackedBondedHighlight).toBe(false);
    expect(renderer.setHighlightedAtoms).not.toHaveBeenCalled();
  });

  it('setHoveredGroup still works when tracked highlight is disabled', () => {
    highlight.setHoveredGroup('a');
    expect(useAppStore.getState().hoveredBondedGroupId).toBe('a');
    expect(renderer.setHighlightedAtoms).toHaveBeenCalledWith([0, 1, 2], 'hover');
  });

  it('clearHighlight remains safe when tracked highlight is disabled', () => {
    highlight.clearHighlight();
    expect(useAppStore.getState().hasTrackedBondedHighlight).toBe(false);
    expect(renderer.setHighlightedAtoms).toHaveBeenCalledWith(null);
  });

  it('syncToRenderer self-heals stale tracked state when feature is gated off', () => {
    // Seed stale tracked state (as if from hot reload or prior session)
    mockCanTrack.mockReturnValue(true);
    highlight.toggleSelectedGroup('a');
    expect(useAppStore.getState().hasTrackedBondedHighlight).toBe(true);
    expect(useAppStore.getState().selectedBondedGroupId).toBe('a');
    renderer.setHighlightedAtoms.mockClear();

    // Gate feature off
    mockCanTrack.mockReturnValue(false);

    // syncToRenderer should clear stale tracked state
    highlight.syncToRenderer();
    expect(useAppStore.getState().hasTrackedBondedHighlight).toBe(false);
    expect(useAppStore.getState().selectedBondedGroupId).toBeNull();
    // Renderer should show no highlight (no hover active)
    expect(renderer.setHighlightedAtoms).toHaveBeenCalledWith(null);
  });

  it('hover works again after stale tracked state is self-healed', () => {
    // Seed stale tracked state
    mockCanTrack.mockReturnValue(true);
    highlight.toggleSelectedGroup('a');
    renderer.setHighlightedAtoms.mockClear();

    // Gate feature off — tracked state blocks hover
    mockCanTrack.mockReturnValue(false);

    // syncToRenderer self-heals
    highlight.syncToRenderer();
    renderer.setHighlightedAtoms.mockClear();

    // Now hover should work (tracked state cleared)
    highlight.setHoveredGroup('a');
    expect(useAppStore.getState().hoveredBondedGroupId).toBe('a');
    expect(renderer.setHighlightedAtoms).toHaveBeenCalledWith([0, 1, 2], 'hover');
  });
});

describe('renderer alignment with persistent tracking', () => {
  it('_updateGroupHighlight tracks positions for frozen atom set', async () => {
    const { Renderer } = await import('../../page/js/renderer');
    const update = (Renderer.prototype as any)._updateGroupHighlight;
    const applyLayer = (Renderer.prototype as any)._applyHighlightLayer;
    const THREE = await import('three');

    const atomGeom = new THREE.SphereGeometry(0.35, 4, 4);
    const dummyObj = new THREE.Object3D();
    const scene = new THREE.Scene();
    const pos = new Float64Array([1, 2, 3, 4, 5, 6, 7, 8, 9]);

    const ctx: any = {
      _panelHighlightIndices: [0, 2],
      _panelHighlightIntensity: 'selected',
      _panelHighlightMesh: null,
      _panelHighlightMat: null,
      _panelHighlightCapacity: 0,
      _interactionHighlightIndices: null,
      _interactionHighlightIntensity: 'hover',
      _interactionHighlightMesh: null,
      _interactionHighlightMat: null,
      _interactionHighlightCapacity: 0,
      _physicsRef: { pos, n: 3 },
      _atomGeom: atomGeom,
      _dummyObj: dummyObj,
      _displaySource: 'live',
      _reviewPositions: null,
      _reviewAtomCount: 0,
      scene,
    };
    const getDisplayedPositions = (Renderer.prototype as any)._getDisplayedPositions;
    ctx._getDisplayedPositions = getDisplayedPositions.bind(ctx);
    ctx._applyHighlightLayer = applyLayer.bind(ctx);

    update.call(ctx);
    const m = new THREE.Matrix4();
    ctx._panelHighlightMesh.getMatrixAt(0, m);
    expect(m.elements[12]).toBeCloseTo(1, 5);

    // Move atoms — positions change but indices are frozen
    pos[0] = 100; pos[6] = 700;
    update.call(ctx);

    ctx._panelHighlightMesh.getMatrixAt(0, m);
    expect(m.elements[12]).toBeCloseTo(100, 5);
    ctx._panelHighlightMesh.getMatrixAt(1, m);
    expect(m.elements[12]).toBeCloseTo(700, 5);

    atomGeom.dispose();
  });
});
