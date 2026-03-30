/**
 * TimelineBar — bottom timeline UI for reviewing simulation history.
 *
 * Renders a scrubber bar, mode badge (Live/Reviewing), Return to Live,
 * and Restart From Here buttons. Lives inside DockLayout as a normal-flow
 * child above DockBar.
 *
 * Split into outer gate (TimelineBar) + inner component (TimelineBarInner)
 * so that hooks are unconditional in the inner component. The outer gate
 * returns null when there is no history, preventing the inner component
 * from mounting at all — no hook-order violation on the null→valid transition.
 */

import React, { useCallback, useRef } from 'react';
import { useAppStore } from '../store/app-store';

/** Format picoseconds into a short human label with enough resolution
 *  to distinguish adjacent recorded frames (~0.0005 ps apart at 1x). */
function formatTime(ps: number): string {
  if (ps < 0.001) return `${(ps * 1000).toFixed(1)} fs`;
  if (ps < 1) return `${(ps * 1000).toFixed(0)} fs`;
  if (ps < 100) return `${ps.toFixed(2)} ps`;
  if (ps < 10_000) return `${ps.toFixed(1)} ps`;
  if (ps < 1_000_000) return `${(ps / 1000).toFixed(2)} ns`;
  return `${(ps / 1_000_000).toFixed(2)} \u00b5s`;
}

/** Outer gate — returns null when no history, mounts inner only when valid. */
export function TimelineBar() {
  const rangePs = useAppStore((s) => s.timelineRangePs);
  if (!rangePs || rangePs.end <= rangePs.start) return null;
  return <TimelineBarInner />;
}

/** Inner component — always renders with full hook set. */
function TimelineBarInner() {
  const mode = useAppStore((s) => s.timelineMode);
  const currentTimePs = useAppStore((s) => s.timelineCurrentTimePs);
  const rangePs = useAppStore((s) => s.timelineRangePs)!;
  const canReturnToLive = useAppStore((s) => s.timelineCanReturnToLive);
  const canRestart = useAppStore((s) => s.timelineCanRestart);
  const restartTargetPs = useAppStore((s) => s.timelineRestartTargetPs);
  const callbacks = useAppStore((s) => s.timelineCallbacks);

  const trackRef = useRef<HTMLDivElement>(null);
  const isDragging = useRef(false);

  const rangeDuration = rangePs.end - rangePs.start;
  const progress = rangeDuration > 0
    ? Math.max(0, Math.min(1, (currentTimePs - rangePs.start) / rangeDuration))
    : 1;

  const scrubFromEvent = useCallback((clientX: number) => {
    const track = trackRef.current;
    if (!track || !callbacks || !rangePs) return;
    const rect = track.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    const timePs = rangePs.start + ratio * (rangePs.end - rangePs.start);
    callbacks.onScrub(timePs);
  }, [callbacks, rangePs]);

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    isDragging.current = true;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    scrubFromEvent(e.clientX);
  }, [scrubFromEvent]);

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    if (!isDragging.current) return;
    scrubFromEvent(e.clientX);
  }, [scrubFromEvent]);

  const handlePointerUp = useCallback(() => {
    isDragging.current = false;
  }, []);

  const handleReturnToLive = useCallback(() => {
    callbacks?.onReturnToLive();
  }, [callbacks]);

  const handleRestart = useCallback(() => {
    callbacks?.onRestartFromHere();
  }, [callbacks]);

  const isReview = mode === 'review';

  return (
    <div className="timeline-bar" role="region" aria-label="Simulation timeline">
      <span className={`timeline-badge ${isReview ? 'timeline-badge--review' : 'timeline-badge--live'}`}>
        {isReview ? 'Review' : 'Live'}
      </span>

      <span className="timeline-time">{formatTime(currentTimePs)}</span>

      <div
        className="timeline-track"
        ref={trackRef}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
      >
        <div className="timeline-fill" style={{ width: `${progress * 100}%` }} />
        <div className="timeline-thumb" style={{ left: `${progress * 100}%` }} />
      </div>

      {/* Action slot — fixed-width, always rendered for stable track width.
        * Button labels are constant; target time shown in a separate readout. */}
      <div className="timeline-actions" style={{ visibility: isReview ? 'visible' : 'hidden' }}>
        <button className="timeline-action" onClick={handleReturnToLive} disabled={!canReturnToLive}>Live</button>
        <button className="timeline-action timeline-action--restart" onClick={handleRestart} disabled={!canRestart}>Restart</button>
        <span className="timeline-restart-target">
          {restartTargetPs !== null ? formatTime(restartTargetPs) : '\u00a0'}
        </span>
      </div>
    </div>
  );
}
