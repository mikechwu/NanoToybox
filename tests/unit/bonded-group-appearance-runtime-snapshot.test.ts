/**
 * @vitest-environment jsdom
 *
 * Tests for the snapshot/restore API on `BondedGroupAppearanceRuntime`,
 * added for plan-rev-4 phase 1 (Watch → Lab color transport). These
 * methods are the rollback capture + restore surface used by the
 * transactional hydrate; they MUST be deep-structural.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useAppStore, type BondedGroupColorAssignment } from '../../lab/js/store/app-store';
import { createBondedGroupAppearanceRuntime } from '../../lab/js/runtime/bonded-group-appearance-runtime';

function makeRuntime() {
  const groupAtoms: Record<string, number[]> = { g1: [0, 1], g2: [2, 3] };
  const mockRenderer = { setAtomColorOverrides: vi.fn() };
  const runtime = createBondedGroupAppearanceRuntime({
    getBondedGroupRuntime: () => ({
      getAtomIndicesForGroup: (id: string) => groupAtoms[id] ?? null,
    }),
    getRenderer: () => mockRenderer,
    getStableAtomIds: () => [0, 1, 2, 3],
  });
  return { runtime, mockRenderer };
}

describe('BondedGroupAppearanceRuntime — snapshot/restore', () => {
  beforeEach(() => {
    useAppStore.getState().resetTransientState();
  });

  it('snapshotAssignments returns a structural deep-copy (mutation does not leak)', () => {
    const { runtime } = makeRuntime();
    runtime.applyGroupColor('g1', '#ff0000');
    const snap = runtime.snapshotAssignments();
    expect(snap).toHaveLength(1);

    // Mutating the snapshot must not touch live state.
    snap[0].colorHex = '#00ff00';
    snap[0].atomIds.push(42);
    snap[0].atomIndices.push(99);

    const live = useAppStore.getState().bondedGroupColorAssignments;
    expect(live[0].colorHex).toBe('#ff0000');
    expect(live[0].atomIds).not.toContain(42);
    expect(live[0].atomIndices).not.toContain(99);
  });

  it('restoreAssignments replaces state, rebuilds overrides, syncs renderer', () => {
    const { runtime, mockRenderer } = makeRuntime();
    runtime.applyGroupColor('g1', '#ff0000');

    const restored: BondedGroupColorAssignment[] = [
      { id: 'from-watch', atomIds: [2, 3], atomIndices: [2, 3], colorHex: '#00aaff', sourceGroupId: 'gX' },
    ];
    mockRenderer.setAtomColorOverrides.mockClear();
    runtime.restoreAssignments(restored);

    const live = useAppStore.getState().bondedGroupColorAssignments;
    expect(live).toHaveLength(1);
    expect(live[0].id).toBe('from-watch');
    expect(live[0].colorHex).toBe('#00aaff');

    const overrides = useAppStore.getState().bondedGroupColorOverrides;
    expect(overrides[2]).toEqual({ hex: '#00aaff' });
    expect(overrides[3]).toEqual({ hex: '#00aaff' });
    expect(overrides[0]).toBeUndefined();

    expect(mockRenderer.setAtomColorOverrides).toHaveBeenCalled();
  });

  it('roundtrip stability: snapshot → mutate state → restore yields identical state', () => {
    const { runtime } = makeRuntime();
    runtime.applyGroupColor('g1', '#ff0000');
    runtime.applyGroupColor('g2', '#00ff00');
    const snap = runtime.snapshotAssignments();

    // Mutate — add a third assignment, clear one.
    runtime.clearGroupColor('g1');
    runtime.applyGroupColor('g2', '#ffffff'); // re-color
    expect(useAppStore.getState().bondedGroupColorAssignments.length).toBe(1);

    runtime.restoreAssignments(snap);
    const restored = useAppStore.getState().bondedGroupColorAssignments;
    expect(restored.length).toBe(snap.length);
    for (let i = 0; i < snap.length; i++) {
      expect(restored[i].id).toBe(snap[i].id);
      expect(restored[i].colorHex).toBe(snap[i].colorHex);
      expect(restored[i].atomIds).toEqual(snap[i].atomIds);
      expect(restored[i].sourceGroupId).toBe(snap[i].sourceGroupId);
    }
  });

  it('restore with empty array clears all assignments and overrides', () => {
    const { runtime } = makeRuntime();
    runtime.applyGroupColor('g1', '#ff0000');
    runtime.restoreAssignments([]);
    expect(useAppStore.getState().bondedGroupColorAssignments).toHaveLength(0);
    expect(Object.keys(useAppStore.getState().bondedGroupColorOverrides)).toHaveLength(0);
  });
});
