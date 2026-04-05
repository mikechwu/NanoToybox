/**
 * ReviewLockedListItem — list-native locked row for review mode.
 *
 * Renders <li> as the outermost element (valid inside <ul>/<ol>).
 * Row content is dimmed via an inner wrapper; tooltip sits outside the
 * dimmed wrapper so it renders at full contrast.
 * Desktop: hover/focus shows tooltip. Mobile: tap shows status hint.
 * Keyboard: role="button" + tabIndex={0} + Enter/Space activation.
 *
 * Uses useReviewLockedInteraction for shared behavior.
 * Used by SettingsSheet for review-locked Add Molecule, Clear, etc.
 */

import React from 'react';
import { REVIEW_LOCK_TOOLTIP } from '../store/selectors/review-ui-lock';
import { useReviewLockedInteraction } from '../hooks/useReviewLockedInteraction';
import type { ReviewLockedPlacement } from './ReviewLockedControl';

export interface ReviewLockedListItemProps {
  label: string;
  className?: string;
  /** Tooltip placement variant. Default: 'bottom-start' for settings rows. */
  hintPlacement?: ReviewLockedPlacement;
  children: React.ReactNode;
}

export function ReviewLockedListItem({ label, className, hintPlacement = 'bottom-start', children }: ReviewLockedListItemProps) {
  const { tooltipId, hintVisible, show, hide, handleClick, handleKeyDown } = useReviewLockedInteraction();

  const placementClass = hintPlacement === 'top' ? '' : ` timeline-hint--${hintPlacement}`;

  return (
    <li
      className={`${className ?? ''} review-locked-list-item`}
      role="button"
      tabIndex={0}
      aria-disabled="true"
      aria-label={label}
      aria-describedby={tooltipId}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
    >
      <span className="review-locked-content">{children}</span>
      <span
        id={tooltipId}
        role="tooltip"
        className={`timeline-hint${placementClass}${hintVisible ? ' timeline-hint--visible' : ''}`}
      >
        {REVIEW_LOCK_TOOLTIP}
        <span className="timeline-hint-arrow" />
      </span>
    </li>
  );
}
