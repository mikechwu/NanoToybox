/**
 * @vitest-environment jsdom
 */
/**
 * Review UI lock runtime guard tests.
 *
 * Verifies that ui-bindings callback guards block locked actions in review
 * mode and show the review hint, while allowing them in live mode.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { registerStoreCallbacks, type UIBindingsDeps } from '../../lab/js/runtime/ui-bindings';
import { useAppStore } from '../../lab/js/store/app-store';
import { REVIEW_LOCK_STATUS } from '../../lab/js/store/selectors/review-ui-lock';

function makeDeps(): UIBindingsDeps {
  return {
    overlayRuntime: { open: vi.fn(), close: vi.fn(), isOpen: vi.fn(() => false) } as any,
    togglePause: vi.fn(),
    changeSpeed: vi.fn(),
    setInteractionMode: vi.fn(),
    forceRenderThisTick: vi.fn(),
    clearPlayground: vi.fn(),
    resetView: vi.fn(),
    updateChooserRecentRow: vi.fn(),
    setPhysicsWallMode: vi.fn(),
    setPhysicsDragStrength: vi.fn(),
    setPhysicsRotateStrength: vi.fn(),
    setPhysicsDamping: vi.fn(),
    applyTheme: vi.fn(),
    applyTextSize: vi.fn(),
    isWorkerActive: vi.fn(() => false),
    sendWorkerInteraction: vi.fn(),
    isPlacementActive: vi.fn(() => false),
    exitPlacement: vi.fn(),
    startPlacement: vi.fn(),
  };
}

describe('Review UI lock runtime guards', () => {
  beforeEach(() => {
    useAppStore.getState().resetTransientState();
  });

  it('B1: onAdd blocked in review, shows hint', () => {
    const deps = makeDeps();
    registerStoreCallbacks(deps);
    useAppStore.getState().setTimelineMode('review');

    useAppStore.getState().dockCallbacks!.onAdd();

    expect(deps.overlayRuntime.open).not.toHaveBeenCalled();
    expect(useAppStore.getState().statusText).toBe(REVIEW_LOCK_STATUS);
  });

  it('B2: onPause blocked in review, shows hint', () => {
    const deps = makeDeps();
    registerStoreCallbacks(deps);
    useAppStore.getState().setTimelineMode('review');

    useAppStore.getState().dockCallbacks!.onPause();

    expect(deps.togglePause).not.toHaveBeenCalled();
    expect(useAppStore.getState().statusText).toBe(REVIEW_LOCK_STATUS);
  });

  it('B3: onModeChange blocked in review, shows hint', () => {
    const deps = makeDeps();
    registerStoreCallbacks(deps);
    useAppStore.getState().setTimelineMode('review');

    useAppStore.getState().dockCallbacks!.onModeChange('move');

    expect(deps.setInteractionMode).not.toHaveBeenCalled();
    expect(useAppStore.getState().statusText).toBe(REVIEW_LOCK_STATUS);
  });

  it('B4: onAddMolecule blocked in review, shows hint', () => {
    const deps = makeDeps();
    registerStoreCallbacks(deps);
    useAppStore.getState().setTimelineMode('review');

    useAppStore.getState().settingsCallbacks!.onAddMolecule();

    expect(deps.overlayRuntime.open).not.toHaveBeenCalled();
    expect(useAppStore.getState().statusText).toBe(REVIEW_LOCK_STATUS);
  });

  it('B5: onSelectStructure blocked in review, shows hint', () => {
    const deps = makeDeps();
    registerStoreCallbacks(deps);
    useAppStore.getState().setTimelineMode('review');

    useAppStore.getState().chooserCallbacks!.onSelectStructure('c60.xyz', 'C60');

    expect(deps.startPlacement).not.toHaveBeenCalled();
    expect(useAppStore.getState().statusText).toBe(REVIEW_LOCK_STATUS);
  });

  it('B6: onClear blocked in review, shows hint', () => {
    const deps = makeDeps();
    registerStoreCallbacks(deps);
    useAppStore.getState().setTimelineMode('review');

    useAppStore.getState().settingsCallbacks!.onClear();

    expect(deps.clearPlayground).not.toHaveBeenCalled();
    expect(useAppStore.getState().statusText).toBe(REVIEW_LOCK_STATUS);
  });

  it('B7: all callbacks work normally in live mode', () => {
    const deps = makeDeps();
    registerStoreCallbacks(deps);
    // Ensure live mode (default)
    expect(useAppStore.getState().timelineMode).toBe('live');

    useAppStore.getState().dockCallbacks!.onPause();
    expect(deps.togglePause).toHaveBeenCalled();

    useAppStore.getState().dockCallbacks!.onModeChange('move');
    expect(deps.setInteractionMode).toHaveBeenCalledWith('move');

    useAppStore.getState().dockCallbacks!.onAdd();
    expect(deps.overlayRuntime.open).toHaveBeenCalledWith('chooser');
  });
});
