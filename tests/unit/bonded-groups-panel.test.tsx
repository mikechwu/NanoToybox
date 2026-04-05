/**
 * @vitest-environment jsdom
 */
/**
 * Component-level tests for BondedGroupsPanel.
 *
 * Verifies the two-level UI contract:
 * - Panel starts expanded by default (disclosure pattern)
 * - Header click collapses/expands main list with Collapse/Expand hint
 * - Small-clusters button expands only the small-group bucket
 * - Large clusters remain visible while small clusters stay collapsed
 * - Panel hidden when no groups
 */
import { describe, it, expect, beforeEach } from 'vitest';
import React from 'react';
import { render, fireEvent } from '@testing-library/react';
import { BondedGroupsPanel, buildGroupColorLayout, computeHexGeometry, SWATCH_DIAMETER, ACTIVE_SCALE, RING_GAP } from '../../page/js/components/BondedGroupsPanel';
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
    // Ensure expanded state is reset (resetTransientState preserves user preference)
    useAppStore.setState({ bondedGroupsExpanded: true });
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

  it('panel is expanded by default with large clusters visible', () => {
    useAppStore.getState().setBondedGroups(FIXTURE_GROUPS);
    const c = renderPanel();
    const header = c.querySelector('.bonded-groups-header');
    expect(header).toBeTruthy();
    expect(header!.textContent).toContain('Bonded Clusters');
    expect(header!.textContent).toContain('5');
    expect(header!.getAttribute('aria-expanded')).toBe('true');

    // Large clusters visible by default (expanded)
    const rows = c.querySelectorAll('.bonded-groups-row:not(.bonded-groups-small-toggle):not(.bonded-groups-small-row)');
    expect(rows.length).toBe(2);
    expect(rows[0].textContent).toContain('#1');
    expect(rows[1].textContent).toContain('#2');
  });

  it('header shows Collapse when expanded, Expand when collapsed', () => {
    useAppStore.getState().setBondedGroups(FIXTURE_GROUPS);
    const c = renderPanel();
    const header = c.querySelector('.bonded-groups-header')!;

    // Expanded by default → Collapse hint
    expect(header.textContent).toContain('Collapse');
    expect(header.getAttribute('aria-expanded')).toBe('true');

    // Click to collapse
    fireEvent.click(header);
    expect(header.textContent).toContain('Expand');
    expect(header.getAttribute('aria-expanded')).toBe('false');
    expect(c.querySelector('.bonded-groups-list')).toBeNull();

    // Click to expand again
    fireEvent.click(header);
    expect(header.textContent).toContain('Collapse');
    expect(header.getAttribute('aria-expanded')).toBe('true');
    expect(c.querySelector('.bonded-groups-list')).toBeTruthy();
  });

  it('small-clusters button expands only small groups', () => {
    useAppStore.getState().setBondedGroups(FIXTURE_GROUPS);
    const c = renderPanel();

    // Click small-clusters toggle
    fireEvent.click(c.querySelector('.bonded-groups-small-toggle')!);

    // Small cluster rows now visible
    const smallRows = c.querySelectorAll('.bonded-groups-small-row');
    expect(smallRows.length).toBe(3);
    expect(smallRows[0].textContent).toContain('#3');

    // Large clusters still visible
    const largeRows = c.querySelectorAll('.bonded-groups-row:not(.bonded-groups-small-toggle):not(.bonded-groups-small-row)');
    expect(largeRows.length).toBe(2);
  });

  it('header click collapses everything', () => {
    useAppStore.getState().setBondedGroups(FIXTURE_GROUPS);
    const c = renderPanel();

    // Large clusters visible (expanded by default)
    expect(c.querySelectorAll('.bonded-groups-row').length).toBeGreaterThan(0);

    // Click header to collapse
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
    const c = renderPanel();

    const rows = c.querySelectorAll('.bonded-groups-row:not(.bonded-groups-small-toggle)');
    fireEvent.click(rows[0]);
    // Selection should NOT be set — feature gated off
    expect(useAppStore.getState().selectedBondedGroupId).toBeNull();
  });

  it('row does not have button role or tabIndex when tracked highlight is disabled', () => {
    useAppStore.getState().setBondedGroups(FIXTURE_GROUPS);
    const c = renderPanel();

    const rows = c.querySelectorAll('.bonded-groups-row:not(.bonded-groups-small-toggle)');
    const row = rows[0] as HTMLElement;
    expect(row.getAttribute('role')).toBeNull();
    expect(row.getAttribute('tabindex')).toBeNull();
  });

  it('selected-row class not applied when tracked highlight is disabled', () => {
    useAppStore.getState().setBondedGroups(FIXTURE_GROUPS);

    // Seed legacy state — should not render as selected
    useAppStore.getState().setSelectedBondedGroup('a');
    const c = renderPanel();

    expect(c.querySelector('.bonded-groups-selected')).toBeNull();
  });

  it('hover preview still works when tracked highlight is disabled', () => {
    useAppStore.getState().setBondedGroups(FIXTURE_GROUPS);
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

    // Seed legacy tracked state
    useAppStore.setState({ hasTrackedBondedHighlight: true });
    const c = renderPanel();

    // Clear Highlight should NOT render — capability is off
    expect(c.querySelector('.bonded-groups-clear')).toBeNull();
  });

  it('color chip still works when tracked highlight is disabled', () => {
    useAppStore.getState().setBondedGroups(FIXTURE_GROUPS);
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
    const c = renderPanel();
    const chips = c.querySelectorAll('.bonded-groups-color-chip');
    // 2 large clusters visible
    expect(chips.length).toBe(2);
    // No selection needed — chips present before any click
    expect(useAppStore.getState().selectedBondedGroupId).toBeNull();
  });

  it('color chip defaults to base atom color (no inline style) when no override', () => {
    useAppStore.getState().setBondedGroups(FIXTURE_GROUPS);
    const c = renderPanel();
    const chip = c.querySelector('.bonded-groups-color-chip') as HTMLElement;
    expect(chip).toBeTruthy();
    // No authored color → no inline background style (CSS fallback applies)
    expect(chip.style.background).toBe('');
  });

  it('clicking chip opens portalled popover, not a grid-row child', () => {
    useAppStore.getState().setBondedGroups(FIXTURE_GROUPS);
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
    const c = renderPanel();
    const chip = c.querySelector('.bonded-groups-color-chip')!;

    fireEvent.click(chip);
    // Selection should remain null — chip click is independent
    expect(useAppStore.getState().selectedBondedGroupId).toBeNull();
  });

  it('choosing a swatch calls onApplyGroupColor and updates chip', () => {
    useAppStore.getState().setBondedGroups(FIXTURE_GROUPS);

    // Set an override so chip reflects it
    useAppStore.getState().setBondedGroupColorOverrides({ 0: { hex: '#ff5555' } });
    const c = renderPanel();

    const chip = c.querySelector('.bonded-groups-color-chip') as HTMLElement;
    fireEvent.click(chip); // open popover

    // Center (1 default) + ring (6 presets) = 7 swatches total
    const popover = document.querySelector('.bonded-groups-color-popover')!;
    const presetSwatches = popover.querySelectorAll('.bonded-groups-swatch:not(.bonded-groups-swatch-original)');
    expect(presetSwatches.length).toBe(6);

    // Click the blue swatch (#55aaff is index 3 in presets)
    fireEvent.click(presetSwatches[3]);
    expect(appliedColors['a']).toBe('#55aaff');

    // Chip has inline background from the override
    expect(chip.style.background).not.toBe('');
  });

  it('second chip click closes the popover', () => {
    useAppStore.getState().setBondedGroups(FIXTURE_GROUPS);
    const c = renderPanel();
    const chip = c.querySelector('.bonded-groups-color-chip')!;

    fireEvent.click(chip);
    expect(document.querySelector('.bonded-groups-color-popover')).toBeTruthy();

    fireEvent.click(chip);
    expect(document.querySelector('.bonded-groups-color-popover')).toBeNull();
  });

  it('clicking backdrop closes the popover', () => {
    useAppStore.getState().setBondedGroups(FIXTURE_GROUPS);
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
    const c = renderPanel();
    const chip = c.querySelector('.bonded-groups-color-chip')!;

    fireEvent.click(chip);
    const row = chip.closest('.bonded-groups-row');
    expect(row?.classList.contains('bonded-groups-color-open')).toBe(true);
  });

  // ── Hover clearing regressions ──

  it('hover clears when cursor leaves row', () => {
    useAppStore.getState().setBondedGroups(FIXTURE_GROUPS);
    const c = renderPanel();
    const rows = c.querySelectorAll('.bonded-groups-row:not(.bonded-groups-small-toggle)');

    fireEvent.mouseEnter(rows[0]);
    expect(useAppStore.getState().hoveredBondedGroupId).toBe('a');

    fireEvent.mouseLeave(rows[0]);
    expect(useAppStore.getState().hoveredBondedGroupId).toBeNull();
  });

  it('moving across rows switches preview correctly', () => {
    useAppStore.getState().setBondedGroups(FIXTURE_GROUPS);
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

    // No overrides — default state
    const c = renderPanel();
    const chip = c.querySelector('.bonded-groups-color-chip')!;
    fireEvent.click(chip);

    const original = document.querySelector('.bonded-groups-swatch-original');
    expect(original!.classList.contains('active')).toBe(true);
  });

  it('multi-color group chip shows conic gradient', () => {
    useAppStore.getState().setBondedGroups(FIXTURE_GROUPS);

    useAppStore.getState().setBondedGroupColorOverrides({
      0: { hex: '#ff5555' }, 1: { hex: '#ff5555' },
      2: { hex: '#33dd66' }, 3: { hex: '#33dd66' },
    });
    const c = renderPanel();

    const chip = c.querySelector('.bonded-groups-color-chip') as HTMLElement;
    expect(chip.style.background).toContain('conic-gradient');
  });

  it('colored + default atoms shows conic gradient with default segment', () => {
    useAppStore.getState().setBondedGroups(FIXTURE_GROUPS);

    useAppStore.getState().setBondedGroupColorOverrides({
      0: { hex: '#ff5555' }, 1: { hex: '#ff5555' },
    });
    const c = renderPanel();

    const chip = c.querySelector('.bonded-groups-color-chip') as HTMLElement;
    expect(chip.style.background).toContain('conic-gradient');
    expect(chip.style.background).toContain('var(--atom-base-color');
  });

  it('single-color chip shows solid background, not conic gradient', () => {
    useAppStore.getState().setBondedGroups(FIXTURE_GROUPS);

    useAppStore.getState().setBondedGroupColorOverrides({
      0: { hex: '#ff5555' }, 1: { hex: '#ff5555' }, 2: { hex: '#ff5555' },
      3: { hex: '#ff5555' }, 4: { hex: '#ff5555' },
    });
    const c = renderPanel();

    const chip = c.querySelector('.bonded-groups-color-chip') as HTMLElement;
    expect(chip.style.background).not.toContain('conic-gradient');
    // jsdom normalizes hex to rgb
    expect(chip.style.background).toContain('rgb(255, 85, 85)');
  });

  it('portalled popover does not keep hoveredBondedGroupId alive', () => {
    useAppStore.getState().setBondedGroups(FIXTURE_GROUPS);
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

  // ── Honeycomb popover structure ──

  it('popover has honeycomb layout: center default + ring presets', () => {
    useAppStore.getState().setBondedGroups(FIXTURE_GROUPS);
    const c = renderPanel();
    fireEvent.click(c.querySelector('.bonded-groups-color-chip')!);

    const popover = document.querySelector('.bonded-groups-color-popover')!;
    const hex = popover.querySelector('.bonded-groups-color-hex')!;
    expect(hex).toBeTruthy();
    // 7 slots: 1 center + 6 ring
    expect(hex.querySelectorAll('.bonded-groups-hex-slot').length).toBe(7);
    expect(hex.querySelector('.bonded-groups-swatch-original')).toBeTruthy();
    expect(hex.querySelectorAll('.bonded-groups-swatch:not(.bonded-groups-swatch-original)').length).toBe(6);
  });

  it('default swatch in hex center clears color', () => {
    useAppStore.getState().setBondedGroups(FIXTURE_GROUPS);
    useAppStore.getState().setBondedGroupColorOverrides({ 0: { hex: '#ff5555' } });
    const c = renderPanel();
    fireEvent.click(c.querySelector('.bonded-groups-color-chip')!);
    const original = document.querySelector('.bonded-groups-swatch-original')!;
    fireEvent.click(original);
    expect(clearedGroups).toContain('a');
  });

  it('preset swatch in hex ring applies color', () => {
    useAppStore.getState().setBondedGroups(FIXTURE_GROUPS);
    const c = renderPanel();
    fireEvent.click(c.querySelector('.bonded-groups-color-chip')!);
    const presets = document.querySelectorAll('.bonded-groups-swatch:not(.bonded-groups-swatch-original)');
    fireEvent.click(presets[0]); // first preset in ring
    expect(appliedColors['a']).toBe('#ff5555');
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
      const hex = '#' + t.atom.toString(16).padStart(6, '0');
      expect(hex).toMatch(/^#[0-9a-f]{6}$/);
    }
  });
});

describe('buildGroupColorLayout', () => {
  it('places default option in primary slot', () => {
    const layout = buildGroupColorLayout([
      { kind: 'default' },
      { kind: 'preset', hex: '#ff5555' },
      { kind: 'preset', hex: '#33dd66' },
    ]);
    expect(layout.primary).toEqual({ kind: 'default' });
  });

  it('secondary preserves original preset order', () => {
    const layout = buildGroupColorLayout([
      { kind: 'default' },
      { kind: 'preset', hex: '#ff5555' },
      { kind: 'preset', hex: '#33dd66' },
    ]);
    expect(layout.secondary).toEqual([
      { kind: 'preset', hex: '#ff5555' },
      { kind: 'preset', hex: '#33dd66' },
    ]);
  });

  it('primary is null when no default option exists', () => {
    const layout = buildGroupColorLayout([
      { kind: 'preset', hex: '#ff5555' },
    ]);
    expect(layout.primary).toBeNull();
    expect(layout.secondary.length).toBe(1);
  });

  it('works with varying palette sizes', () => {
    const layout = buildGroupColorLayout([
      { kind: 'default' },
      { kind: 'preset', hex: '#aaa' },
      { kind: 'preset', hex: '#bbb' },
      { kind: 'preset', hex: '#ccc' },
      { kind: 'preset', hex: '#ddd' },
    ]);
    expect(layout.secondary.length).toBe(4);
  });
});

describe('computeHexGeometry', () => {
  // Use the actual production constants — tests catch drift if CSS/JS values diverge
  const SWATCH = SWATCH_DIAMETER;
  const SCALE = ACTIVE_SCALE;
  const GAP = RING_GAP;

  it('derives radius so adjacent swatches do not overlap at active scale', () => {
    for (const n of [3, 4, 5, 6, 8, 10]) {
      const { radius } = computeHexGeometry(n, SWATCH, SCALE, GAP);
      // Chord between adjacent items = 2R sin(π/n)
      const chord = 2 * radius * Math.sin(Math.PI / n);
      const minSpacing = SWATCH * SCALE + GAP;
      expect(chord).toBeGreaterThanOrEqual(minSpacing - 0.01);
    }
  });

  it('container fits all swatches including scaled edges', () => {
    for (const n of [3, 6, 8]) {
      const { radius, containerSize } = computeHexGeometry(n, SWATCH, SCALE, GAP);
      // Outermost scaled edge: radius + half scaled swatch
      const outerEdge = radius + (SWATCH * SCALE) / 2;
      // Container must fit from center to edge in both directions + gap
      expect(containerSize).toBeGreaterThanOrEqual(2 * outerEdge);
    }
  });

  it('handles n=1 without division by zero', () => {
    const { radius, containerSize } = computeHexGeometry(1, SWATCH, SCALE, GAP);
    expect(radius).toBe(0);
    expect(containerSize).toBeGreaterThan(0);
  });

  it('ring slot positions do not overlap for 6 presets', () => {
    const n = 6;
    const { radius, containerSize } = computeHexGeometry(n, SWATCH, SCALE, GAP);
    const positions: { x: number; y: number }[] = [];
    for (let i = 0; i < n; i++) {
      const angle = (i * 2 * Math.PI) / n;
      const rPct = (radius / containerSize) * 100;
      positions.push({
        x: 50 + rPct * Math.sin(angle),
        y: 50 - rPct * Math.cos(angle),
      });
    }
    // Check all pairs: distance in % must exceed swatch diameter as % of container
    const swatchPct = (SWATCH * SCALE / containerSize) * 100;
    for (let a = 0; a < n; a++) {
      for (let b = a + 1; b < n; b++) {
        const dx = positions[a].x - positions[b].x;
        const dy = positions[a].y - positions[b].y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        expect(dist).toBeGreaterThan(swatchPct);
      }
    }
  });
});

