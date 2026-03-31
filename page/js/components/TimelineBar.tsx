/**
 * TimelineBar — bottom timeline UI for recording and reviewing simulation history.
 *
 * Always renders when the subsystem is installed (timelineInstalled === true).
 * Layout: two rows stacked vertically.
 *   Row 1 (grid): badge | time | track — fixed columns, track width stable
 *   Row 2 (flex): meta + actions — independent of row 1 column sizing
 *
 * This separation guarantees the scrub track width is identical across
 * off/ready/active/review states regardless of how many action buttons
 * are rendered.
 */

import React, { useCallback, useRef } from 'react';
import { useAppStore } from '../store/app-store';
import { TimelineActionHint } from './TimelineActionHint';

function formatTime(ps: number): string {
  if (ps < 0.001) return `${(ps * 1000).toFixed(1)} fs`;
  if (ps < 1) return `${(ps * 1000).toFixed(0)} fs`;
  if (ps < 100) return `${ps.toFixed(2)} ps`;
  if (ps < 10_000) return `${ps.toFixed(1)} ps`;
  if (ps < 1_000_000) return `${(ps / 1000).toFixed(2)} ns`;
  return `${(ps / 1_000_000).toFixed(2)} \u00b5s`;
}

export function TimelineBar() {
  const installed = useAppStore((s) => s.timelineInstalled);
  const recordingMode = useAppStore((s) => s.timelineRecordingMode);

  if (!installed) return null;

  if (recordingMode === 'off') return <TimelineBarOff />;
  if (recordingMode === 'ready') return <TimelineBarReady />;
  return <TimelineBarActive />;
}

/** Off state — "Start Recording" button. */
function TimelineBarOff() {
  const callbacks = useAppStore((s) => s.timelineCallbacks);
  const handleStart = useCallback(() => { callbacks?.onStartRecordingNow(); }, [callbacks]);

  return (
    <div className="timeline-bar timeline-bar--disabled" role="region" aria-label="Simulation timeline">
      <div className="timeline-row1">
        <span className="timeline-badge timeline-badge--off">History Off</span>
        <span className="timeline-time">0.0 fs</span>
        <div className="timeline-track timeline-track--disabled" />
      </div>
      <div className="timeline-row2">
        <span className="timeline-lane-meta" />
        <div className="timeline-lane-actions timeline-actions">
          <TimelineActionHint text="Start saving timeline history now.">
            <button className="timeline-action" onClick={handleStart}>Start Recording</button>
          </TimelineActionHint>
        </div>
      </div>
    </div>
  );
}

/** Ready state — passive startup, waiting for first atom interaction. */
function TimelineBarReady() {
  const callbacks = useAppStore((s) => s.timelineCallbacks);
  const handleTurnOff = useCallback(() => { callbacks?.onTurnRecordingOff(); }, [callbacks]);

  return (
    <div className="timeline-bar timeline-bar--disabled" role="region" aria-label="Simulation timeline">
      <div className="timeline-row1">
        <span className="timeline-badge timeline-badge--ready">Ready</span>
        <span className="timeline-time">0.0 fs</span>
        <div className="timeline-track timeline-track--disabled" />
      </div>
      <div className="timeline-row2">
        <span className="timeline-lane-meta timeline-helper">Recording starts when you touch an atom</span>
        <div className="timeline-lane-actions timeline-actions">
          <TimelineActionHint text="Stop recording and erase all saved history." placement="top-end">
            <button className="timeline-action timeline-action--destructive" onClick={handleTurnOff}>Stop &amp; Clear</button>
          </TimelineActionHint>
        </div>
      </div>
    </div>
  );
}

/** Active state — full scrubber with Recording/Review modes and action buttons. */
function TimelineBarActive() {
  const mode = useAppStore((s) => s.timelineMode);
  const currentTimePs = useAppStore((s) => s.timelineCurrentTimePs);
  const rangePs = useAppStore((s) => s.timelineRangePs);
  const canReturnToLive = useAppStore((s) => s.timelineCanReturnToLive);
  const canRestart = useAppStore((s) => s.timelineCanRestart);
  const restartTargetPs = useAppStore((s) => s.timelineRestartTargetPs);
  const callbacks = useAppStore((s) => s.timelineCallbacks);

  const trackRef = useRef<HTMLDivElement>(null);
  const isDragging = useRef(false);

  const rangeDuration = rangePs ? rangePs.end - rangePs.start : 0;
  const progress = rangePs && rangeDuration > 0
    ? Math.max(0, Math.min(1, (currentTimePs - rangePs.start) / rangeDuration))
    : 0;

  const hasRange = rangePs && rangeDuration > 0;

  const scrubFromEvent = useCallback((clientX: number) => {
    const track = trackRef.current;
    if (!track || !callbacks || !rangePs) return;
    const rect = track.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    const timePs = rangePs.start + ratio * (rangePs.end - rangePs.start);
    callbacks.onScrub(timePs);
  }, [callbacks, rangePs]);

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    if (!hasRange) return;
    isDragging.current = true;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    scrubFromEvent(e.clientX);
  }, [scrubFromEvent, hasRange]);

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    if (!isDragging.current) return;
    scrubFromEvent(e.clientX);
  }, [scrubFromEvent]);

  const handlePointerUp = useCallback(() => {
    isDragging.current = false;
  }, []);

  const handleReturnToLive = useCallback(() => { callbacks?.onReturnToLive(); }, [callbacks]);
  const handleRestart = useCallback(() => { callbacks?.onRestartFromHere(); }, [callbacks]);
  const handleTurnOff = useCallback(() => { callbacks?.onTurnRecordingOff(); }, [callbacks]);

  const isReview = mode === 'review';
  const restartHint = canRestart
    ? 'Restart the simulation from this saved point.'
    : 'No restart point is available here.';

  return (
    <div className="timeline-bar" role="region" aria-label="Simulation timeline">
      <div className="timeline-row1">
        <span className={`timeline-badge ${isReview ? 'timeline-badge--review' : 'timeline-badge--live'}`}>
          {isReview ? 'Review' : 'Recording'}
        </span>
        <span className="timeline-time">{formatTime(currentTimePs)}</span>
        <div
          className={`timeline-track${hasRange ? '' : ' timeline-track--disabled'}`}
          ref={trackRef}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
        >
          <div className="timeline-fill" style={{ width: `${progress * 100}%` }} />
          {hasRange && <div className="timeline-thumb" style={{ left: `${progress * 100}%` }} />}
        </div>
      </div>
      <div className="timeline-row2">
        <span className="timeline-lane-meta">
          {isReview && restartTargetPs !== null && (
            <span className="timeline-restart-target">Restart at {formatTime(restartTargetPs)}</span>
          )}
        </span>
        <div className="timeline-lane-actions timeline-actions">
          {isReview && (
            <>
              <TimelineActionHint text="Jump back to the current simulation." focusableWhenDisabled={!canReturnToLive} focusLabel="Live">
                <button className="timeline-action" onClick={handleReturnToLive} disabled={!canReturnToLive}>Live</button>
              </TimelineActionHint>
              <TimelineActionHint text={restartHint} focusableWhenDisabled={!canRestart} focusLabel="Restart">
                <button className="timeline-action timeline-action--restart" onClick={handleRestart} disabled={!canRestart}>Restart</button>
              </TimelineActionHint>
            </>
          )}
          <TimelineActionHint text="Stop recording and erase all saved history." placement="top-end">
            <button className="timeline-action timeline-action--destructive" onClick={handleTurnOff}>Stop &amp; Clear</button>
          </TimelineActionHint>
        </div>
      </div>
    </div>
  );
}
