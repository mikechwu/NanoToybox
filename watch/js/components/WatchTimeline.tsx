/**
 * WatchTimeline — playback scrubber using lab's timeline track primitives.
 *
 * Uses shared CSS: timeline-track.css (.timeline-time, .timeline-track, .timeline-fill, .timeline-thumb).
 * Full-width track (no mode rail — watch advantage over lab).
 *
 * Drag resilience: pointer capture is attempted but optional. A local dragActive
 * ref ensures drag continuation works even when capture is unavailable.
 */

import React, { useRef, useCallback } from 'react';
import { formatTime } from '../../../lab/js/components/timeline/timeline-format';

interface WatchTimelineProps {
  currentTimePs: number;
  startTimePs: number;
  endTimePs: number;
  onScrub: (timePs: number) => void;
}

export function WatchTimeline({ currentTimePs, startTimePs, endTimePs, onScrub }: WatchTimelineProps) {
  const trackRef = useRef<HTMLDivElement>(null);
  const dragActive = useRef(false);
  const duration = endTimePs - startTimePs;
  const progress = duration > 0 ? (currentTimePs - startTimePs) / duration : 0;

  const scrubFromEvent = useCallback((e: React.MouseEvent | React.PointerEvent) => {
    const track = trackRef.current;
    if (!track || duration <= 0) return;
    const rect = track.getBoundingClientRect();
    const t = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    onScrub(startTimePs + t * duration);
  }, [startTimePs, duration, onScrub]);

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    scrubFromEvent(e);
    dragActive.current = true;
    const track = trackRef.current;
    if (!track) return;
    try { track.setPointerCapture(e.pointerId); } catch {}
  }, [scrubFromEvent]);

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    const track = trackRef.current;
    if (!track) return;
    // Allow drag continuation via either pointer capture OR local dragActive fallback
    const captured = track.hasPointerCapture(e.pointerId);
    if (!captured && !dragActive.current) return;
    scrubFromEvent(e);
  }, [scrubFromEvent]);

  const handlePointerUp = useCallback(() => {
    dragActive.current = false;
  }, []);

  // Clear dragActive if pointer leaves the track without capture
  const handlePointerLeave = useCallback(() => {
    dragActive.current = false;
  }, []);

  // Empty-state a11y: when no file is loaded (or the range is
  // degenerate), drop the `role="slider"` + aria-value* attributes.
  // Screen readers would otherwise announce a slider with valuemin ==
  // valuemax == 0. Pointer handlers already no-op under `duration <= 0`,
  // so removing the role has no behavior effect.
  const isEmpty = duration <= 0;

  return (
    <div className="watch-timeline-lane">
      <span className="timeline-time">{formatTime(currentTimePs)}</span>
      <div
        ref={trackRef}
        className={`timeline-track timeline-track--thick${isEmpty ? ' timeline-track--empty' : ''}`}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onPointerLeave={handlePointerLeave}
        role={isEmpty ? undefined : 'slider'}
        aria-label={isEmpty ? undefined : 'Timeline'}
        aria-disabled={isEmpty || undefined}
        aria-valuemin={isEmpty ? undefined : startTimePs}
        aria-valuemax={isEmpty ? undefined : endTimePs}
        aria-valuenow={isEmpty ? undefined : currentTimePs}
      >
        <div className="timeline-fill" style={{ width: `${progress * 100}%` }} />
        <div className="timeline-thumb" style={{ left: `${progress * 100}%` }} />
      </div>
      <span className="timeline-time">{formatTime(endTimePs)}</span>
    </div>
  );
}
