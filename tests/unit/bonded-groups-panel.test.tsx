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
import { BondedGroupsPanel } from '../../page/js/components/BondedGroupsPanel';
import { useAppStore, type BondedGroupSummary } from '../../page/js/store/app-store';
import { createBondedGroupHighlightRuntime } from '../../page/js/runtime/bonded-group-highlight-runtime';
import { CONFIG } from '../../page/js/config';
import { THEMES } from '../../page/js/themes';
import type { BondedGroupRuntime } from '../../page/js/runtime/bonded-group-runtime';

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
  // Atom map for the fixture groups
  const atomMap: Record<string, number[]> = {
    a: [0, 1, 2, 3, 4], b: [5, 6, 7, 8, 9],
    c: [10, 11, 12], d: [13, 14], e: [15],
  };
  const mockBgr: BondedGroupRuntime = {
    projectNow: () => {},
    reset: () => {},
    getAtomIndicesForGroup: (id: string) => atomMap[id] ?? null,
    getDisplaySourceKind: () => 'live' as const,
  };

  /** Track callbacks fired via panel interactions. */
  let appliedColors: Record<string, string>;
  let clearedGroups: string[];
  let centeredGroups: string[];
  let followedGroups: string[];

  beforeEach(() => {
    appliedColors = {};
    clearedGroups = [];
    centeredGroups = [];
    followedGroups = [];
    useAppStore.getState().resetTransientState();
    // Wire real highlight runtime via store-registered callbacks (same as main.ts)
    const hl = createBondedGroupHighlightRuntime({
      getBondedGroupRuntime: () => mockBgr,
      getRenderer: () => ({ setHighlightedAtoms: () => {} }),
      getPhysics: () => ({ n: 20 }),
    });
    useAppStore.getState().setBondedGroupCallbacks({
      onToggleSelect: (id) => hl.toggleSelectedGroup(id),
      onHover: (id) => hl.setHoveredGroup(id),
      onClearHighlight: () => hl.clearHighlight(),
      onCenterGroup: (id) => { centeredGroups.push(id); },
      onFollowGroup: (id) => { followedGroups.push(id); },
      onApplyGroupColor: (id, hex) => { appliedColors[id] = hex; },
      onClearGroupColor: (id) => { clearedGroups.push(id); },
      getGroupAtoms: (id) => atomMap[id] ?? null,
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
    expect(rows[0].textContent).toContain('42');
    expect(rows[1].textContent).toContain('Cluster 2');
    expect(rows[1].textContent).toContain('10');

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
    expect(smallRows[0].textContent).toContain('3');

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
    expect(panel?.classList.contains('side-right')).toBe(true);
    expect(panel?.classList.contains('side-left')).toBe(false);
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

  // ── Tracked highlight hidden (canTrackBondedGroupHighlight: false) ──

  it('row click does not toggle persistent selection when tracked highlight is disabled', () => {
    useAppStore.getState().setBondedGroups(FIXTURE_GROUPS);
    useAppStore.getState().toggleBondedGroupsExpanded();
    const c = renderPanel();

    const rows = c.querySelectorAll('.bonded-groups-row:not(.bonded-groups-small-toggle)');
    fireEvent.click(rows[0]);
    // Selection should NOT be set — feature gated off
    expect(useAppStore.getState().selectedBondedGroupId).toBeNull();
  });

  it('row does not have button role or tabIndex when tracked highlight is disabled', () => {
    useAppStore.getState().setBondedGroups(FIXTURE_GROUPS);
    useAppStore.getState().toggleBondedGroupsExpanded();
    const c = renderPanel();

    const rows = c.querySelectorAll('.bonded-groups-row:not(.bonded-groups-small-toggle)');
    const row = rows[0] as HTMLElement;
    expect(row.getAttribute('role')).toBeNull();
    expect(row.getAttribute('tabindex')).toBeNull();
  });

  it('selected-row class not applied when tracked highlight is disabled', () => {
    useAppStore.getState().setBondedGroups(FIXTURE_GROUPS);
    useAppStore.getState().toggleBondedGroupsExpanded();
    // Seed legacy state — should not render as selected
    useAppStore.getState().setSelectedBondedGroup('a');
    const c = renderPanel();

    expect(c.querySelector('.bonded-groups-selected')).toBeNull();
  });

  it('hover preview still works when tracked highlight is disabled', () => {
    useAppStore.getState().setBondedGroups(FIXTURE_GROUPS);
    useAppStore.getState().toggleBondedGroupsExpanded();
    const c = renderPanel();

    const rows = c.querySelectorAll('.bonded-groups-row:not(.bonded-groups-small-toggle)');
    fireEvent.mouseEnter(rows[0]);
    expect(useAppStore.getState().hoveredBondedGroupId).toBe('a');
    const hovered = c.querySelector('.bonded-groups-hovered');
    expect(hovered).toBeTruthy();

    fireEvent.mouseLeave(rows[0]);
    expect(useAppStore.getState().hoveredBondedGroupId).toBeNull();
  });

  it('Clear Highlight button hidden when tracked highlight capability is false', () => {
    useAppStore.getState().setBondedGroups(FIXTURE_GROUPS);
    useAppStore.getState().toggleBondedGroupsExpanded();
    // Seed legacy tracked state
    useAppStore.setState({ hasTrackedBondedHighlight: true });
    const c = renderPanel();

    // Clear Highlight should NOT render — capability is off
    expect(c.querySelector('.bonded-groups-clear')).toBeNull();
  });

  it('color chip still works when tracked highlight is disabled', () => {
    useAppStore.getState().setBondedGroups(FIXTURE_GROUPS);
    useAppStore.getState().toggleBondedGroupsExpanded();
    const c = renderPanel();
    const chip = c.querySelector('.bonded-groups-color-chip')!;

    fireEvent.click(chip);
    // Popover opens
    expect(document.querySelector('.bonded-groups-color-popover')).toBeTruthy();
    // Selection NOT toggled
    expect(useAppStore.getState().selectedBondedGroupId).toBeNull();
  });

  it('Center and Follow still work when tracked highlight is disabled', () => {
    useAppStore.getState().setBondedGroups(FIXTURE_GROUPS);
    useAppStore.getState().toggleBondedGroupsExpanded();
    const c = renderPanel();

    const actionBtns = c.querySelectorAll('.bonded-groups-action-btn');
    expect(actionBtns.length).toBeGreaterThanOrEqual(2);

    // Click Center (first action button)
    fireEvent.click(actionBtns[0]);
    expect(centeredGroups).toContain('a');

    // Click Follow (second action button)
    fireEvent.click(actionBtns[1]);
    expect(followedGroups).toContain('a');

    // Selection remains null — row inertness did not break nested controls
    expect(useAppStore.getState().selectedBondedGroupId).toBeNull();
  });

  it('panel visible in review when historical groups exist', () => {
    // Review topology now feeds bonded-group projection via getReviewBondedGroupComponents.
    // When groups are projected from review data, the panel is visible.
    useAppStore.getState().setBondedGroups(FIXTURE_GROUPS);
    useAppStore.getState().setTimelineMode('review');
    const c = renderPanel();
    expect(c.innerHTML).not.toBe('');
  });

  it('panel hidden in review when no groups projected', () => {
    useAppStore.getState().setBondedGroups([]);
    useAppStore.getState().setTimelineMode('review');
    const c = renderPanel();
    expect(c.innerHTML).toBe('');
  });

  it('bonded-group select gated off in review (canTrackBondedGroupHighlight: false)', () => {
    useAppStore.getState().setBondedGroups(FIXTURE_GROUPS);
    useAppStore.getState().toggleBondedGroupsExpanded();
    useAppStore.getState().setTimelineMode('review');
    const hl = createBondedGroupHighlightRuntime({
      getBondedGroupRuntime: () => mockBgr,
      getRenderer: () => ({ setHighlightedAtoms: () => {} }),
      getPhysics: () => ({ n: 20 }),
    });
    // toggleSelectedGroup is gated off — no-op
    hl.toggleSelectedGroup('a');
    expect(useAppStore.getState().selectedBondedGroupId).toBeNull();
  });

  it('bonded-group hover works in review (canInspectBondedGroups: true)', () => {
    useAppStore.getState().setBondedGroups(FIXTURE_GROUPS);
    useAppStore.getState().setTimelineMode('review');
    const hl = createBondedGroupHighlightRuntime({
      getBondedGroupRuntime: () => mockBgr,
      getRenderer: () => ({ setHighlightedAtoms: () => {} }),
      getPhysics: () => ({ n: 20 }),
    });
    hl.setHoveredGroup('a');
    expect(useAppStore.getState().hoveredBondedGroupId).toBe('a');
  });

  it('keyboard Enter/Space does not toggle selection when tracked highlight is disabled', () => {
    useAppStore.getState().setBondedGroups(FIXTURE_GROUPS);
    useAppStore.getState().toggleBondedGroupsExpanded();
    const c = renderPanel();
    const rows = c.querySelectorAll('.bonded-groups-row:not(.bonded-groups-small-toggle)');
    const row = rows[0] as HTMLElement;
    // No button role or tabindex when tracked highlight is hidden
    expect(row.getAttribute('role')).toBeNull();
    expect(row.getAttribute('tabindex')).toBeNull();
    // Enter/Space should not toggle selection
    fireEvent.keyDown(row, { key: 'Enter' });
    expect(useAppStore.getState().selectedBondedGroupId).toBeNull();
    fireEvent.keyDown(row, { key: ' ' });
    expect(useAppStore.getState().selectedBondedGroupId).toBeNull();
  });

  // ── Inline color chip + anchored popover tests ──

  it('color chip is visible in every row without requiring selection', () => {
    useAppStore.getState().setBondedGroups(FIXTURE_GROUPS);
    useAppStore.getState().toggleBondedGroupsExpanded();
    const c = renderPanel();
    const chips = c.querySelectorAll('.bonded-groups-color-chip');
    // 2 large clusters visible
    expect(chips.length).toBe(2);
    // No selection needed — chips present before any click
    expect(useAppStore.getState().selectedBondedGroupId).toBeNull();
  });

  it('color chip defaults to base atom color (no has-color class) when no override', () => {
    useAppStore.getState().setBondedGroups(FIXTURE_GROUPS);
    useAppStore.getState().toggleBondedGroupsExpanded();
    const c = renderPanel();
    const chip = c.querySelector('.bonded-groups-color-chip') as HTMLElement;
    expect(chip).toBeTruthy();
    // No authored color → no inline background style, no has-color class
    expect(chip.classList.contains('has-color')).toBe(false);
    expect(chip.style.background).toBe('');
  });

  it('clicking chip opens portalled popover, not a grid-row child', () => {
    useAppStore.getState().setBondedGroups(FIXTURE_GROUPS);
    useAppStore.getState().toggleBondedGroupsExpanded();
    const c = renderPanel();
    const chip = c.querySelector('.bonded-groups-color-chip')!;

    fireEvent.click(chip);

    // Popover is portalled to document.body (escapes panel overflow)
    const popover = document.querySelector('.bonded-groups-color-popover');
    expect(popover).toBeTruthy();
    // It is NOT inside the panel (portalled out)
    expect(popover!.closest('.bonded-groups-panel')).toBeNull();
    // Backdrop exists for click-outside-to-close
    expect(document.querySelector('.bonded-groups-color-backdrop')).toBeTruthy();
  });

  it('clicking chip does not toggle row selection', () => {
    useAppStore.getState().setBondedGroups(FIXTURE_GROUPS);
    useAppStore.getState().toggleBondedGroupsExpanded();
    const c = renderPanel();
    const chip = c.querySelector('.bonded-groups-color-chip')!;

    fireEvent.click(chip);
    // Selection should remain null — chip click is independent
    expect(useAppStore.getState().selectedBondedGroupId).toBeNull();
  });

  it('choosing a swatch calls onApplyGroupColor and updates chip', () => {
    useAppStore.getState().setBondedGroups(FIXTURE_GROUPS);
    useAppStore.getState().toggleBondedGroupsExpanded();
    // Set an override so chip reflects it
    useAppStore.getState().setBondedGroupColorOverrides({ 0: { hex: '#ff5555' } });
    const c = renderPanel();

    const chip = c.querySelector('.bonded-groups-color-chip') as HTMLElement;
    fireEvent.click(chip); // open popover

    // Swatches inside the active popover (6 presets + 1 original = 7)
    const popover = document.querySelector('.bonded-groups-color-popover')!;
    const swatches = popover.querySelectorAll('.bonded-groups-swatch');
    expect(swatches.length).toBe(7);

    // Click the blue swatch (#55aaff is index 3 in PRESET_COLORS)
    fireEvent.click(swatches[3]);
    expect(appliedColors['a']).toBe('#55aaff');

    // Chip now shows has-color class (already had override, so it was present)
    expect(chip.classList.contains('has-color')).toBe(true);
  });

  it('second chip click closes the popover', () => {
    useAppStore.getState().setBondedGroups(FIXTURE_GROUPS);
    useAppStore.getState().toggleBondedGroupsExpanded();
    const c = renderPanel();
    const chip = c.querySelector('.bonded-groups-color-chip')!;

    fireEvent.click(chip);
    expect(document.querySelector('.bonded-groups-color-popover')).toBeTruthy();

    fireEvent.click(chip);
    expect(document.querySelector('.bonded-groups-color-popover')).toBeNull();
  });

  it('clicking backdrop closes the popover', () => {
    useAppStore.getState().setBondedGroups(FIXTURE_GROUPS);
    useAppStore.getState().toggleBondedGroupsExpanded();
    const c = renderPanel();
    const chip = c.querySelector('.bonded-groups-color-chip')!;

    fireEvent.click(chip);
    expect(document.querySelector('.bonded-groups-color-popover')).toBeTruthy();

    const backdrop = document.querySelector('.bonded-groups-color-backdrop')!;
    fireEvent.click(backdrop);
    expect(document.querySelector('.bonded-groups-color-popover')).toBeNull();
  });

  it('row gets bonded-groups-color-open class when popover is active', () => {
    useAppStore.getState().setBondedGroups(FIXTURE_GROUPS);
    useAppStore.getState().toggleBondedGroupsExpanded();
    const c = renderPanel();
    const chip = c.querySelector('.bonded-groups-color-chip')!;

    fireEvent.click(chip);
    const row = chip.closest('.bonded-groups-row');
    expect(row?.classList.contains('bonded-groups-color-open')).toBe(true);
  });

  // ── Hover clearing regressions ──

  it('hover clears when cursor leaves row', () => {
    useAppStore.getState().setBondedGroups(FIXTURE_GROUPS);
    useAppStore.getState().toggleBondedGroupsExpanded();
    const c = renderPanel();
    const rows = c.querySelectorAll('.bonded-groups-row:not(.bonded-groups-small-toggle)');

    fireEvent.mouseEnter(rows[0]);
    expect(useAppStore.getState().hoveredBondedGroupId).toBe('a');

    fireEvent.mouseLeave(rows[0]);
    expect(useAppStore.getState().hoveredBondedGroupId).toBeNull();
  });

  it('moving across rows switches preview correctly', () => {
    useAppStore.getState().setBondedGroups(FIXTURE_GROUPS);
    useAppStore.getState().toggleBondedGroupsExpanded();
    const c = renderPanel();
    const rows = c.querySelectorAll('.bonded-groups-row:not(.bonded-groups-small-toggle)');

    fireEvent.mouseEnter(rows[0]);
    expect(useAppStore.getState().hoveredBondedGroupId).toBe('a');

    // Move to second row — leave first, enter second
    fireEvent.mouseLeave(rows[0]);
    fireEvent.mouseEnter(rows[1]);
    expect(useAppStore.getState().hoveredBondedGroupId).toBe('b');

    fireEvent.mouseLeave(rows[1]);
    expect(useAppStore.getState().hoveredBondedGroupId).toBeNull();
  });

  it('opening color popover clears hover preview', () => {
    useAppStore.getState().setBondedGroups(FIXTURE_GROUPS);
    useAppStore.getState().toggleBondedGroupsExpanded();
    const c = renderPanel();
    const rows = c.querySelectorAll('.bonded-groups-row:not(.bonded-groups-small-toggle)');

    // Hover row, then open its color popover
    fireEvent.mouseEnter(rows[0]);
    expect(useAppStore.getState().hoveredBondedGroupId).toBe('a');

    const chip = c.querySelector('.bonded-groups-color-chip')!;
    fireEvent.click(chip);

    // Hover should be cleared — user is now in color-edit mode
    expect(useAppStore.getState().hoveredBondedGroupId).toBeNull();
    // Popover is open
    expect(document.querySelector('.bonded-groups-color-popover')).toBeTruthy();
  });

  // ── Original-color swatch + multi-color chip regressions ──

  it('popover has original-color swatch instead of ✕ clear button', () => {
    useAppStore.getState().setBondedGroups(FIXTURE_GROUPS);
    useAppStore.getState().toggleBondedGroupsExpanded();
    useAppStore.getState().setBondedGroupColorOverrides({ 0: { hex: '#ff5555' } });
    const c = renderPanel();
    const chip = c.querySelector('.bonded-groups-color-chip')!;

    fireEvent.click(chip);

    // No ✕ clear button
    expect(document.querySelector('.bonded-groups-swatch-clear')).toBeNull();
    // Original-color swatch exists
    const original = document.querySelector('.bonded-groups-swatch-original');
    expect(original).toBeTruthy();
    expect(original!.getAttribute('aria-label')).toBe('Restore original color');
  });

  it('clicking original-color swatch calls onClearGroupColor', () => {
    useAppStore.getState().setBondedGroups(FIXTURE_GROUPS);
    useAppStore.getState().toggleBondedGroupsExpanded();
    useAppStore.getState().setBondedGroupColorOverrides({ 0: { hex: '#ff5555' } });
    const c = renderPanel();
    const chip = c.querySelector('.bonded-groups-color-chip')!;
    fireEvent.click(chip);

    const original = document.querySelector('.bonded-groups-swatch-original')!;
    fireEvent.click(original);
    expect(clearedGroups).toContain('a');
  });

  it('original-color swatch gets active class when no override exists', () => {
    useAppStore.getState().setBondedGroups(FIXTURE_GROUPS);
    useAppStore.getState().toggleBondedGroupsExpanded();
    // No overrides — default state
    const c = renderPanel();
    const chip = c.querySelector('.bonded-groups-color-chip')!;
    fireEvent.click(chip);

    const original = document.querySelector('.bonded-groups-swatch-original');
    expect(original!.classList.contains('active')).toBe(true);
  });

  it('multi-color group chip gets multi-color class and conic gradient', () => {
    useAppStore.getState().setBondedGroups(FIXTURE_GROUPS);
    useAppStore.getState().toggleBondedGroupsExpanded();
    // Two different colors on atoms in group 'a'
    useAppStore.getState().setBondedGroupColorOverrides({
      0: { hex: '#ff5555' }, 1: { hex: '#ff5555' },
      2: { hex: '#33dd66' }, 3: { hex: '#33dd66' },
    });
    const c = renderPanel();

    const chip = c.querySelector('.bonded-groups-color-chip') as HTMLElement;
    expect(chip.classList.contains('multi-color')).toBe(true);
    expect(chip.classList.contains('has-color')).toBe(true);
    // Background should contain conic-gradient
    expect(chip.style.background).toContain('conic-gradient');
  });

  it('colored + default atoms shows multi-color chip with default segment', () => {
    useAppStore.getState().setBondedGroups(FIXTURE_GROUPS);
    useAppStore.getState().toggleBondedGroupsExpanded();
    // Only atoms 0, 1 have overrides — atoms 2, 3, 4 are default
    useAppStore.getState().setBondedGroupColorOverrides({
      0: { hex: '#ff5555' }, 1: { hex: '#ff5555' },
    });
    const c = renderPanel();

    const chip = c.querySelector('.bonded-groups-color-chip') as HTMLElement;
    expect(chip.classList.contains('multi-color')).toBe(true);
    // Conic gradient should include atom-base-color for the default segment
    expect(chip.style.background).toContain('conic-gradient');
    expect(chip.style.background).toContain('var(--atom-base-color');
  });

  it('single-color group chip does not get multi-color class', () => {
    useAppStore.getState().setBondedGroups(FIXTURE_GROUPS);
    useAppStore.getState().toggleBondedGroupsExpanded();
    // ALL atoms in group 'a' have the same color — no default atoms remain
    useAppStore.getState().setBondedGroupColorOverrides({
      0: { hex: '#ff5555' }, 1: { hex: '#ff5555' }, 2: { hex: '#ff5555' },
      3: { hex: '#ff5555' }, 4: { hex: '#ff5555' },
    });
    const c = renderPanel();

    const chip = c.querySelector('.bonded-groups-color-chip') as HTMLElement;
    expect(chip.classList.contains('multi-color')).toBe(false);
    expect(chip.classList.contains('has-color')).toBe(true);
  });

  it('portalled popover does not keep hoveredBondedGroupId alive', () => {
    useAppStore.getState().setBondedGroups(FIXTURE_GROUPS);
    useAppStore.getState().toggleBondedGroupsExpanded();
    const c = renderPanel();
    const rows = c.querySelectorAll('.bonded-groups-row:not(.bonded-groups-small-toggle)');

    // Hover row, open popover (which clears hover)
    fireEvent.mouseEnter(rows[0]);
    const chip = c.querySelector('.bonded-groups-color-chip')!;
    fireEvent.click(chip);
    expect(useAppStore.getState().hoveredBondedGroupId).toBeNull();

    // Closing popover via backdrop still has no hover
    const backdrop = document.querySelector('.bonded-groups-color-backdrop')!;
    fireEvent.click(backdrop);
    expect(useAppStore.getState().hoveredBondedGroupId).toBeNull();
  });
});

// ── Highlight intensity contract ──

describe('panelHighlight config contract', () => {
  it('selected highlight opacity stays below authored-color readability threshold', () => {
    expect(CONFIG.panelHighlight.selected.opacity).toBeLessThanOrEqual(0.4);
    expect(CONFIG.panelHighlight.selected.emissiveIntensity).toBeLessThanOrEqual(0.8);
  });

  it('hover highlight is more subtle than selected', () => {
    expect(CONFIG.panelHighlight.hover.opacity).toBeLessThan(CONFIG.panelHighlight.selected.opacity);
    expect(CONFIG.panelHighlight.hover.emissiveIntensity).toBeLessThan(CONFIG.panelHighlight.selected.emissiveIntensity);
    expect(CONFIG.panelHighlight.hover.scale).toBeLessThan(CONFIG.panelHighlight.selected.scale);
  });
});

describe('theme atom color contract', () => {
  it('every theme defines a numeric atom color for CSS and renderer parity', () => {
    for (const [, t] of Object.entries(THEMES)) {
      expect(typeof t.atom).toBe('number');
      // Must produce a valid 6-char hex for --atom-base-color CSS variable
      const hex = '#' + t.atom.toString(16).padStart(6, '0');
      expect(hex).toMatch(/^#[0-9a-f]{6}$/);
    }
  });
});
