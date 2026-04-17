/**
 * ActionHint — hover/focus tooltip for action buttons.
 *
 * Desktop and keyboard only. Hidden on touch devices via CSS media query.
 * Shows after a short delay on mouseenter/focus, hides on mouseleave/blur/click.
 * Handles disabled children by attaching events to the wrapper span.
 *
 * Used by TimelineBar, timeline-mode-switch, timeline-clear-dialog,
 * Segmented, and ReviewLockedControl.
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
  /** Extra class on the wrapper span so it can participate in parent layout (flex, absolute). */
  anchorClassName?: string;
  /** Inline style on the wrapper span (e.g. for absolute positioning). */
  anchorStyle?: React.CSSProperties;
  /** External discoverability cue: when true, the hint is forced
   *  visible regardless of hover / focus / pointer type. Unlike the
   *  hover path, this also shows on touch devices (the usual
   *  `@media (hover: none)` hide rule is bypassed via the
   *  `timeline-hint--force-visible` class).
   *
   *  The caller owns the lifetime — usually a one-shot timed cue.
   *  The paired `forceAnimationKey` prop restarts the CSS animation
   *  when it changes, so re-triggering the cue mid-flight works. */
  forceVisible?: boolean;
  /** Opaque animation-restart token. Passed through to the tooltip's
   *  `key` when `forceVisible` is true, so toggling false→true→true
   *  with a new token restarts the fade keyframes cleanly. */
  forceAnimationKey?: number | string;
  children: React.ReactElement<React.HTMLAttributes<HTMLElement>>;
}

export function ActionHint({ text, focusableWhenDisabled, focusLabel, placement = 'top', anchorClassName, anchorStyle, forceVisible = false, forceAnimationKey, children }: ActionHintProps) {
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
      className={`timeline-hint-anchor${anchorClassName ? ` ${anchorClassName}` : ''}`}
      style={anchorStyle}
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
        // The React `key` is tied to the caller's animation token so
        // a new token re-mounts the tooltip span and the CSS
        // auto-cue keyframe animation restarts from 0% on the next
        // render. Stable across hover-only usage.
        key={forceVisible && forceAnimationKey !== undefined ? String(forceAnimationKey) : undefined}
        className={`timeline-hint${placementClass}${visible ? ' timeline-hint--visible' : ''}${forceVisible ? ' timeline-hint--force-visible' : ''}`}
      >
        {text}
        <span className="timeline-hint-arrow" />
      </span>
    </span>
  );
}
