/**
 * @vitest-environment jsdom
 */
/**
 * Tests for TimelineBar lifecycle: null→valid range transition.
 *
 * Verifies that the component correctly handles the transition from
 * "no history" (returns null) to "history available" (renders bar)
 * without throwing a React hook-order error.
 *
 * This pins the exact regression that caused the UI tree to crash
 * when timeline data first arrived ~0.5s after app start.
 */
import React from 'react';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, cleanup, act } from '@testing-library/react';
import { useAppStore } from '../../page/js/store/app-store';
import { TimelineBar } from '../../page/js/components/TimelineBar';

describe('TimelineBar lifecycle', () => {
  beforeEach(() => {
    useAppStore.getState().resetTransientState();
  });

  afterEach(() => {
    cleanup();
  });

  it('returns null when no timeline range', () => {
    const { container } = render(<TimelineBar />);
    expect(container.querySelector('.timeline-bar')).toBeNull();
  });

  it('renders when range becomes valid (null→valid transition)', () => {
    const { container, rerender } = render(<TimelineBar />);
    expect(container.querySelector('.timeline-bar')).toBeNull();

    // Simulate timeline data arriving
    act(() => {
      useAppStore.getState().updateTimelineState({
        mode: 'live',
        currentTimePs: 500,
        reviewTimePs: null,
        rangePs: { start: 0, end: 1000 },
        canReturnToLive: false,
        canRestart: false,
        restartTargetPs: null,
      });
    });
    rerender(<TimelineBar />);

    expect(container.querySelector('.timeline-bar')).not.toBeNull();
    expect(container.querySelector('.timeline-badge--live')).not.toBeNull();
  });

  it('survives repeated null→valid→null transitions without throwing', () => {
    const { container, rerender } = render(<TimelineBar />);

    for (let i = 0; i < 3; i++) {
      // Go valid
      act(() => {
        useAppStore.getState().updateTimelineState({
          mode: 'live',
          currentTimePs: i * 100,
          reviewTimePs: null,
          rangePs: { start: 0, end: (i + 1) * 100 },
          canReturnToLive: false,
          canRestart: false,
          restartTargetPs: null,
        });
      });
      rerender(<TimelineBar />);
      expect(container.querySelector('.timeline-bar')).not.toBeNull();

      // Go null
      act(() => {
        useAppStore.getState().updateTimelineState({
          mode: 'live',
          currentTimePs: 0,
          reviewTimePs: null,
          rangePs: null,
          canReturnToLive: false,
          canRestart: false,
          restartTargetPs: null,
        });
      });
      rerender(<TimelineBar />);
      expect(container.querySelector('.timeline-bar')).toBeNull();
    }
  });

  it('shows review badge and action buttons in review mode', () => {
    act(() => {
      useAppStore.getState().updateTimelineState({
        mode: 'review',
        currentTimePs: 500,
        reviewTimePs: 500,
        rangePs: { start: 0, end: 1000 },
        canReturnToLive: true,
        canRestart: true,
        restartTargetPs: 500,
      });
      useAppStore.getState().setTimelineCallbacks({
        onScrub: () => {},
        onReturnToLive: () => {},
        onRestartFromHere: () => {},
      });
    });
    const { container } = render(<TimelineBar />);
    expect(container.querySelector('.timeline-badge--review')?.textContent).toBe('Review');
    expect(container.querySelector('.timeline-action')?.textContent).toBe('Live');
    // Restart button has fixed label; target time shown in separate readout
    expect(container.querySelector('.timeline-action--restart')?.textContent).toBe('Restart');
    expect(container.querySelector('.timeline-restart-target')?.textContent).toBe('500 ps');
  });

  it('action slot is always present for stable track width', () => {
    // In live mode, actions container is rendered but hidden
    act(() => {
      useAppStore.getState().updateTimelineState({
        mode: 'live',
        currentTimePs: 500,
        reviewTimePs: null,
        rangePs: { start: 0, end: 1000 },
        canReturnToLive: false,
        canRestart: false,
        restartTargetPs: null,
      });
      useAppStore.getState().setTimelineCallbacks({
        onScrub: () => {},
        onReturnToLive: () => {},
        onRestartFromHere: () => {},
      });
    });
    const { container, rerender } = render(<TimelineBar />);
    const liveActions = container.querySelector('.timeline-actions') as HTMLElement;
    expect(liveActions).not.toBeNull();
    expect(liveActions.style.visibility).toBe('hidden');

    // In review mode, same container is visible
    act(() => {
      useAppStore.getState().updateTimelineState({
        mode: 'review',
        currentTimePs: 500,
        reviewTimePs: 500,
        rangePs: { start: 0, end: 1000 },
        canReturnToLive: true,
        canRestart: true,
        restartTargetPs: 500,
      });
    });
    rerender(<TimelineBar />);
    const reviewActions = container.querySelector('.timeline-actions') as HTMLElement;
    expect(reviewActions).not.toBeNull();
    expect(reviewActions.style.visibility).toBe('visible');
  });

  it('all fixed-width layout elements present in both modes', () => {
    // Live mode
    act(() => {
      useAppStore.getState().updateTimelineState({
        mode: 'live',
        currentTimePs: 500,
        reviewTimePs: null,
        rangePs: { start: 0, end: 1000 },
        canReturnToLive: false,
        canRestart: false,
        restartTargetPs: null,
      });
      useAppStore.getState().setTimelineCallbacks({
        onScrub: () => {},
        onReturnToLive: () => {},
        onRestartFromHere: () => {},
      });
    });
    const { container, rerender } = render(<TimelineBar />);

    // Fixed-width structural elements must exist in live mode
    expect(container.querySelector('.timeline-badge')).not.toBeNull();
    expect(container.querySelector('.timeline-time')).not.toBeNull();
    expect(container.querySelector('.timeline-track')).not.toBeNull();
    expect(container.querySelector('.timeline-actions')).not.toBeNull();
    expect(container.querySelector('.timeline-restart-target')).not.toBeNull();

    // Switch to review — same structure must exist
    act(() => {
      useAppStore.getState().updateTimelineState({
        mode: 'review',
        currentTimePs: 500,
        reviewTimePs: 500,
        rangePs: { start: 0, end: 1000 },
        canReturnToLive: true,
        canRestart: true,
        restartTargetPs: 400,
      });
    });
    rerender(<TimelineBar />);
    expect(container.querySelector('.timeline-badge')).not.toBeNull();
    expect(container.querySelector('.timeline-time')).not.toBeNull();
    expect(container.querySelector('.timeline-track')).not.toBeNull();
    expect(container.querySelector('.timeline-actions')).not.toBeNull();
    expect(container.querySelector('.timeline-restart-target')).not.toBeNull();
  });
});
