/**
 * @vitest-environment jsdom
 */
/**
 * Bonded group coordinator tests.
 *
 * Verifies the coordinated invariant:
 * - update() always calls projectNow + syncAfterTopologyChange together
 * - teardown() clears highlight → callbacks → runtime in correct order
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createBondedGroupCoordinator } from '../../lab/js/runtime/bonded-group-coordinator';
import { useAppStore } from '../../lab/js/store/app-store';

describe('bonded group coordinator', () => {
  beforeEach(() => {
    useAppStore.getState().resetTransientState();
  });

  it('update() calls projectNow then syncAfterTopologyChange', () => {
    const callOrder: string[] = [];
    const mockBgr = {
      projectNow: vi.fn(() => callOrder.push('projectNow')),
      reset: vi.fn(),
      getAtomIndicesForGroup: vi.fn(() => null),
      getDisplaySourceKind: vi.fn(() => 'live' as const),
    };
    const mockHighlight = {
      toggleSelectedGroup: vi.fn(),
      setHoveredGroup: vi.fn(),
      clearHighlight: vi.fn(),
      syncToRenderer: vi.fn(),
      syncAfterTopologyChange: vi.fn(() => callOrder.push('syncAfterTopologyChange')),
    };

    const coord = createBondedGroupCoordinator({
      getBondedGroupRuntime: () => mockBgr,
      getBondedGroupHighlightRuntime: () => mockHighlight,
    });

    coord.update();

    expect(mockBgr.projectNow).toHaveBeenCalledTimes(1);
    expect(mockHighlight.syncAfterTopologyChange).toHaveBeenCalledTimes(1);
    // Order matters: project first, then reconcile
    expect(callOrder).toEqual(['projectNow', 'syncAfterTopologyChange']);
  });

  it('teardown() clears highlight, callbacks, and resets runtime', () => {
    const callOrder: string[] = [];
    const mockBgr = {
      projectNow: vi.fn(),
      reset: vi.fn(() => callOrder.push('reset')),
      getAtomIndicesForGroup: vi.fn(() => null),
      getDisplaySourceKind: vi.fn(() => 'live' as const),
    };
    const mockHighlight = {
      toggleSelectedGroup: vi.fn(),
      setHoveredGroup: vi.fn(),
      clearHighlight: vi.fn(() => callOrder.push('clearHighlight')),
      syncToRenderer: vi.fn(),
      syncAfterTopologyChange: vi.fn(),
    };

    // Register callbacks
    useAppStore.getState().setBondedGroupCallbacks({
      onToggleSelect: vi.fn(),
      onHover: vi.fn(),
      onClearHighlight: vi.fn(),
    });
    expect(useAppStore.getState().bondedGroupCallbacks).not.toBeNull();

    const coord = createBondedGroupCoordinator({
      getBondedGroupRuntime: () => mockBgr,
      getBondedGroupHighlightRuntime: () => mockHighlight,
    });

    coord.teardown();

    // Correct order: clear highlight first, then callbacks, then reset
    expect(callOrder).toEqual(['clearHighlight', 'reset']);
    expect(useAppStore.getState().bondedGroupCallbacks).toBeNull();
    expect(mockHighlight.clearHighlight).toHaveBeenCalledTimes(1);
    expect(mockBgr.reset).toHaveBeenCalledTimes(1);
  });

  it('update handles null runtimes gracefully', () => {
    const coord = createBondedGroupCoordinator({
      getBondedGroupRuntime: () => null,
      getBondedGroupHighlightRuntime: () => null,
    });
    // Should not throw
    coord.update();
    coord.teardown();
  });
});
