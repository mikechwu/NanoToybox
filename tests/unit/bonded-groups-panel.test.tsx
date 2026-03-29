/**
 * @vitest-environment jsdom
 */
/**
 * Component-level tests for BondedGroupsPanel.
 *
 * Verifies the two-level UI contract:
 * - Header click expands/collapses main list
 * - Small-clusters button expands only the small-group bucket
 * - Large clusters remain visible while small clusters stay collapsed
 * - Panel hidden when no groups
 */
import { describe, it, expect, beforeEach } from 'vitest';
import React from 'react';
import { render, fireEvent } from '@testing-library/react';
import { BondedGroupsPanel, setBondedGroupsPanelCallbacks } from '../../page/js/components/BondedGroupsPanel';
import { useAppStore, type BondedGroupSummary } from '../../page/js/store/app-store';

const FIXTURE_GROUPS: BondedGroupSummary[] = [
  { id: 'a', displayIndex: 1, atomCount: 42, minAtomIndex: 0, orderKey: 0 },
  { id: 'b', displayIndex: 2, atomCount: 10, minAtomIndex: 42, orderKey: 1 },
  { id: 'c', displayIndex: 3, atomCount: 3, minAtomIndex: 52, orderKey: 2 },
  { id: 'd', displayIndex: 4, atomCount: 2, minAtomIndex: 55, orderKey: 3 },
  { id: 'e', displayIndex: 5, atomCount: 1, minAtomIndex: 57, orderKey: 4 },
];

/** Helper to query within a single panel instance (avoids StrictMode duplicates). */
function renderPanel() {
  const { container } = render(<BondedGroupsPanel />);
  return container;
}

describe('BondedGroupsPanel', () => {
  beforeEach(() => {
    useAppStore.getState().resetTransientState();
    // Wire simple callbacks that directly update store (simulates highlight runtime)
    setBondedGroupsPanelCallbacks({
      onToggleSelect: (id) => {
        const s = useAppStore.getState();
        s.setSelectedBondedGroup(s.selectedBondedGroupId === id ? null : id);
      },
      onHover: (id) => {
        const s = useAppStore.getState();
        if (!s.selectedBondedGroupId) s.setHoveredBondedGroup(id);
      },
      onClearHighlight: () => {
        useAppStore.getState().clearBondedGroupHighlightState();
      },
    });
  });

  it('returns null when no groups', () => {
    const c = renderPanel();
    expect(c.innerHTML).toBe('');
  });

  it('shows collapsed header with group count', () => {
    useAppStore.getState().setBondedGroups(FIXTURE_GROUPS);
    const c = renderPanel();
    const header = c.querySelector('.bonded-groups-header');
    expect(header).toBeTruthy();
    expect(header!.textContent).toContain('Bonded Clusters');
    expect(header!.textContent).toContain('5');
    // No cluster rows when collapsed
    expect(c.querySelector('.bonded-groups-list')).toBeNull();
  });

  it('header click expands to show large clusters', () => {
    useAppStore.getState().setBondedGroups(FIXTURE_GROUPS);
    const c = renderPanel();

    // Click header to expand
    fireEvent.click(c.querySelector('.bonded-groups-header')!);

    const rows = c.querySelectorAll('.bonded-groups-row:not(.bonded-groups-small-toggle):not(.bonded-groups-small-row)');
    // 2 large clusters (42 and 10 atoms)
    expect(rows.length).toBe(2);
    expect(rows[0].textContent).toContain('Cluster 1');
    expect(rows[0].textContent).toContain('42 atoms');
    expect(rows[1].textContent).toContain('Cluster 2');
    expect(rows[1].textContent).toContain('10 atoms');

    // Small-clusters summary row visible
    const smallToggle = c.querySelector('.bonded-groups-small-toggle');
    expect(smallToggle).toBeTruthy();
    expect(smallToggle!.textContent).toContain('Small clusters');
    expect(smallToggle!.textContent).toContain('3');

    // Small cluster detail rows NOT visible
    expect(c.querySelectorAll('.bonded-groups-small-row').length).toBe(0);
  });

  it('small-clusters button expands only small groups', () => {
    useAppStore.getState().setBondedGroups(FIXTURE_GROUPS);
    useAppStore.getState().toggleBondedGroupsExpanded(); // expand main
    const c = renderPanel();

    // Click small-clusters toggle
    fireEvent.click(c.querySelector('.bonded-groups-small-toggle')!);

    // Small cluster rows now visible
    const smallRows = c.querySelectorAll('.bonded-groups-small-row');
    expect(smallRows.length).toBe(3); // 3, 2, 1 atoms
    expect(smallRows[0].textContent).toContain('Cluster 3');
    expect(smallRows[0].textContent).toContain('3 atoms');

    // Large clusters still visible
    const largeRows = c.querySelectorAll('.bonded-groups-row:not(.bonded-groups-small-toggle):not(.bonded-groups-small-row)');
    expect(largeRows.length).toBe(2);
  });

  it('second header click collapses everything', () => {
    useAppStore.getState().setBondedGroups(FIXTURE_GROUPS);
    useAppStore.getState().toggleBondedGroupsExpanded();
    const c = renderPanel();

    // Large clusters visible
    expect(c.querySelectorAll('.bonded-groups-row').length).toBeGreaterThan(0);

    // Click header again
    fireEvent.click(c.querySelector('.bonded-groups-header')!);

    // Everything collapsed
    expect(c.querySelector('.bonded-groups-list')).toBeNull();
  });

  it('uses side-left class by default', () => {
    useAppStore.getState().setBondedGroups(FIXTURE_GROUPS);
    const c = renderPanel();
    const panel = c.querySelector('.bonded-groups-panel');
    expect(panel?.classList.contains('side-left')).toBe(true);
    expect(panel?.classList.contains('side-right')).toBe(false);
  });

  it('uses side-right class when store side is right', () => {
    useAppStore.getState().setBondedGroups(FIXTURE_GROUPS);
    useAppStore.getState().setBondedGroupsSide('right');
    const c = renderPanel();
    const panel = c.querySelector('.bonded-groups-panel');
    expect(panel?.classList.contains('side-right')).toBe(true);
    expect(panel?.classList.contains('side-left')).toBe(false);
    // Restore default
    useAppStore.getState().setBondedGroupsSide('left');
  });

  it('row click selects cluster', () => {
    useAppStore.getState().setBondedGroups(FIXTURE_GROUPS);
    useAppStore.getState().toggleBondedGroupsExpanded();
    const c = renderPanel();

    // Click first cluster row
    const rows = c.querySelectorAll('.bonded-groups-row:not(.bonded-groups-small-toggle)');
    fireEvent.click(rows[0]);
    expect(useAppStore.getState().selectedBondedGroupId).toBe('a');

    // Click again to deselect
    fireEvent.click(rows[0]);
    expect(useAppStore.getState().selectedBondedGroupId).toBeNull();
  });

  it('selected row has selected class', () => {
    useAppStore.getState().setBondedGroups(FIXTURE_GROUPS);
    useAppStore.getState().toggleBondedGroupsExpanded();
    useAppStore.getState().setSelectedBondedGroup('a');
    const c = renderPanel();

    const selected = c.querySelector('.bonded-groups-selected');
    expect(selected).toBeTruthy();
    expect(selected!.textContent).toContain('Cluster 1');
  });

  it('hover adds hovered class when no selection', () => {
    useAppStore.getState().setBondedGroups(FIXTURE_GROUPS);
    useAppStore.getState().toggleBondedGroupsExpanded();
    const c = renderPanel();

    const rows = c.querySelectorAll('.bonded-groups-row:not(.bonded-groups-small-toggle)');
    fireEvent.mouseEnter(rows[0]);
    expect(useAppStore.getState().hoveredBondedGroupId).toBe('a');
    // Re-render picks up hovered state
    const hovered = c.querySelector('.bonded-groups-hovered');
    expect(hovered).toBeTruthy();

    // Hover clears when leaving the list container (not per-row)
    const list = c.querySelector('.bonded-groups-list');
    fireEvent.mouseLeave(list!);
    expect(useAppStore.getState().hoveredBondedGroupId).toBeNull();
  });

  it('hover does not set state when selection exists', () => {
    useAppStore.getState().setBondedGroups(FIXTURE_GROUPS);
    useAppStore.getState().toggleBondedGroupsExpanded();
    useAppStore.getState().setSelectedBondedGroup('a');
    const c = renderPanel();

    const rows = c.querySelectorAll('.bonded-groups-row:not(.bonded-groups-small-toggle)');
    fireEvent.mouseEnter(rows[1]);
    // Hover should be blocked by the callback guard
    expect(useAppStore.getState().hoveredBondedGroupId).toBeNull();
  });

  it('Clear Highlight button visible only during selection', () => {
    useAppStore.getState().setBondedGroups(FIXTURE_GROUPS);
    useAppStore.getState().toggleBondedGroupsExpanded();
    const c = renderPanel();

    // No selection — no clear button
    expect(c.querySelector('.bonded-groups-clear')).toBeNull();

    // Select a group
    const rows = c.querySelectorAll('.bonded-groups-row:not(.bonded-groups-small-toggle)');
    fireEvent.click(rows[0]);
    expect(useAppStore.getState().selectedBondedGroupId).toBe('a');
    const clearBtn = c.querySelector('.bonded-groups-clear');
    expect(clearBtn).toBeTruthy();

    // Click clear
    fireEvent.click(clearBtn!);
    expect(useAppStore.getState().selectedBondedGroupId).toBeNull();
    expect(useAppStore.getState().hoveredBondedGroupId).toBeNull();
  });
});
