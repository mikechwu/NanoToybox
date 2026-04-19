/**
 * Bonded group pre-feature cleanup tests.
 *
 * Covers: display-source resolution, capability policy, appearance runtime
 * (frozen-atom-set ownership), and persistence semantics (annotation model).
 *
 * Future cleanup: split appearance runtime ownership + lifecycle regression
 * tests into a dedicated bonded-group-color-ownership.test.ts for clearer
 * subsystem isolation.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useAppStore } from '../../lab/js/store/app-store';
import {
  resolveBondedGroupDisplaySource,
  type BondedGroupDisplaySourceDeps,
} from '../../lab/js/runtime/bonded-groups/bonded-group-display-source';
import {
  selectBondedGroupCapabilities,
} from '../../lab/js/store/selectors/bonded-group-capabilities';
import {
  createBondedGroupAppearanceRuntime,
} from '../../lab/js/runtime/bonded-groups/bonded-group-appearance-runtime';

// ── Display Source Tests ──

describe('bonded-group display source', () => {
  it('1: resolves live source from physics components', () => {
    const deps: BondedGroupDisplaySourceDeps = {
      getPhysics: () => ({ n: 60, components: [{ atoms: [0, 1, 2], size: 3 }] }),
      getTimelineReviewComponents: () => null,
      getTimelineMode: () => 'live',
    };
    const source = resolveBondedGroupDisplaySource(deps);
    expect(source).not.toBeNull();
    expect(source!.kind).toBe('live');
    expect(source!.atomCount).toBe(60);
    expect(source!.components).toHaveLength(1);
  });

  it('2: resolves review source from historical topology', () => {
    const deps: BondedGroupDisplaySourceDeps = {
      getPhysics: () => ({ n: 60, components: [{ atoms: [0, 1], size: 2 }] }),
      getTimelineReviewComponents: () => ({
        atomCount: 60,
        components: [{ atoms: [0, 1, 2, 3], size: 4 }],
      }),
      getTimelineMode: () => 'review',
    };
    const source = resolveBondedGroupDisplaySource(deps);
    expect(source).not.toBeNull();
    expect(source!.kind).toBe('review');
    expect(source!.components[0].size).toBe(4);
  });

  it('3: returns null when no valid display source exists', () => {
    const deps: BondedGroupDisplaySourceDeps = {
      getPhysics: () => null,
      getTimelineReviewComponents: () => null,
      getTimelineMode: () => 'live',
    };
    expect(resolveBondedGroupDisplaySource(deps)).toBeNull();
  });
});

// ── Capability Policy Tests ──

describe('bonded-group capabilities', () => {
  it('8: live allows inspect/target/edit, blocks tracked highlight', () => {
    const caps = selectBondedGroupCapabilities({ timelineMode: 'live' } as any);
    expect(caps.canInspectBondedGroups).toBe(true);
    expect(caps.canTargetBondedGroups).toBe(true);
    expect(caps.canEditBondedGroupColor).toBe(true);
    expect(caps.canTrackBondedGroupHighlight).toBe(false);
    expect(caps.canMutateSimulation).toBe(true);
  });

  it('9: review allows inspect/target/edit, blocks mutation + tracked highlight', () => {
    const caps = selectBondedGroupCapabilities({ timelineMode: 'review' } as any);
    expect(caps.canInspectBondedGroups).toBe(true);
    expect(caps.canTargetBondedGroups).toBe(true);
    expect(caps.canEditBondedGroupColor).toBe(true);
    expect(caps.canTrackBondedGroupHighlight).toBe(false);
    expect(caps.canMutateSimulation).toBe(false);
  });
});

// ── Appearance Runtime Tests ──

describe('bonded-group appearance runtime', () => {
  beforeEach(() => {
    useAppStore.getState().resetTransientState();
  });

  const mockGroupAtoms: Record<string, number[]> = {
    g1: [0, 1, 2],
    g2: [3, 4],
  };

  function makeAppearanceRuntime() {
    const mockRenderer = {
      setAtomColorOverrides: vi.fn(),
    };
    return {
      runtime: createBondedGroupAppearanceRuntime({
        getBondedGroupRuntime: () => ({
          getAtomIndicesForGroup: (id: string) => mockGroupAtoms[id] ?? null,
        }),
        getRenderer: () => mockRenderer,
        getStableAtomIds: () => [0, 1, 2, 3, 4],
      }),
      mockRenderer,
    };
  }

  it('11: applying group color writes atom-level overrides', () => {
    const { runtime } = makeAppearanceRuntime();
    runtime.applyGroupColor('g1', '#ff0000');
    const overrides = useAppStore.getState().bondedGroupColorOverrides;
    expect(overrides[0]).toEqual({ hex: '#ff0000' });
    expect(overrides[1]).toEqual({ hex: '#ff0000' });
    expect(overrides[2]).toEqual({ hex: '#ff0000' });
  });

  it('12: clearing group color removes relevant overrides', () => {
    const { runtime } = makeAppearanceRuntime();
    runtime.applyGroupColor('g1', '#ff0000');
    runtime.applyGroupColor('g2', '#00ff00');
    runtime.clearGroupColor('g1');
    const overrides = useAppStore.getState().bondedGroupColorOverrides;
    expect(overrides[0]).toBeUndefined();
    expect(overrides[1]).toBeUndefined();
    expect(overrides[3]).toEqual({ hex: '#00ff00' });
    expect(overrides[4]).toEqual({ hex: '#00ff00' });
  });

  it('13: syncToRenderer applies authored colors without touching highlight', () => {
    const { runtime, mockRenderer } = makeAppearanceRuntime();
    runtime.applyGroupColor('g1', '#ff0000');
    // syncToRenderer is called by applyGroupColor internally
    expect(mockRenderer.setAtomColorOverrides).toHaveBeenCalled();
    const lastCall = mockRenderer.setAtomColorOverrides.mock.calls.at(-1)![0];
    expect(lastCall[0]).toEqual({ hex: '#ff0000' });
  });

  // ── Frozen atom-set ownership tests ──

  it('14: applyGroupColor freezes current atom set', () => {
    const groupAtoms: Record<string, number[]> = { g1: [0, 1, 2] };
    const runtime = createBondedGroupAppearanceRuntime({
      getBondedGroupRuntime: () => ({
        getAtomIndicesForGroup: (id: string) => groupAtoms[id] ?? null,
      }),
      getRenderer: () => ({ setAtomColorOverrides: vi.fn() }),
      getStableAtomIds: () => [0, 1, 2, 3, 4],
    });

    runtime.applyGroupColor('g1', '#ff0000');

    // Topology changes: atoms 3, 4 join g1
    groupAtoms.g1 = [0, 1, 2, 3, 4];

    // Overrides remain ONLY on the original frozen set — no propagation
    const overrides = useAppStore.getState().bondedGroupColorOverrides;
    expect(overrides[0]).toEqual({ hex: '#ff0000' });
    expect(overrides[1]).toEqual({ hex: '#ff0000' });
    expect(overrides[2]).toEqual({ hex: '#ff0000' });
    expect(overrides[3]).toBeUndefined();
    expect(overrides[4]).toBeUndefined();
  });

  it('15: clearGroupColor removes assignments for the source group', () => {
    const { runtime } = makeAppearanceRuntime();
    runtime.applyGroupColor('g1', '#ff0000');
    runtime.applyGroupColor('g2', '#00ff00');
    runtime.clearGroupColor('g1');

    const overrides = useAppStore.getState().bondedGroupColorOverrides;
    expect(overrides[0]).toBeUndefined();
    expect(overrides[1]).toBeUndefined();
    expect(overrides[3]).toEqual({ hex: '#00ff00' });
    expect(overrides[4]).toEqual({ hex: '#00ff00' });

    // Assignments reflect the clear
    const assignments = useAppStore.getState().bondedGroupColorAssignments;
    expect(assignments.length).toBe(1);
    expect(assignments[0].sourceGroupId).toBe('g2');
  });

  it('16: topology change does not expand color ownership', () => {
    const groupAtoms: Record<string, number[]> = { g1: [0, 1] };
    const mockRenderer = { setAtomColorOverrides: vi.fn() };
    const runtime = createBondedGroupAppearanceRuntime({
      getBondedGroupRuntime: () => ({
        getAtomIndicesForGroup: (id: string) => groupAtoms[id] ?? null,
      }),
      getRenderer: () => mockRenderer, getStableAtomIds: () => [0, 1, 2, 3, 4],
    });

    runtime.applyGroupColor('g1', '#ff0000');
    mockRenderer.setAtomColorOverrides.mockClear();

    // Group grows — frozen atom set does not expand
    groupAtoms.g1 = [0, 1, 2, 3];

    // Normal renderer sync does NOT recolor new atoms
    runtime.syncToRenderer();
    const overrides = useAppStore.getState().bondedGroupColorOverrides;
    expect(overrides[0]).toEqual({ hex: '#ff0000' });
    expect(overrides[1]).toEqual({ hex: '#ff0000' });
    expect(overrides[2]).toBeUndefined();
    expect(overrides[3]).toBeUndefined();
  });

  it('17: later assignment wins for overlapping atoms', () => {
    const { runtime } = makeAppearanceRuntime();
    // g1 has atoms [0,1,2], g2 has atoms [3,4]
    // Apply red to g1, then apply blue to a group that overlaps atom 0
    runtime.applyGroupColor('g1', '#ff0000');
    runtime.applyGroupColor('g2', '#0000ff');

    const overrides = useAppStore.getState().bondedGroupColorOverrides;
    // g1 atoms
    expect(overrides[0]).toEqual({ hex: '#ff0000' });
    // g2 atoms
    expect(overrides[3]).toEqual({ hex: '#0000ff' });
    expect(overrides[4]).toEqual({ hex: '#0000ff' });
  });

  // ── Integration-style regressions (frozen ownership under lifecycle) ──

  it('18: review scrub does not increase colored atom count', () => {
    const groupAtoms: Record<string, number[]> = { g1: [0, 1, 2] };
    const runtime = createBondedGroupAppearanceRuntime({
      getBondedGroupRuntime: () => ({
        getAtomIndicesForGroup: (id: string) => groupAtoms[id] ?? null,
      }),
      getRenderer: () => ({ setAtomColorOverrides: vi.fn() }),
      getStableAtomIds: () => [0, 1, 2, 3, 4],
    });

    // Apply color in "review frame A"
    runtime.applyGroupColor('g1', '#ff0000');
    const originalIndices = [...useAppStore.getState().bondedGroupColorAssignments[0].atomIndices];

    // Simulate scrub: group membership changes across frames
    groupAtoms.g1 = [0, 1, 2, 5, 6, 7];
    // syncToRenderer just pushes existing frozen overrides — no expansion
    runtime.syncToRenderer();

    // Return to "frame A" — group returns to original membership
    groupAtoms.g1 = [0, 1, 2];
    runtime.syncToRenderer();

    // Assert: same atom indices colored, no expansion
    const finalAssignment = useAppStore.getState().bondedGroupColorAssignments[0];
    expect(finalAssignment.atomIndices).toEqual(originalIndices);
    const overrides = useAppStore.getState().bondedGroupColorOverrides;
    expect(Object.keys(overrides).map(Number).sort()).toEqual([0, 1, 2]);
  });

  it('19: live topology evolution with stable groupId does not expand colored set', () => {
    const groupAtoms: Record<string, number[]> = { g1: [0, 1, 2] };
    const runtime = createBondedGroupAppearanceRuntime({
      getBondedGroupRuntime: () => ({
        getAtomIndicesForGroup: (id: string) => groupAtoms[id] ?? null,
      }),
      getRenderer: () => ({ setAtomColorOverrides: vi.fn() }),
      getStableAtomIds: () => [0, 1, 2, 3, 4],
    });

    runtime.applyGroupColor('g1', '#ff0000');

    // Live: group grows over several frames (same stable ID from reconciliation)
    for (const atoms of [[0,1,2,3], [0,1,2,3,4], [0,1,2,3,4,5]]) {
      groupAtoms.g1 = atoms;
      runtime.syncToRenderer(); // called by onSceneMutated
    }

    // Only the original 3 atoms should be colored
    const overrides = useAppStore.getState().bondedGroupColorOverrides;
    expect(overrides[0]).toEqual({ hex: '#ff0000' });
    expect(overrides[1]).toEqual({ hex: '#ff0000' });
    expect(overrides[2]).toEqual({ hex: '#ff0000' });
    expect(overrides[3]).toBeUndefined();
    expect(overrides[4]).toBeUndefined();
    expect(overrides[5]).toBeUndefined();
  });

  it('20: clearColorAssignment removes a specific assignment by id', () => {
    const { runtime } = makeAppearanceRuntime();
    runtime.applyGroupColor('g1', '#ff0000');
    runtime.applyGroupColor('g2', '#00ff00');

    const assignments = useAppStore.getState().bondedGroupColorAssignments;
    expect(assignments.length).toBe(2);

    // Clear the first assignment by its id
    runtime.clearColorAssignment(assignments[0].id);
    const remaining = useAppStore.getState().bondedGroupColorAssignments;
    expect(remaining.length).toBe(1);
    expect(remaining[0].sourceGroupId).toBe('g2');

    // Overrides updated: g1 atoms cleared, g2 atoms remain
    const overrides = useAppStore.getState().bondedGroupColorOverrides;
    expect(overrides[0]).toBeUndefined();
    expect(overrides[3]).toEqual({ hex: '#00ff00' });
  });

  // ── Production callback wiring tests ──

  it('21: installed callback shape mirrors main.ts wiring', () => {
    const groupAtoms: Record<string, number[]> = { g1: [0, 1, 2], g2: [3, 4] };
    const mockRenderer = { setAtomColorOverrides: vi.fn() };
    const runtime = createBondedGroupAppearanceRuntime({
      getBondedGroupRuntime: () => ({
        getAtomIndicesForGroup: (id: string) => groupAtoms[id] ?? null,
      }),
      getRenderer: () => mockRenderer, getStableAtomIds: () => [0, 1, 2, 3, 4],
    });

    // Wire callbacks as main.ts does
    const callbacks = {
      onApplyGroupColor: (id: string, hex: string) => runtime.applyGroupColor(id, hex),
      onClearGroupColor: (id: string) => runtime.clearGroupColor(id),
      onClearColorAssignment: (assignmentId: string) => runtime.clearColorAssignment(assignmentId),
    };

    // Apply via callback (like panel swatch click)
    callbacks.onApplyGroupColor('g1', '#ff0000');
    expect(useAppStore.getState().bondedGroupColorOverrides[0]).toEqual({ hex: '#ff0000' });

    // Simulate scene mutation (onSceneMutated path) — group grows
    groupAtoms.g1 = [0, 1, 2, 5, 6];
    runtime.pruneAndSync(7); // 7 atoms exist
    // Frozen set not expanded
    expect(useAppStore.getState().bondedGroupColorOverrides[5]).toBeUndefined();

    // Clear via assignment id (orphan-safe path)
    const assignmentId = useAppStore.getState().bondedGroupColorAssignments[0].id;
    callbacks.onClearColorAssignment(assignmentId);
    expect(useAppStore.getState().bondedGroupColorAssignments.length).toBe(0);
  });
});

// ── Display Source Strict Review ──

describe('bonded-group display source: strict review mode', () => {
  it('review mode with null topology returns null (no live fallback)', () => {
    const deps: BondedGroupDisplaySourceDeps = {
      getPhysics: () => ({ n: 60, components: [{ atoms: [0, 1, 2], size: 3 }] }),
      getTimelineReviewComponents: () => null,
      getTimelineMode: () => 'review',
    };
    // Must return null, NOT fall back to live physics
    expect(resolveBondedGroupDisplaySource(deps)).toBeNull();
  });
});

// ── Appearance Wiring Integration ──

describe('bonded-group appearance wiring', () => {
  beforeEach(() => {
    useAppStore.getState().resetTransientState();
  });

  it('syncToRenderer projects from assignments via stable IDs and syncs renderer', () => {
    const mockRenderer = { setAtomColorOverrides: vi.fn() };
    const runtime = createBondedGroupAppearanceRuntime({
      getBondedGroupRuntime: () => ({
        getAtomIndicesForGroup: (id: string) => id === 'g1' ? [0, 1, 2] : null,
      }),
      getRenderer: () => mockRenderer, getStableAtomIds: () => [0, 1, 2, 3, 4],
    });

    runtime.applyGroupColor('g1', '#ff0000');
    mockRenderer.setAtomColorOverrides.mockClear();

    runtime.syncToRenderer();
    expect(mockRenderer.setAtomColorOverrides).toHaveBeenCalledWith(
      expect.objectContaining({ 0: { hex: '#ff0000' } }),
    );
  });

  it('applyGroupColor drives renderer through syncToRenderer', () => {
    const mockRenderer = { setAtomColorOverrides: vi.fn() };
    const runtime = createBondedGroupAppearanceRuntime({
      getBondedGroupRuntime: () => ({
        getAtomIndicesForGroup: (id: string) => id === 'g1' ? [0, 1, 2] : null,
      }),
      getRenderer: () => mockRenderer, getStableAtomIds: () => [0, 1, 2, 3, 4],
    });

    runtime.applyGroupColor('g1', '#00ff00');
    // Should have called setAtomColorOverrides at least once
    expect(mockRenderer.setAtomColorOverrides).toHaveBeenCalled();
    const lastCall = mockRenderer.setAtomColorOverrides.mock.calls.at(-1)![0];
    expect(lastCall[0]).toEqual({ hex: '#00ff00' });
    expect(lastCall[2]).toEqual({ hex: '#00ff00' });
  });

  it('applyGroupColor captures stable atomIds from getStableAtomIds', () => {
    const groupAtoms: Record<string, number[]> = { g1: [0, 1, 2] };
    const runtime = createBondedGroupAppearanceRuntime({
      getBondedGroupRuntime: () => ({
        getAtomIndicesForGroup: (id: string) => groupAtoms[id] ?? null,
      }),
      getRenderer: () => ({ setAtomColorOverrides: vi.fn() }),
      getStableAtomIds: () => [100, 101, 102, 103, 104],
    });
    runtime.applyGroupColor('g1', '#ff0000');
    const assignments = useAppStore.getState().bondedGroupColorAssignments;
    expect(assignments).toHaveLength(1);
    expect(assignments[0].atomIndices).toEqual([0, 1, 2]);
    expect(assignments[0].atomIds).toEqual([100, 101, 102]);
  });

  it('stable atomIds reflect identity at authoring time, not later changes', () => {
    let stableIds = [100, 101, 102];
    const groupAtoms: Record<string, number[]> = { g1: [0, 1] };
    const runtime = createBondedGroupAppearanceRuntime({
      getBondedGroupRuntime: () => ({
        getAtomIndicesForGroup: (id: string) => groupAtoms[id] ?? null,
      }),
      getRenderer: () => ({ setAtomColorOverrides: vi.fn() }),
      getStableAtomIds: () => stableIds,
    });
    runtime.applyGroupColor('g1', '#ff0000');
    stableIds = [200, 201, 202];
    const assignments = useAppStore.getState().bondedGroupColorAssignments;
    expect(assignments[0].atomIds).toEqual([100, 101]);
  });

  it('applyGroupColor skips assignment when no stable IDs resolve', () => {
    const groupAtoms: Record<string, number[]> = { g1: [10, 11] };
    const runtime = createBondedGroupAppearanceRuntime({
      getBondedGroupRuntime: () => ({
        getAtomIndicesForGroup: (id: string) => groupAtoms[id] ?? null,
      }),
      getRenderer: () => ({ setAtomColorOverrides: vi.fn() }),
      getStableAtomIds: () => [0, 1],
    });
    runtime.applyGroupColor('g1', '#ff0000');
    expect(useAppStore.getState().bondedGroupColorAssignments).toHaveLength(0);
  });

  it('applyGroupColor skips assignment on partial stable-ID resolution', () => {
    const groupAtoms: Record<string, number[]> = { g1: [0, 1, 2] };
    const runtime = createBondedGroupAppearanceRuntime({
      getBondedGroupRuntime: () => ({
        getAtomIndicesForGroup: (id: string) => groupAtoms[id] ?? null,
      }),
      getRenderer: () => ({ setAtomColorOverrides: vi.fn() }),
      getStableAtomIds: () => [100, 101],
    });
    runtime.applyGroupColor('g1', '#ff0000');
    expect(useAppStore.getState().bondedGroupColorAssignments).toHaveLength(0);
  });

  it('renderer projection follows identity drift (slot reorder)', () => {
    let stableIds = [100, 101, 102];
    const groupAtoms: Record<string, number[]> = { g1: [0, 1] };
    const mockRenderer = { setAtomColorOverrides: vi.fn() };
    const runtime = createBondedGroupAppearanceRuntime({
      getBondedGroupRuntime: () => ({
        getAtomIndicesForGroup: (id: string) => groupAtoms[id] ?? null,
      }),
      getRenderer: () => mockRenderer,
      getStableAtomIds: () => stableIds,
    });

    runtime.applyGroupColor('g1', '#ff0000');
    const assignments = useAppStore.getState().bondedGroupColorAssignments;
    expect(assignments[0].atomIds).toEqual([100, 101]);

    // Simulate identity reorder: stable IDs shift to different slots
    stableIds = [102, 100, 101];
    mockRenderer.setAtomColorOverrides.mockClear();
    runtime.syncToRenderer();

    // Renderer should now color slots 1 and 2 (where 100 and 101 landed),
    // NOT the original slots 0 and 1
    const call = mockRenderer.setAtomColorOverrides.mock.calls.at(-1)![0];
    expect(call[1]).toEqual({ hex: '#ff0000' });
    expect(call[2]).toEqual({ hex: '#ff0000' });
    expect(call[0]).toBeUndefined();
  });

  it('pruneAndSync removes assignments for atoms no longer in identity set', () => {
    let stableIds = [100, 101, 102];
    const groupAtoms: Record<string, number[]> = { g1: [0, 1] };
    const mockRenderer = { setAtomColorOverrides: vi.fn() };
    const runtime = createBondedGroupAppearanceRuntime({
      getBondedGroupRuntime: () => ({
        getAtomIndicesForGroup: (id: string) => groupAtoms[id] ?? null,
      }),
      getRenderer: () => mockRenderer,
      getStableAtomIds: () => stableIds,
    });

    runtime.applyGroupColor('g1', '#ff0000');
    expect(useAppStore.getState().bondedGroupColorAssignments[0].atomIds).toEqual([100, 101]);

    // Simulate atom removal: only atom 102 survives (atomCount=1)
    stableIds = [102];
    runtime.pruneAndSync(1);
    expect(useAppStore.getState().bondedGroupColorAssignments).toHaveLength(0);
  });
});

// ── Regression: pre-interaction coloring with lazy tracker ──

describe('coloring before interaction with eager tracker init', () => {
  beforeEach(() => {
    useAppStore.getState().resetTransientState();
  });

  it('coloring works with eagerly-initialized tracker (no -1 placeholders)', () => {
    const groupAtoms: Record<string, number[]> = { g1: [0, 1, 2] };
    const mockRenderer = { setAtomColorOverrides: vi.fn() };
    const stableIds = [100, 101, 102];
    const runtime = createBondedGroupAppearanceRuntime({
      getBondedGroupRuntime: () => ({
        getAtomIndicesForGroup: (id: string) => groupAtoms[id] ?? null,
      }),
      getRenderer: () => mockRenderer,
      getStableAtomIds: () => stableIds,
    });

    runtime.applyGroupColor('g1', '#ff0000');
    const assignments = useAppStore.getState().bondedGroupColorAssignments;
    expect(assignments).toHaveLength(1);
    expect(assignments[0].atomIds).toEqual([100, 101, 102]);
    expect(assignments[0].atomIds.every((id: number) => id >= 0)).toBe(true);

    const call = mockRenderer.setAtomColorOverrides.mock.calls.at(-1)![0];
    expect(Object.keys(call)).toHaveLength(3);
    expect(call[0]).toEqual({ hex: '#ff0000' });
    expect(call[1]).toEqual({ hex: '#ff0000' });
    expect(call[2]).toEqual({ hex: '#ff0000' });
  });

  it('negative atomIds are rejected during projection', () => {
    const groupAtoms: Record<string, number[]> = { g1: [0, 1] };
    const mockRenderer = { setAtomColorOverrides: vi.fn() };
    const runtime = createBondedGroupAppearanceRuntime({
      getBondedGroupRuntime: () => ({
        getAtomIndicesForGroup: (id: string) => groupAtoms[id] ?? null,
      }),
      getRenderer: () => mockRenderer,
      getStableAtomIds: () => [-1, -1],
    });

    runtime.applyGroupColor('g1', '#ff0000');
    expect(useAppStore.getState().bondedGroupColorAssignments).toHaveLength(0);
  });

  it('coloring second molecule after append works when tracker is initialized', () => {
    let groupAtoms: Record<string, number[]> = { g1: [0, 1, 2], g2: [3, 4, 5] };
    const mockRenderer = { setAtomColorOverrides: vi.fn() };
    const stableIds = [100, 101, 102, 200, 201, 202];
    const runtime = createBondedGroupAppearanceRuntime({
      getBondedGroupRuntime: () => ({
        getAtomIndicesForGroup: (id: string) => groupAtoms[id] ?? null,
      }),
      getRenderer: () => mockRenderer,
      getStableAtomIds: () => stableIds,
    });

    runtime.applyGroupColor('g1', '#ff0000');
    runtime.applyGroupColor('g2', '#00ff00');
    const assignments = useAppStore.getState().bondedGroupColorAssignments;
    expect(assignments).toHaveLength(2);
    expect(assignments[0].atomIds).toEqual([100, 101, 102]);
    expect(assignments[1].atomIds).toEqual([200, 201, 202]);

    const call = mockRenderer.setAtomColorOverrides.mock.calls.at(-1)![0];
    expect(Object.keys(call)).toHaveLength(6);
    expect(call[0]).toEqual({ hex: '#ff0000' });
    expect(call[3]).toEqual({ hex: '#00ff00' });
  });
});

// ── handleAppend invariant ──

import { createTimelineAtomIdentityTracker } from '../../lab/js/runtime/timeline/timeline-atom-identity';

describe('handleAppend non-contiguous append invariant', () => {
  it('throws on gap between existing tracker state and append offset', () => {
    const tracker = createTimelineAtomIdentityTracker();
    tracker.captureForCurrentState(3);
    expect(() => tracker.handleAppend(5, 2)).toThrow(/non-contiguous/);
  });

  it('succeeds when append offset matches tracker length', () => {
    const tracker = createTimelineAtomIdentityTracker();
    tracker.captureForCurrentState(3);
    const ids = tracker.handleAppend(3, 2);
    expect(ids).toHaveLength(2);
    expect(ids[0]).toBe(3);
    expect(ids[1]).toBe(4);
  });

  it('succeeds for first append at offset 0', () => {
    const tracker = createTimelineAtomIdentityTracker();
    const ids = tracker.handleAppend(0, 3);
    expect(ids).toEqual([0, 1, 2]);
  });
});

// ── Persistence Semantics (Annotation Model) ──

describe('bonded-group color persistence (annotation model)', () => {
  beforeEach(() => {
    useAppStore.getState().resetTransientState();
  });

  it('21a: color overrides persist across timeline mode changes', () => {
    // Raw override seeding — tests persistence semantics, not authored ownership
    useAppStore.setState({ bondedGroupColorOverrides: { 0: { hex: '#ff0000' } } });
    useAppStore.getState().setTimelineMode('review');
    expect(useAppStore.getState().bondedGroupColorOverrides[0]).toEqual({ hex: '#ff0000' });

    useAppStore.getState().setTimelineMode('live');
    expect(useAppStore.getState().bondedGroupColorOverrides[0]).toEqual({ hex: '#ff0000' });
  });

  it('21b: color overrides are annotation-global, not timeline-historical', () => {
    // Raw override seeding — tests persistence semantics, not authored ownership
    useAppStore.setState({ bondedGroupColorOverrides: { 5: { hex: '#00ff00' } } });
    // Timeline mode changes do not clear overrides
    useAppStore.getState().setTimelineMode('review');
    useAppStore.getState().setTimelineMode('live');
    expect(Object.keys(useAppStore.getState().bondedGroupColorOverrides)).toHaveLength(1);
  });
});

// ── Coordinator lifecycle: appearance re-projection on display-frame transitions ──

import { createTimelineCoordinator, type TimelineCoordinatorDeps } from '../../lab/js/runtime/timeline/simulation-timeline-coordinator';
import { createSimulationTimeline } from '../../lab/js/runtime/timeline/simulation-timeline';

describe('coordinator calls syncBondedGroupsForDisplayFrame on all transitions', () => {
  function makeCoordinatorWithSpy() {
    const timeline = createSimulationTimeline();
    timeline.recordFrame({ timePs: 0.1, n: 2, positions: new Float64Array(6), interaction: null, boundary: { mode: 'contain', wallRadius: 100, wallCenter: [0, 0, 0], wallCenterSet: true, removedCount: 0, damping: 0 } });
    timeline.recordFrame({ timePs: 10, n: 2, positions: new Float64Array(6), interaction: null, boundary: { mode: 'contain', wallRadius: 100, wallCenter: [0, 0, 0], wallCenterSet: true, removedCount: 0, damping: 0 } });
    timeline.recordRestartFrame({
      timePs: 0.1, n: 2,
      positions: new Float64Array(6),
      velocities: new Float64Array(6),
      bonds: [[0, 1, 1.42]],
      config: { damping: 0, kDrag: 2, kRotate: 5, dtFs: 0.5, dampingRefDurationFs: 2.0 },
      interaction: null,
      boundary: { mode: 'contain', wallRadius: 100, wallCenter: [0, 0, 0], wallCenterSet: true, removedCount: 0, damping: 0 },
    });

    const syncSpy = vi.fn();
    const mockPhysics = {
      n: 2, pos: new Float64Array(6), vel: new Float64Array(6),
      force: new Float64Array(6), bonds: [[0, 1, 1.42]], dragAtom: -1,
      restoreCheckpoint: vi.fn(), restoreBoundarySnapshot: vi.fn(),
      setDamping: vi.fn(), setDragStrength: vi.fn(), setRotateStrength: vi.fn(),
      endDrag: vi.fn(),
    };
    const mockRenderer = {
      getAtomCount: () => 2,
      setAtomCount: vi.fn(),
      setPhysicsRef: vi.fn(),
      updateFromSnapshot: vi.fn(),
      updateReviewFrame: vi.fn(),
    };

    const deps: TimelineCoordinatorDeps = {
      timeline,
      getPhysics: () => mockPhysics as any,
      getRenderer: () => mockRenderer as any,
      pause: vi.fn(),
      resume: vi.fn(),
      isPaused: () => false,
      reinitWorker: vi.fn(async () => {}),
      isWorkerActive: () => false,
      forceRender: vi.fn(),
      syncStoreState: vi.fn(),
      setSimTimePs: vi.fn(),
      clearBondedGroupHighlight: vi.fn(),
      clearRendererFeedback: vi.fn(),
      syncBondedGroupsForDisplayFrame: syncSpy,
      syncPhysicsConfigToStore: vi.fn(),
    };

    const coordinator = createTimelineCoordinator(deps);
    return { coordinator, syncSpy, timeline };
  }

  it('enterReview calls syncBondedGroupsForDisplayFrame', () => {
    const { coordinator, syncSpy } = makeCoordinatorWithSpy();
    coordinator.enterReview(0.1);
    expect(syncSpy).toHaveBeenCalled();
  });

  it('scrubTo calls syncBondedGroupsForDisplayFrame', () => {
    const { coordinator, syncSpy } = makeCoordinatorWithSpy();
    coordinator.enterReview(0.1);
    syncSpy.mockClear();
    coordinator.scrubTo(10);
    expect(syncSpy).toHaveBeenCalled();
  });

  it('returnToLive calls syncBondedGroupsForDisplayFrame', () => {
    const { coordinator, syncSpy } = makeCoordinatorWithSpy();
    coordinator.enterReview(0.1);
    syncSpy.mockClear();
    coordinator.returnToLive();
    expect(syncSpy).toHaveBeenCalled();
  });

  it('restartFromHere calls syncBondedGroupsForDisplayFrame', async () => {
    const { coordinator, syncSpy } = makeCoordinatorWithSpy();
    coordinator.enterReview(0.1);
    syncSpy.mockClear();
    await coordinator.restartFromHere();
    expect(syncSpy).toHaveBeenCalled();
  });
});
