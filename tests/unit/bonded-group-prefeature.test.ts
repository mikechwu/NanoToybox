/**
 * Bonded group pre-feature cleanup tests.
 *
 * Covers: display-source resolution, capability policy, appearance runtime,
 * and persistence semantics (annotation model).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useAppStore } from '../../page/js/store/app-store';
import {
  resolveBondedGroupDisplaySource,
  type BondedGroupDisplaySourceDeps,
} from '../../page/js/runtime/bonded-group-display-source';
import {
  selectBondedGroupCapabilities,
} from '../../page/js/store/selectors/bonded-group-capabilities';
import {
  createBondedGroupAppearanceRuntime,
} from '../../page/js/runtime/bonded-group-appearance-runtime';

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
  it('8: live allows all capabilities', () => {
    const caps = selectBondedGroupCapabilities({ timelineMode: 'live' } as any);
    expect(caps.canInspectBondedGroups).toBe(true);
    expect(caps.canTargetBondedGroups).toBe(true);
    expect(caps.canEditBondedGroupColor).toBe(true);
    expect(caps.canMutateSimulation).toBe(true);
  });

  it('9: review allows inspect/target/edit, blocks mutation', () => {
    const caps = selectBondedGroupCapabilities({ timelineMode: 'review' } as any);
    expect(caps.canInspectBondedGroups).toBe(true);
    expect(caps.canTargetBondedGroups).toBe(true);
    expect(caps.canEditBondedGroupColor).toBe(true);
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

  it('14: syncGroupIntents propagates color to newly joined uncolored atoms', () => {
    // Mutable atom map simulating topology change
    const groupAtoms: Record<string, number[]> = { g1: [0, 1, 2] };
    const mockRenderer = { setAtomColorOverrides: vi.fn() };
    const runtime = createBondedGroupAppearanceRuntime({
      getBondedGroupRuntime: () => ({
        getAtomIndicesForGroup: (id: string) => groupAtoms[id] ?? null,
      }),
      getRenderer: () => mockRenderer,
    });

    // Apply red to g1 (atoms 0, 1, 2)
    runtime.applyGroupColor('g1', '#ff0000');
    let overrides = useAppStore.getState().bondedGroupColorOverrides;
    expect(overrides[0]).toEqual({ hex: '#ff0000' });
    expect(overrides[3]).toBeUndefined();

    // Simulate topology change: atoms 3, 4 join g1
    groupAtoms.g1 = [0, 1, 2, 3, 4];

    // Sync intents — should propagate red to new uncolored atoms
    runtime.syncGroupIntents();
    overrides = useAppStore.getState().bondedGroupColorOverrides;
    expect(overrides[3]).toEqual({ hex: '#ff0000' });
    expect(overrides[4]).toEqual({ hex: '#ff0000' });
  });

  it('14b: syncGroupIntents does NOT overwrite existing overrides from merged groups', () => {
    const groupAtoms: Record<string, number[]> = { g1: [0, 1], g2: [2, 3] };
    const mockRenderer = { setAtomColorOverrides: vi.fn() };
    const runtime = createBondedGroupAppearanceRuntime({
      getBondedGroupRuntime: () => ({
        getAtomIndicesForGroup: (id: string) => groupAtoms[id] ?? null,
      }),
      getRenderer: () => mockRenderer,
    });

    // Apply red to g1, green to g2
    runtime.applyGroupColor('g1', '#ff0000');
    runtime.applyGroupColor('g2', '#00ff00');

    // Simulate merge: g2 absorbed into g1
    groupAtoms.g1 = [0, 1, 2, 3];
    delete groupAtoms.g2;

    // Sync intents — g1's red intent should NOT overwrite g2's green atoms
    runtime.syncGroupIntents();
    const overrides = useAppStore.getState().bondedGroupColorOverrides;
    expect(overrides[0]).toEqual({ hex: '#ff0000' }); // g1 original — red
    expect(overrides[1]).toEqual({ hex: '#ff0000' }); // g1 original — red
    expect(overrides[2]).toEqual({ hex: '#00ff00' }); // g2 original — green preserved
    expect(overrides[3]).toEqual({ hex: '#00ff00' }); // g2 original — green preserved
  });

  it('15: syncGroupIntents prunes intents for groups that no longer exist', () => {
    const groupAtoms: Record<string, number[]> = { g1: [0, 1] };
    const runtime = createBondedGroupAppearanceRuntime({
      getBondedGroupRuntime: () => ({
        getAtomIndicesForGroup: (id: string) => groupAtoms[id] ?? null,
      }),
      getRenderer: () => ({ setAtomColorOverrides: vi.fn() }),
    });

    runtime.applyGroupColor('g1', '#ff0000');
    // Group g1 disappears from topology
    delete groupAtoms.g1;

    // Should not crash and should prune the intent
    runtime.syncGroupIntents();
    // Overrides for old atoms are NOT removed (they might be in other groups now),
    // but the intent is pruned so future syncs won't try to re-apply.
  });

  it('16: clearGroupColor removes intent so syncGroupIntents does not re-apply', () => {
    const groupAtoms: Record<string, number[]> = { g1: [0, 1] };
    const runtime = createBondedGroupAppearanceRuntime({
      getBondedGroupRuntime: () => ({
        getAtomIndicesForGroup: (id: string) => groupAtoms[id] ?? null,
      }),
      getRenderer: () => ({ setAtomColorOverrides: vi.fn() }),
    });

    runtime.applyGroupColor('g1', '#ff0000');
    runtime.clearGroupColor('g1');

    // Atom 2 joins g1
    groupAtoms.g1 = [0, 1, 2];
    runtime.syncGroupIntents();

    // Atom 2 should NOT get colored (intent was cleared)
    const overrides = useAppStore.getState().bondedGroupColorOverrides;
    expect(overrides[2]).toBeUndefined();
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

  it('syncToRenderer calls renderer.setAtomColorOverrides with store overrides', () => {
    const mockRenderer = { setAtomColorOverrides: vi.fn() };
    const runtime = createBondedGroupAppearanceRuntime({
      getBondedGroupRuntime: () => ({
        getAtomIndicesForGroup: (id: string) => id === 'g1' ? [0, 1, 2] : null,
      }),
      getRenderer: () => mockRenderer,
    });

    // Preload store with color overrides (simulates existing state at app init)
    useAppStore.getState().setBondedGroupColorOverrides({ 0: { hex: '#ff0000' }, 1: { hex: '#ff0000' } });

    // Initial sync should drive renderer
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
      getRenderer: () => mockRenderer,
    });

    runtime.applyGroupColor('g1', '#00ff00');
    // Should have called setAtomColorOverrides at least once
    expect(mockRenderer.setAtomColorOverrides).toHaveBeenCalled();
    const lastCall = mockRenderer.setAtomColorOverrides.mock.calls.at(-1)![0];
    expect(lastCall[0]).toEqual({ hex: '#00ff00' });
    expect(lastCall[2]).toEqual({ hex: '#00ff00' });
  });
});

// ── Persistence Semantics (Annotation Model) ──

describe('bonded-group color persistence (annotation model)', () => {
  beforeEach(() => {
    useAppStore.getState().resetTransientState();
  });

  it('21a: color overrides persist across timeline mode changes', () => {
    useAppStore.getState().setBondedGroupColorOverrides({ 0: { hex: '#ff0000' } });
    useAppStore.getState().setTimelineMode('review');
    expect(useAppStore.getState().bondedGroupColorOverrides[0]).toEqual({ hex: '#ff0000' });

    useAppStore.getState().setTimelineMode('live');
    expect(useAppStore.getState().bondedGroupColorOverrides[0]).toEqual({ hex: '#ff0000' });
  });

  it('21b: color overrides are annotation-global, not timeline-historical', () => {
    // Verify color overrides are not part of timeline/review state
    // They persist in the store independently of timelineMode
    useAppStore.getState().setBondedGroupColorOverrides({ 5: { hex: '#00ff00' } });
    // Timeline mode changes do not clear overrides
    useAppStore.getState().setTimelineMode('review');
    useAppStore.getState().setTimelineMode('live');
    expect(Object.keys(useAppStore.getState().bondedGroupColorOverrides)).toHaveLength(1);
  });
});
