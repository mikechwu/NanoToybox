/**
 * Dock surface selector — derives the dock's active surface from app state.
 *
 * Today: placementActive → 'placement' | 'primary'.
 * Future: may read additional state as dock surfaces are added (inspect,
 * selection, etc.). This module is the single home for dock-surface policy.
 *
 * If a future surface has no corresponding app-level boolean (i.e., it's a
 * pure dock-mode concept), promote dockSurface to stored state with a single
 * writer, replacing this derivation.
 */

import type { AppStore } from '../app-store';

export type DockSurface = 'primary' | 'placement';

export function selectDockSurface(s: AppStore): DockSurface {
  return s.placementActive ? 'placement' : 'primary';
}
