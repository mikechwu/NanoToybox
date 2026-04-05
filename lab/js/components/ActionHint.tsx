/**
 * ActionHint — hover/focus tooltip for action buttons.
 *
 * Desktop and keyboard only. Hidden on touch devices via CSS media query.
 * Shows after a short delay on mouseenter/focus, hides on mouseleave/blur/click.
 * Handles disabled children by attaching events to the wrapper span.
 *
 * Used by TimelineBar and CameraControls.
 * CSS class family: .timeline-hint-* is retained as shared hint infrastructure
 * (not timeline-specific despite the name). See lab/index.html.
 */

import React, { useState, useRef, useCallback, useEffect, useId } from 'react';

export const HINT_DELAY_MS = 130;

export interface ActionHintProps {
  text: string;
  /** When true, the wrapper becomes keyboard-focusable (tabIndex=0) so the
   *  tooltip is discoverable even when the child button is natively disabled. */
  focusableWhenDisabled?: boolean;
  /** Accessible name for the wrapper when it stands in for a disabled control. */
  focusLabel?: string;
  /** 'top' (default) centers above. 'top-end' right-aligns above. 'right' places to the right. */
  placement?: 'top' | 'top-end' | 'right';
  children: React.ReactElement<React.HTMLAttributes<HTMLElement>>;
}

export function ActionHint({ text, focusableWhenDisabled, focusLabel, placement = 'top', children }: ActionHintProps) {
  const [visible, setVisible] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tooltipId = useId();

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const show = useCallback(() => {
    clearTimer();
    timerRef.current = setTimeout(() => setVisible(true), HINT_DELAY_MS);
  }, [clearTimer]);

  const hide = useCallback(() => {
    clearTimer();
    setVisible(false);
  }, [clearTimer]);

  useEffect(() => clearTimer, [clearTimer]);

  const placementClass = placement === 'top' ? '' : ` timeline-hint--${placement}`;

  return (
    <span
      className="timeline-hint-anchor"
      tabIndex={focusableWhenDisabled ? 0 : undefined}
      aria-label={focusableWhenDisabled ? focusLabel : undefined}
      aria-describedby={focusableWhenDisabled ? tooltipId : undefined}
      aria-disabled={focusableWhenDisabled ? true : undefined}
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
      onClick={hide}
    >
      {React.cloneElement(children, { 'aria-describedby': tooltipId })}
      <span
        id={tooltipId}
        role="tooltip"
        className={`timeline-hint${placementClass}${visible ? ' timeline-hint--visible' : ''}`}
      >
        {text}
        <span className="timeline-hint-arrow" />
      </span>
    </span>
  );
}
