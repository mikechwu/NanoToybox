/**
 * Unit tests for dock surface selector.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { useAppStore } from '../../lab/js/store/app-store';
import { selectDockSurface } from '../../lab/js/store/selectors/dock';

describe('selectDockSurface', () => {
  beforeEach(() => {
    useAppStore.getState().resetTransientState();
  });

  it('returns "primary" when placementActive is false', () => {
    useAppStore.getState().setPlacementActive(false);
    const surface = selectDockSurface(useAppStore.getState());
    expect(surface).toBe('primary');
  });

  it('returns "placement" when placementActive is true', () => {
    useAppStore.getState().setPlacementActive(true);
    const surface = selectDockSurface(useAppStore.getState());
    expect(surface).toBe('placement');
  });

  it('returns "primary" after resetTransientState', () => {
    useAppStore.getState().setPlacementActive(true);
    useAppStore.getState().resetTransientState();
    const surface = selectDockSurface(useAppStore.getState());
    expect(surface).toBe('primary');
  });
});
