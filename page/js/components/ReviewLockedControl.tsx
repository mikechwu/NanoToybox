/**
 * ReviewLockedControl — wraps a disabled control for review-mode discoverability.
 *
 * Desktop: shows ActionHint tooltip on hover/focus (keyboard-focusable wrapper).
 * Mobile: taps the wrapper call showReviewModeActionHint() for transient status hint.
 * Visual: child is rendered with aria-disabled styling but remains interactable.
 *
 * Uses useReviewLockedInteraction for shared behavior.
 * Used by DockBar (Add, Pause), StructureChooser (rows).
 */

import React from 'react';
import { REVIEW_LOCK_TOOLTIP } from '../store/selectors/review-ui-lock';
import { useReviewLockedInteraction } from '../hooks/useReviewLockedInteraction';
import { ActionHint } from './ActionHint';

export interface ReviewLockedControlProps {
  label: string;
  placement?: 'top' | 'top-end' | 'right';
  children: React.ReactElement;
}

export function ReviewLockedControl({ label, placement = 'top', children }: ReviewLockedControlProps) {
  const { handleClick } = useReviewLockedInteraction();

  return (
    <ActionHint text={REVIEW_LOCK_TOOLTIP} focusableWhenDisabled focusLabel={label} placement={placement}>
      <span
        className="review-locked-trigger"
        role="button"
        aria-disabled="true"
        aria-label={label}
        onClick={handleClick}
      >
        {children}
      </span>
    </ActionHint>
  );
}
