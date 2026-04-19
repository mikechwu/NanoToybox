/**
 * Review-mode action hints — centralized hint delivery for locked actions.
 *
 * Owns: the user-facing unavailable-action message and its delivery via
 *   the status text surface (mobile/transient hint fallback).
 * Does not: own the lock policy itself (that lives in review-ui-lock selector).
 * Called by: ui-bindings.ts (runtime guard), DockBar/SettingsSheet/StructureChooser (tap handler).
 */

import { CONFIG } from '../../config';
import { useAppStore } from '../../store/app-store';
import { REVIEW_LOCK_STATUS } from '../../store/selectors/review-ui-lock';
let _hintTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Show the review-mode locked-action hint via the transient status text surface.
 * Uses the fuller REVIEW_LOCK_STATUS copy (explains exits).
 * Used for mobile (no hover) and as a fallback for runtime guard intercepts.
 * Auto-clears after HINT_DISPLAY_MS. Only one hint active at a time.
 */
export function showReviewModeActionHint(): void {
  const store = useAppStore.getState();
  store.setStatusText(REVIEW_LOCK_STATUS);
  if (_hintTimer) clearTimeout(_hintTimer);
  _hintTimer = setTimeout(() => {
    if (useAppStore.getState().statusText === REVIEW_LOCK_STATUS) {
      useAppStore.getState().setStatusText(null);
    }
    _hintTimer = null;
  }, CONFIG.reviewModeUi.statusHintMs);
}
