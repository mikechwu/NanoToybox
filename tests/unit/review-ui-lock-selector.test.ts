/**
 * Review UI lock selector tests.
 *
 * Validates the pure selector that derives disabled-control state from
 * timelineMode. Single source of truth for review-lock semantics.
 */
import { describe, it, expect } from 'vitest';
import {
  selectReviewUiLockState,
  REVIEW_LOCK_TOOLTIP,
  REVIEW_LOCK_STATUS,
} from '../../lab/js/store/selectors/review-ui-lock';

function mockStore(timelineMode: 'live' | 'review'): any {
  return { timelineMode };
}

describe('selectReviewUiLockState', () => {
  it('A1: live mode — all locks false', () => {
    const state = selectReviewUiLockState(mockStore('live'));
    expect(state.isReview).toBe(false);
    expect(state.disableAdd).toBe(false);
    expect(state.disableInteractionModes).toBe(false);
    expect(state.disablePauseResume).toBe(false);
    expect(state.disableSettingsAddMolecule).toBe(false);
  });

  it('A2: review mode — all locks true', () => {
    const state = selectReviewUiLockState(mockStore('review'));
    expect(state.isReview).toBe(true);
    expect(state.disableAdd).toBe(true);
    expect(state.disableInteractionModes).toBe(true);
    expect(state.disablePauseResume).toBe(true);
    expect(state.disableSettingsAddMolecule).toBe(true);
    expect(state.disableSettingsClear).toBe(true);
  });

  it('A3: tooltip constant contains review-mode explanation', () => {
    expect(REVIEW_LOCK_TOOLTIP).toContain('read-only');
    expect(REVIEW_LOCK_TOOLTIP).toContain('Live');
  });

  it('A4: tooltip and status copy both explain review exits', () => {
    expect(REVIEW_LOCK_TOOLTIP).toContain('Live');
    expect(REVIEW_LOCK_TOOLTIP).toContain('Restart');
    expect(REVIEW_LOCK_STATUS).toContain('Live');
    expect(REVIEW_LOCK_STATUS).toContain('Restart');
    expect(REVIEW_LOCK_STATUS).toContain('Stop & Clear');
    // Status is the fuller variant
    expect(REVIEW_LOCK_STATUS.length).toBeGreaterThan(REVIEW_LOCK_TOOLTIP.length);
  });
});
