/**
 * @vitest-environment jsdom
 */
/**
 * Bonded group runtime tests.
 *
 * Verifies:
 * - Connected-component projection produces correct summaries
 * - Stable tie ordering (equal-size groups stay in order)
 * - Merge reconciliation (merged group inherits largest-overlap ID)
 * - Split reconciliation (larger-overlap child inherits ID)
 * - No-op suppression (identical projections don't trigger store update)
 * - Panel expand/collapse via store
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createBondedGroupRuntime, type BondedGroupPhysics } from '../../page/js/runtime/bonded-group-runtime';
import { useAppStore } from '../../page/js/store/app-store';

function makePhysics(components: { atoms: number[]; size: number }[]): BondedGroupPhysics {
  const totalAtoms = components.reduce((sum, c) => sum + c.size, 0);
  return { n: totalAtoms, components };
}

describe('bonded group projection', () => {
  let physics: BondedGroupPhysics | null;

  beforeEach(() => {
    useAppStore.getState().resetTransientState();
    physics = null;
  });

  function createRuntime() {
    return createBondedGroupRuntime({ getPhysics: () => physics });
  }

  it('projects components into store sorted by size desc', () => {
    physics = makePhysics([
      { atoms: [0, 1, 2], size: 3 },
      { atoms: [3, 4, 5, 6, 7], size: 5 },
      { atoms: [8, 9], size: 2 },
    ]);
    const rt = createRuntime();
    rt.projectNow();

    const groups = useAppStore.getState().bondedGroups;
    expect(groups).toHaveLength(3);
    expect(groups[0].atomCount).toBe(5); // largest first
    expect(groups[0].displayIndex).toBe(1);
    expect(groups[1].atomCount).toBe(3);
    expect(groups[1].displayIndex).toBe(2);
    expect(groups[2].atomCount).toBe(2);
    expect(groups[2].displayIndex).toBe(3);
  });

  it('minAtomIndex is correct for each group', () => {
    physics = makePhysics([
      { atoms: [5, 6, 7], size: 3 },
      { atoms: [0, 1], size: 2 },
    ]);
    const rt = createRuntime();
    rt.projectNow();

    const groups = useAppStore.getState().bondedGroups;
    expect(groups[0].minAtomIndex).toBe(5); // 3-atom group
    expect(groups[1].minAtomIndex).toBe(0); // 2-atom group
  });

  it('empty physics produces empty groups', () => {
    physics = makePhysics([]);
    const rt = createRuntime();
    rt.projectNow();
    expect(useAppStore.getState().bondedGroups).toHaveLength(0);
  });

  it('null physics produces empty groups', () => {
    physics = null;
    const rt = createRuntime();
    rt.projectNow();
    expect(useAppStore.getState().bondedGroups).toHaveLength(0);
  });

  it('reset clears groups', () => {
    physics = makePhysics([{ atoms: [0, 1], size: 2 }]);
    const rt = createRuntime();
    rt.projectNow();
    expect(useAppStore.getState().bondedGroups).toHaveLength(1);

    rt.reset();
    expect(useAppStore.getState().bondedGroups).toHaveLength(0);
  });
});

describe('stable tie ordering', () => {
  beforeEach(() => {
    useAppStore.getState().resetTransientState();
  });

  it('equal-size groups maintain order across projections', () => {
    // Two groups of size 3 — their order should be stable
    let physics: BondedGroupPhysics = makePhysics([
      { atoms: [0, 1, 2], size: 3 },
      { atoms: [3, 4, 5], size: 3 },
    ]);
    const rt = createBondedGroupRuntime({ getPhysics: () => physics });
    rt.projectNow();

    const first = useAppStore.getState().bondedGroups;
    const id0 = first[0].id;
    const id1 = first[1].id;

    // Project again with same data — order should not change
    rt.projectNow();
    const second = useAppStore.getState().bondedGroups;
    expect(second[0].id).toBe(id0);
    expect(second[1].id).toBe(id1);

    // Project with components in reversed array order — same groups, should keep same order
    physics = makePhysics([
      { atoms: [3, 4, 5], size: 3 },
      { atoms: [0, 1, 2], size: 3 },
    ]);
    rt.projectNow();
    const third = useAppStore.getState().bondedGroups;
    expect(third[0].id).toBe(id0);
    expect(third[1].id).toBe(id1);
  });
});

describe('merge reconciliation', () => {
  beforeEach(() => {
    useAppStore.getState().resetTransientState();
  });

  it('merged group inherits ID from largest-overlap predecessor', () => {
    // Start with two groups
    let physics: BondedGroupPhysics = makePhysics([
      { atoms: [0, 1, 2], size: 3 },
      { atoms: [3, 4], size: 2 },
    ]);
    const rt = createBondedGroupRuntime({ getPhysics: () => physics });
    rt.projectNow();

    const before = useAppStore.getState().bondedGroups;
    const bigId = before[0].id; // the 3-atom group

    // Merge: both groups combine into one 5-atom group
    physics = makePhysics([
      { atoms: [0, 1, 2, 3, 4], size: 5 },
    ]);
    rt.projectNow();

    const after = useAppStore.getState().bondedGroups;
    expect(after).toHaveLength(1);
    // Should inherit the ID from the 3-atom group (largest overlap)
    expect(after[0].id).toBe(bigId);
    expect(after[0].atomCount).toBe(5);
  });
});

describe('split reconciliation', () => {
  beforeEach(() => {
    useAppStore.getState().resetTransientState();
  });

  it('larger-overlap child inherits original ID, other gets new ID', () => {
    // Start with one big group
    let physics: BondedGroupPhysics = makePhysics([
      { atoms: [0, 1, 2, 3, 4], size: 5 },
    ]);
    const rt = createBondedGroupRuntime({ getPhysics: () => physics });
    rt.projectNow();

    const before = useAppStore.getState().bondedGroups;
    const originalId = before[0].id;

    // Split: 3 atoms stay, 2 break off
    physics = makePhysics([
      { atoms: [0, 1, 2], size: 3 },
      { atoms: [3, 4], size: 2 },
    ]);
    rt.projectNow();

    const after = useAppStore.getState().bondedGroups;
    expect(after).toHaveLength(2);
    // Larger child (3 atoms, more overlap) should inherit original ID
    expect(after[0].id).toBe(originalId);
    expect(after[0].atomCount).toBe(3);
    // Smaller child gets a new ID
    expect(after[1].id).not.toBe(originalId);
    expect(after[1].atomCount).toBe(2);
  });
});

describe('no-op suppression', () => {
  beforeEach(() => {
    useAppStore.getState().resetTransientState();
  });

  it('minAtomIndex change triggers store update', () => {
    let physics: BondedGroupPhysics = makePhysics([
      { atoms: [5, 6, 7], size: 3 },
    ]);
    const rt = createBondedGroupRuntime({ getPhysics: () => physics });
    rt.projectNow();
    const ref1 = useAppStore.getState().bondedGroups;
    expect(ref1[0].minAtomIndex).toBe(5);

    // Same size group but different atoms — minAtomIndex changes
    physics = makePhysics([{ atoms: [3, 5, 6], size: 3 }]);
    rt.projectNow();
    const ref2 = useAppStore.getState().bondedGroups;
    expect(ref2[0].minAtomIndex).toBe(3);
    // Store reference should differ (new update was published)
    expect(ref1).not.toBe(ref2);
  });

  it('new equal-size groups sort by minAtomIndex fallback', () => {
    // Two brand-new groups with same size — orderKey is MAX_SAFE_INTEGER for both
    const physics = makePhysics([
      { atoms: [10, 11], size: 2 },
      { atoms: [3, 4], size: 2 },
    ]);
    const rt = createBondedGroupRuntime({ getPhysics: () => physics });
    rt.projectNow();

    const groups = useAppStore.getState().bondedGroups;
    expect(groups).toHaveLength(2);
    // minAtomIndex 3 < 10, so [3,4] group sorts first
    expect(groups[0].minAtomIndex).toBe(3);
    expect(groups[1].minAtomIndex).toBe(10);
  });

  it('identical projections do not trigger store update', () => {
    const physics = makePhysics([
      { atoms: [0, 1, 2], size: 3 },
      { atoms: [3, 4], size: 2 },
    ]);
    const rt = createBondedGroupRuntime({ getPhysics: () => physics });

    rt.projectNow();
    const ref1 = useAppStore.getState().bondedGroups;

    rt.projectNow();
    const ref2 = useAppStore.getState().bondedGroups;

    // Should be the same reference (no new array created)
    expect(ref1).toBe(ref2);
  });
});

describe('panel store behavior', () => {
  beforeEach(() => {
    useAppStore.getState().resetTransientState();
  });

  it('bondedGroupsExpanded defaults to false', () => {
    expect(useAppStore.getState().bondedGroupsExpanded).toBe(false);
  });

  it('toggleBondedGroupsExpanded toggles the flag', () => {
    useAppStore.getState().toggleBondedGroupsExpanded();
    expect(useAppStore.getState().bondedGroupsExpanded).toBe(true);
    useAppStore.getState().toggleBondedGroupsExpanded();
    expect(useAppStore.getState().bondedGroupsExpanded).toBe(false);
  });

  it('resetTransientState collapses panel and clears groups', () => {
    useAppStore.getState().setBondedGroups([
      { id: 'g1', displayIndex: 1, atomCount: 5, minAtomIndex: 0, orderKey: 0 },
    ]);
    useAppStore.getState().toggleBondedGroupsExpanded();
    expect(useAppStore.getState().bondedGroupsExpanded).toBe(true);
    expect(useAppStore.getState().bondedGroups).toHaveLength(1);

    useAppStore.getState().resetTransientState();
    expect(useAppStore.getState().bondedGroupsExpanded).toBe(false);
    expect(useAppStore.getState().bondedGroups).toHaveLength(0);
  });

  it('bondedSmallGroupsExpanded defaults to false and toggles', () => {
    expect(useAppStore.getState().bondedSmallGroupsExpanded).toBe(false);
    useAppStore.getState().toggleBondedSmallGroupsExpanded();
    expect(useAppStore.getState().bondedSmallGroupsExpanded).toBe(true);
    useAppStore.getState().toggleBondedSmallGroupsExpanded();
    expect(useAppStore.getState().bondedSmallGroupsExpanded).toBe(false);
  });

  it('resetTransientState collapses small groups too', () => {
    useAppStore.getState().toggleBondedSmallGroupsExpanded();
    expect(useAppStore.getState().bondedSmallGroupsExpanded).toBe(true);
    useAppStore.getState().resetTransientState();
    expect(useAppStore.getState().bondedSmallGroupsExpanded).toBe(false);
  });
});

describe('partitionBondedGroups', () => {
  it('partitions into large and small buckets', async () => {
    const { partitionBondedGroups } = await import('../../page/js/store/selectors/bonded-groups');
    const groups = [
      { id: 'a', displayIndex: 1, atomCount: 42, minAtomIndex: 0, orderKey: 0 },
      { id: 'b', displayIndex: 2, atomCount: 3, minAtomIndex: 42, orderKey: 1 },
      { id: 'c', displayIndex: 3, atomCount: 2, minAtomIndex: 45, orderKey: 2 },
      { id: 'd', displayIndex: 4, atomCount: 10, minAtomIndex: 47, orderKey: 3 },
    ];
    const { large, small } = partitionBondedGroups(groups);
    expect(large).toHaveLength(2); // 42 and 10
    expect(small).toHaveLength(2); // 3 and 2
    expect(large[0].atomCount).toBe(42);
    expect(large[1].atomCount).toBe(10);
    expect(small[0].atomCount).toBe(3);
    expect(small[1].atomCount).toBe(2);
  });

  it('custom threshold works', async () => {
    const { partitionBondedGroups } = await import('../../page/js/store/selectors/bonded-groups');
    const groups = [
      { id: 'a', displayIndex: 1, atomCount: 5, minAtomIndex: 0, orderKey: 0 },
      { id: 'b', displayIndex: 2, atomCount: 4, minAtomIndex: 5, orderKey: 1 },
    ];
    const { large, small } = partitionBondedGroups(groups, 4);
    expect(large).toHaveLength(1); // 5 > 4
    expect(small).toHaveLength(1); // 4 <= 4
  });
});

describe('selection invalidation', () => {
  let physics: BondedGroupPhysics | null;

  beforeEach(() => {
    useAppStore.getState().resetTransientState();
    physics = null;
  });

  function createRuntime() {
    return createBondedGroupRuntime({ getPhysics: () => physics });
  }

  it('clears selection when selected group disappears after merge', () => {
    // Start with two groups, select one
    physics = makePhysics([
      { atoms: [0, 1, 2], size: 3 },
      { atoms: [3, 4], size: 2 },
    ]);
    const rt = createRuntime();
    rt.projectNow();

    const groups = useAppStore.getState().bondedGroups;
    const smallGroupId = groups[1].id; // the 2-atom group
    useAppStore.getState().setSelectedBondedGroup(smallGroupId);
    expect(useAppStore.getState().selectedBondedGroupId).toBe(smallGroupId);

    // Merge: small group absorbed into big group
    physics = makePhysics([
      { atoms: [0, 1, 2, 3, 4], size: 5 },
    ]);
    rt.projectNow();

    // Selection should be cleared (small group ID no longer exists)
    expect(useAppStore.getState().selectedBondedGroupId).toBeNull();
  });

  it('preserves selection when selected group survives reconciliation', () => {
    physics = makePhysics([
      { atoms: [0, 1, 2], size: 3 },
      { atoms: [3, 4], size: 2 },
    ]);
    const rt = createRuntime();
    rt.projectNow();

    const groups = useAppStore.getState().bondedGroups;
    const bigGroupId = groups[0].id;
    useAppStore.getState().setSelectedBondedGroup(bigGroupId);

    // Same groups, different component order — big group survives
    physics = makePhysics([
      { atoms: [3, 4], size: 2 },
      { atoms: [0, 1, 2], size: 3 },
    ]);
    rt.projectNow();

    // Selection preserved
    expect(useAppStore.getState().selectedBondedGroupId).toBe(bigGroupId);
  });

  it('clears selection on empty projection', () => {
    physics = makePhysics([{ atoms: [0, 1], size: 2 }]);
    const rt = createRuntime();
    rt.projectNow();

    const id = useAppStore.getState().bondedGroups[0].id;
    useAppStore.getState().setSelectedBondedGroup(id);

    // Physics goes empty
    physics = makePhysics([]);
    rt.projectNow();

    expect(useAppStore.getState().selectedBondedGroupId).toBeNull();
  });

  it('clears selection on null physics', () => {
    physics = makePhysics([{ atoms: [0, 1], size: 2 }]);
    const rt = createRuntime();
    rt.projectNow();

    useAppStore.getState().setSelectedBondedGroup(useAppStore.getState().bondedGroups[0].id);

    physics = null;
    rt.projectNow();

    expect(useAppStore.getState().selectedBondedGroupId).toBeNull();
  });

  it('clears selection on reset()', () => {
    physics = makePhysics([{ atoms: [0, 1], size: 2 }]);
    const rt = createRuntime();
    rt.projectNow();

    useAppStore.getState().setSelectedBondedGroup(useAppStore.getState().bondedGroups[0].id);
    rt.reset();

    expect(useAppStore.getState().selectedBondedGroupId).toBeNull();
  });
});
