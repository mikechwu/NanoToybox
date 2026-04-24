/**
 * @vitest-environment jsdom
 */
/**
 * Tests for initializeResponsiveUiDefaults — mobile-only initial collapsed
 * default for the bonded-groups panel, with idempotent guard so resize /
 * orientation changes do not overwrite a manual user toggle.
 *
 * Contract:
 *   - desktop  → bondedGroupsExpanded stays at the default (true)
 *   - phone    → bondedGroupsExpanded becomes false
 *   - tablet   → bondedGroupsExpanded becomes false
 *   - first call sets responsiveDefaultsInitialized; subsequent calls no-op
 *   - resetTransientState() preserves the user's manual choice
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { useAppStore } from '../../lab/js/store/app-store';

function freshStore() {
  // Reset only the fields the responsive-defaults action and the panel
  // disclosure interact with — leave everything else alone.
  useAppStore.setState({
    bondedGroupsExpanded: true,
    responsiveDefaultsInitialized: false,
  });
}

describe('initializeResponsiveUiDefaults', () => {
  beforeEach(() => {
    freshStore();
  });

  it('desktop boot leaves bondedGroupsExpanded at default (true)', () => {
    useAppStore.getState().initializeResponsiveUiDefaults('desktop');
    const s = useAppStore.getState();
    expect(s.bondedGroupsExpanded).toBe(true);
    expect(s.responsiveDefaultsInitialized).toBe(true);
  });

  it('phone boot collapses bondedGroupsExpanded to false', () => {
    useAppStore.getState().initializeResponsiveUiDefaults('phone');
    const s = useAppStore.getState();
    expect(s.bondedGroupsExpanded).toBe(false);
    expect(s.responsiveDefaultsInitialized).toBe(true);
  });

  it('tablet boot collapses bondedGroupsExpanded to false', () => {
    useAppStore.getState().initializeResponsiveUiDefaults('tablet');
    const s = useAppStore.getState();
    expect(s.bondedGroupsExpanded).toBe(false);
    expect(s.responsiveDefaultsInitialized).toBe(true);
  });

  it('is idempotent — a second call after the user toggles does not overwrite', () => {
    // Boot on phone → collapsed.
    useAppStore.getState().initializeResponsiveUiDefaults('phone');
    expect(useAppStore.getState().bondedGroupsExpanded).toBe(false);

    // User opens it manually.
    useAppStore.getState().toggleBondedGroupsExpanded();
    expect(useAppStore.getState().bondedGroupsExpanded).toBe(true);

    // Resize / orientation change re-fires the init — user choice must survive.
    useAppStore.getState().initializeResponsiveUiDefaults('phone');
    expect(useAppStore.getState().bondedGroupsExpanded).toBe(true);
  });

  it('idempotent across device-mode flips after first call', () => {
    useAppStore.getState().initializeResponsiveUiDefaults('desktop');
    expect(useAppStore.getState().bondedGroupsExpanded).toBe(true);

    // User collapses the panel on desktop.
    useAppStore.getState().toggleBondedGroupsExpanded();
    expect(useAppStore.getState().bondedGroupsExpanded).toBe(false);

    // Window narrows into tablet range — must NOT overwrite the user's collapse.
    useAppStore.getState().initializeResponsiveUiDefaults('tablet');
    expect(useAppStore.getState().bondedGroupsExpanded).toBe(false);
  });

  it('does not touch bondedSmallGroupsExpanded or bondedGroupsSide', () => {
    useAppStore.setState({ bondedSmallGroupsExpanded: true, bondedGroupsSide: 'left' });
    useAppStore.getState().initializeResponsiveUiDefaults('phone');
    const s = useAppStore.getState();
    expect(s.bondedSmallGroupsExpanded).toBe(true);
    expect(s.bondedGroupsSide).toBe('left');
  });

  it('resetTransientState preserves the user-chosen bondedGroupsExpanded', () => {
    // Phone boot collapses.
    useAppStore.getState().initializeResponsiveUiDefaults('phone');
    expect(useAppStore.getState().bondedGroupsExpanded).toBe(false);

    // User expands.
    useAppStore.getState().toggleBondedGroupsExpanded();
    expect(useAppStore.getState().bondedGroupsExpanded).toBe(true);

    // Transient reset (e.g. switching scenes) — disclosure choice survives.
    useAppStore.getState().resetTransientState();
    expect(useAppStore.getState().bondedGroupsExpanded).toBe(true);
  });
});
