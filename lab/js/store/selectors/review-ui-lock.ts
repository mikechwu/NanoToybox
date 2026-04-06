/**
 * Review UI lock selector — derives disabled-control state from timeline mode.
 *
 * When timelineMode === 'review', live-edit actions (Add, mode change,
 * pause/resume, add-molecule, clear, structure selection) must be unavailable.
 * This selector is the single source of truth for that policy.
 *
 * Components consume selectReviewUiLock() for individual lock flags.
 * Runtime guards in ui-bindings.ts also enforce the lock at the callback
 * boundary for defense-in-depth.
 */

import type { AppStore } from '../app-store';

export interface ReviewUiLockState {
  isReview: boolean;
  disableAdd: boolean;
  disableInteractionModes: boolean;
  disablePauseResume: boolean;
  disableSettingsAddMolecule: boolean;
  disableSettingsClear: boolean;
}

/** Short tooltip for desktop hover/focus. */
export const REVIEW_LOCK_TOOLTIP =
  'Review mode is read-only. Tap Simulation to return.';

/** Fuller explanation for mobile/status hint. */
export const REVIEW_LOCK_STATUS =
  'Review mode is read-only. Tap Simulation to return, Restart here to continue from this point, or the close icon to clear history.';

/**
 * Primitive selector for individual review-lock flags.
 * Components should destructure only what they need to avoid unnecessary re-renders.
 * Returns a stable boolean per flag (React-friendly primitive selectors).
 */
export function selectReviewUiLockState(s: AppStore): ReviewUiLockState {
  const isReview = s.timelineMode === 'review';
  return {
    isReview,
    disableAdd: isReview,
    disableInteractionModes: isReview,
    disablePauseResume: isReview,
    disableSettingsAddMolecule: isReview,
    disableSettingsClear: isReview,
  };
}

/** Primitive selector: true when review mode is active. React-stable (returns boolean). */
export function selectIsReviewLocked(s: AppStore): boolean {
  return s.timelineMode === 'review';
}

