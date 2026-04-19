/** Timeline mode rail.
 *  Off/ready: simple label (no segmented chrome).
 *  Live/review: bidirectional 2-segment vertical switch with ActionHint tooltips.
 *  The rail width is invariant (--tl-rail-width); only the internal presentation varies. */

import React from 'react';
import { ActionHint } from '../ActionHint';
import { TIMELINE_HINTS } from './timeline-hints';

export interface TimelineModeSwitchProps {
  mode: 'off' | 'ready' | 'live' | 'review';
  canReturnToLive?: boolean;
  hasRange?: boolean;
  onReturnToLive?: () => void;
  onEnterReview?: () => void;
}

/** Off/ready: simple centered label in the rail. No segmented control chrome. */
function ModeLabel({ label }: { label: string }) {
  return (
    <div className="timeline-mode-label">
      <span className="timeline-mode-label__text">{label}</span>
    </div>
  );
}

/** Live/review: 2-segment vertical switch with sliding indicator. */
function ModeSwitch({ props }: { props: TimelineModeSwitchProps }) {
  const { mode, canReturnToLive, hasRange, onReturnToLive, onEnterReview } = props;
  const isReview = mode === 'review';
  const isLive = mode === 'live';

  const simClickable = isReview && canReturnToLive;
  const reviewClickable = isLive && hasRange;

  const simButton = (
    <button
      className={`timeline-mode-switch__seg${!isReview ? ' timeline-mode-switch__seg--active' : ''}`}
      disabled={!simClickable}
      onClick={simClickable ? onReturnToLive : undefined}
      aria-label={isReview ? 'Back to simulation' : undefined}
    >
      Simulation
    </button>
  );

  const reviewButton = (
    <button
      className={`timeline-mode-switch__seg${isReview ? ' timeline-mode-switch__seg--active' : ''}`}
      disabled={!reviewClickable}
      onClick={reviewClickable ? onEnterReview : undefined}
      aria-label={isLive ? 'Enter review mode' : undefined}
    >
      Review
    </button>
  );

  return (
    <div className="timeline-mode-switch" style={{ '--tms-active': isReview ? 1 : 0 } as React.CSSProperties}>
      {simClickable ? (
        <ActionHint text={TIMELINE_HINTS.returnToSimulation} anchorClassName="timeline-mode-switch__hint-anchor">{simButton}</ActionHint>
      ) : simButton}
      {isLive ? (
        <ActionHint
          text={reviewClickable ? TIMELINE_HINTS.enterReview : TIMELINE_HINTS.enterReviewDisabled}
          focusableWhenDisabled={!reviewClickable}
          focusLabel="Review (unavailable)"
          anchorClassName="timeline-mode-switch__hint-anchor"
        >
          {reviewButton}
        </ActionHint>
      ) : reviewButton}
    </div>
  );
}

export function TimelineModeSwitch(props: TimelineModeSwitchProps) {
  if (props.mode === 'off') return <ModeLabel label="History Off" />;
  if (props.mode === 'ready') return <ModeLabel label="Ready" />;
  return <ModeSwitch props={props} />;
}
