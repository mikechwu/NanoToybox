/**
 * @vitest-environment jsdom
 */
/**
 * Tests for TimelineBar component rendering with 3-state recording mode.
 *
 * Verifies:
 *   - Bar returns null when timeline subsystem is not installed
 *   - Off state renders gray disabled bar with "Start Recording" button
 *   - Ready state renders "Ready" badge with helper text
 *   - Active state renders full scrubber with "Recording" badge
 *   - Review mode shows action buttons (Live, Restart, Stop & Clear)
 *   - Component re-renders correctly when store recording mode changes
 *   - 2-row grid lanes: badge, time, track (row 1), meta, actions (row 2)
 *   - Button clicks invoke the correct store callbacks
 *   - Startup uses atomic installTimelineUI (no transient off flash)
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, act, fireEvent } from '@testing-library/react';
import { useAppStore } from '../../lab/js/store/app-store';
import type { TimelineCallbacks } from '../../lab/js/store/app-store';
import { TimelineBar } from '../../lab/js/components/TimelineBar';
import { HINT_DELAY_MS } from '../../lab/js/components/TimelineActionHint';

const noop = () => {};

const defaultCallbacks: TimelineCallbacks = {
  onScrub: noop, onReturnToLive: noop, onRestartFromHere: noop,
  onStartRecordingNow: noop, onTurnRecordingOff: noop,
};

/** Install subsystem via the real atomic store helper. */
function installSubsystem(mode: 'off' | 'ready' | 'active' = 'off') {
  useAppStore.getState().installTimelineUI({ ...defaultCallbacks }, mode);
}

/** Install subsystem with custom callbacks (for spy/assertion tests). */
function installSubsystemWithCallbacks(mode: 'off' | 'ready' | 'active', callbacks: Partial<TimelineCallbacks>) {
  useAppStore.getState().installTimelineUI({ ...defaultCallbacks, ...callbacks }, mode);
}

describe('TimelineBar lifecycle', () => {
  beforeEach(() => {
    useAppStore.getState().resetTransientState();
  });

  afterEach(() => {
    cleanup();
  });

  // ── Render gate ──

  it('returns null when timeline subsystem is not installed', () => {
    const { container } = render(<TimelineBar />);
    expect(container.querySelector('.timeline-bar')).toBeNull();
  });

  // ── Static state rendering ──

  it('renders off state when recording mode is off', () => {
    act(() => { installSubsystem('off'); });
    const { container } = render(<TimelineBar />);
    expect(container.querySelector('.timeline-bar')).not.toBeNull();
    expect(container.querySelector('.timeline-badge--off')?.textContent).toBe('History Off');
    expect(container.querySelector('.timeline-track--disabled')).not.toBeNull();
    const buttons = container.querySelectorAll('.timeline-action');
    expect(Array.from(buttons).some(b => b.textContent === 'Start Recording')).toBe(true);
  });

  it('renders ready state with numeric time and helper text', () => {
    act(() => { installSubsystem('ready'); });
    const { container } = render(<TimelineBar />);
    expect(container.querySelector('.timeline-badge--ready')?.textContent).toBe('Ready');
    expect(container.querySelector('.timeline-time')?.textContent).toBe('0.0 fs');
    expect(container.querySelector('.timeline-helper')?.textContent).toContain('Recording starts');
    expect(container.querySelector('.timeline-track--disabled')).not.toBeNull();
    const buttons = container.querySelectorAll('.timeline-action');
    expect(Array.from(buttons).some(b => b.textContent === 'Stop & Clear')).toBe(true);
  });

  it('renders active live state with scrubber', () => {
    act(() => {
      installSubsystem('active');
      useAppStore.getState().updateTimelineState({
        mode: 'live', currentTimePs: 500, reviewTimePs: null,
        rangePs: { start: 0, end: 1000 },
        canReturnToLive: false, canRestart: false, restartTargetPs: null,
      });
    });
    const { container } = render(<TimelineBar />);
    expect(container.querySelector('.timeline-badge--live')?.textContent).toBe('Recording');
    expect(container.querySelector('.timeline-track')).not.toBeNull();
    expect(container.querySelector('.timeline-thumb')).not.toBeNull();
    const buttons = container.querySelectorAll('.timeline-action');
    expect(Array.from(buttons).some(b => b.textContent === 'Stop & Clear')).toBe(true);
  });

  it('renders review mode with all action buttons', () => {
    act(() => {
      installSubsystem('active');
      useAppStore.getState().updateTimelineState({
        mode: 'review', currentTimePs: 500, reviewTimePs: 500,
        rangePs: { start: 0, end: 1000 },
        canReturnToLive: true, canRestart: true, restartTargetPs: 500,
      });
    });
    const { container } = render(<TimelineBar />);
    expect(container.querySelector('.timeline-badge--review')?.textContent).toBe('Review');
    const buttons = container.querySelectorAll('.timeline-action');
    const labels = Array.from(buttons).map(b => b.textContent);
    expect(labels).toContain('Live');
    expect(labels).toContain('Restart');
    expect(labels).toContain('Stop & Clear');
    expect(container.querySelector('.timeline-restart-target')?.textContent).toBe('Restart at 500.0 ps');
  });

  it('active state with no range yet shows disabled track', () => {
    act(() => { installSubsystem('active'); });
    const { container } = render(<TimelineBar />);
    expect(container.querySelector('.timeline-badge--live')).not.toBeNull();
    expect(container.querySelector('.timeline-track--disabled')).not.toBeNull();
    expect(container.querySelector('.timeline-thumb')).toBeNull();
  });

  // ── Component re-renders on store mode changes ──

  it('renders off, ready, and active states correctly on store mode changes', () => {
    act(() => { installSubsystem('off'); });
    const { container, rerender } = render(<TimelineBar />);
    expect(container.querySelector('.timeline-badge--off')).not.toBeNull();

    act(() => { useAppStore.getState().setTimelineRecordingMode('ready'); });
    rerender(<TimelineBar />);
    expect(container.querySelector('.timeline-badge--ready')).not.toBeNull();

    act(() => {
      useAppStore.getState().setTimelineRecordingMode('active');
      useAppStore.getState().updateTimelineState({
        mode: 'live', currentTimePs: 0.002, reviewTimePs: null,
        rangePs: { start: 0.002, end: 0.002 },
        canReturnToLive: false, canRestart: false, restartTargetPs: null,
      });
    });
    rerender(<TimelineBar />);
    expect(container.querySelector('.timeline-badge--live')).not.toBeNull();
  });

  // ── Button callback tests (use custom spy callbacks) ──

  it('Start Recording button invokes onStartRecordingNow callback', () => {
    const onStart = vi.fn();
    act(() => { installSubsystemWithCallbacks('off', { onStartRecordingNow: onStart }); });
    const { container } = render(<TimelineBar />);
    const startBtn = Array.from(container.querySelectorAll('.timeline-action'))
      .find(b => b.textContent === 'Start Recording') as HTMLButtonElement;
    expect(startBtn).not.toBeUndefined();
    act(() => { startBtn.click(); });
    expect(onStart).toHaveBeenCalledTimes(1);
  });

  it('Stop & Clear button invokes onTurnRecordingOff callback', () => {
    const onTurnOff = vi.fn();
    act(() => {
      installSubsystemWithCallbacks('active', { onTurnRecordingOff: onTurnOff });
      useAppStore.getState().updateTimelineState({
        mode: 'live', currentTimePs: 100, reviewTimePs: null,
        rangePs: { start: 0, end: 200 },
        canReturnToLive: false, canRestart: false, restartTargetPs: null,
      });
    });
    const { container } = render(<TimelineBar />);
    const stopBtn = Array.from(container.querySelectorAll('.timeline-action'))
      .find(b => b.textContent === 'Stop & Clear') as HTMLButtonElement;
    expect(stopBtn).not.toBeUndefined();
    act(() => { stopBtn.click(); });
    expect(onTurnOff).toHaveBeenCalledTimes(1);
  });

  // ── Startup sequence (atomic install) ──

  it('startup: no render before installed, ready immediately after installAndEnable', () => {
    const { container, rerender } = render(<TimelineBar />);
    expect(container.querySelector('.timeline-bar')).toBeNull();

    act(() => { installSubsystem('ready'); });
    rerender(<TimelineBar />);
    expect(container.querySelector('.timeline-badge--ready')).not.toBeNull();
    expect(container.querySelector('.timeline-time')?.textContent).toBe('0.0 fs');
    expect(container.querySelector('.timeline-badge--off')).toBeNull();
  });

  // ── UI state transition tests (callback mutates store, bar re-renders) ──

  it('Start Recording click transitions bar from off to active', () => {
    act(() => {
      installSubsystemWithCallbacks('off', {
        onStartRecordingNow: () => { useAppStore.getState().setTimelineRecordingMode('active'); },
      });
    });
    const { container, rerender } = render(<TimelineBar />);
    expect(container.querySelector('.timeline-badge--off')).not.toBeNull();

    const startBtn = Array.from(container.querySelectorAll('.timeline-action'))
      .find(b => b.textContent === 'Start Recording') as HTMLButtonElement;
    act(() => { startBtn.click(); });
    rerender(<TimelineBar />);
    expect(container.querySelector('.timeline-badge--live')).not.toBeNull();
  });

  it('Stop & Clear click transitions bar from active to off', () => {
    act(() => {
      installSubsystemWithCallbacks('active', {
        onTurnRecordingOff: () => {
          useAppStore.getState().setTimelineRecordingMode('off');
          useAppStore.getState().updateTimelineState({
            mode: 'live', currentTimePs: 0, reviewTimePs: null,
            rangePs: null, canReturnToLive: false, canRestart: false, restartTargetPs: null,
          });
        },
      });
      useAppStore.getState().updateTimelineState({
        mode: 'live', currentTimePs: 100, reviewTimePs: null,
        rangePs: { start: 0, end: 200 },
        canReturnToLive: false, canRestart: false, restartTargetPs: null,
      });
    });
    const { container, rerender } = render(<TimelineBar />);
    expect(container.querySelector('.timeline-badge--live')).not.toBeNull();

    const stopBtn = Array.from(container.querySelectorAll('.timeline-action'))
      .find(b => b.textContent === 'Stop & Clear') as HTMLButtonElement;
    act(() => { stopBtn.click(); });
    rerender(<TimelineBar />);
    expect(container.querySelector('.timeline-badge--off')).not.toBeNull();
    expect(container.querySelector('.timeline-track--disabled')).not.toBeNull();
  });

  // ── Grid lane structure ──

  it('review mode has 2-row layout: row1 (badge+time+track) and row2 (meta+actions)', () => {
    act(() => {
      installSubsystem('active');
      useAppStore.getState().updateTimelineState({
        mode: 'review', currentTimePs: 500, reviewTimePs: 500,
        rangePs: { start: 0, end: 1000 },
        canReturnToLive: true, canRestart: true, restartTargetPs: 400,
      });
    });
    const { container } = render(<TimelineBar />);
    const bar = container.querySelector('.timeline-bar')!;
    // Row 1: grid with badge + time + track (independent of row 2 sizing)
    const row1 = bar.querySelector('.timeline-row1')!;
    expect(row1).not.toBeNull();
    expect(row1.querySelector('.timeline-badge')).not.toBeNull();
    expect(row1.querySelector('.timeline-time')).not.toBeNull();
    expect(row1.querySelector('.timeline-track')).not.toBeNull();
    // Row 2: flex with meta + actions (variable width, doesn't affect track)
    const row2 = bar.querySelector('.timeline-row2')!;
    expect(row2).not.toBeNull();
    expect(row2.querySelector('.timeline-lane-meta')).not.toBeNull();
    expect(row2.querySelector('.timeline-lane-actions')).not.toBeNull();
    expect(row2.querySelector('.timeline-lane-meta .timeline-restart-target')?.textContent).toBe('Restart at 400.0 ps');
  });

  // ── Tooltip hint tests ──

  describe('TimelineActionHint tooltips', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('Start Recording shows hint on hover after delay', () => {
      act(() => { installSubsystem('off'); });
      const { container } = render(<TimelineBar />);
      const anchor = container.querySelector('.timeline-hint-anchor')!;
      act(() => { fireEvent.mouseEnter(anchor); });
      // Not visible before delay
      expect(container.querySelector('.timeline-hint--visible')).toBeNull();
      act(() => { vi.advanceTimersByTime(HINT_DELAY_MS); });
      expect(container.querySelector('.timeline-hint--visible')).not.toBeNull();
      expect(container.querySelector('.timeline-hint--visible')?.textContent).toContain('Start saving timeline history now.');
    });

    it('hint hides on mouse leave', () => {
      act(() => { installSubsystem('off'); });
      const { container } = render(<TimelineBar />);
      const anchor = container.querySelector('.timeline-hint-anchor')!;
      act(() => { fireEvent.mouseEnter(anchor); });
      act(() => { vi.advanceTimersByTime(HINT_DELAY_MS); });
      expect(container.querySelector('.timeline-hint--visible')).not.toBeNull();
      act(() => { fireEvent.mouseLeave(anchor); });
      expect(container.querySelector('.timeline-hint--visible')).toBeNull();
    });

    it('hint appears on focus and hides on blur', () => {
      act(() => { installSubsystem('off'); });
      const { container } = render(<TimelineBar />);
      const anchor = container.querySelector('.timeline-hint-anchor')!;
      act(() => { fireEvent.focus(anchor); });
      act(() => { vi.advanceTimersByTime(HINT_DELAY_MS); });
      expect(container.querySelector('.timeline-hint--visible')).not.toBeNull();
      act(() => { fireEvent.blur(anchor); });
      expect(container.querySelector('.timeline-hint--visible')).toBeNull();
    });

    it('Stop & Clear shows destructive hint on hover', () => {
      act(() => { installSubsystem('ready'); });
      const { container } = render(<TimelineBar />);
      const anchor = container.querySelector('.timeline-hint-anchor')!;
      act(() => { fireEvent.mouseEnter(anchor); });
      act(() => { vi.advanceTimersByTime(HINT_DELAY_MS); });
      expect(container.querySelector('.timeline-hint--visible')?.textContent).toContain('Stop recording and erase all saved history.');
    });

    it('Live shows review-mode hint', () => {
      act(() => {
        installSubsystem('active');
        useAppStore.getState().updateTimelineState({
          mode: 'review', currentTimePs: 500, reviewTimePs: 500,
          rangePs: { start: 0, end: 1000 },
          canReturnToLive: true, canRestart: true, restartTargetPs: 500,
        });
      });
      const { container } = render(<TimelineBar />);
      const anchors = container.querySelectorAll('.timeline-hint-anchor');
      // First anchor in review: Live button
      act(() => { fireEvent.mouseEnter(anchors[0]); });
      act(() => { vi.advanceTimersByTime(HINT_DELAY_MS); });
      expect(anchors[0].querySelector('.timeline-hint--visible')?.textContent).toContain('Jump back to the current simulation.');
    });

    it('Restart shows enabled hint when canRestart is true', () => {
      act(() => {
        installSubsystem('active');
        useAppStore.getState().updateTimelineState({
          mode: 'review', currentTimePs: 500, reviewTimePs: 500,
          rangePs: { start: 0, end: 1000 },
          canReturnToLive: true, canRestart: true, restartTargetPs: 500,
        });
      });
      const { container } = render(<TimelineBar />);
      const anchors = container.querySelectorAll('.timeline-hint-anchor');
      // Second anchor: Restart button
      act(() => { fireEvent.mouseEnter(anchors[1]); });
      act(() => { vi.advanceTimersByTime(HINT_DELAY_MS); });
      expect(anchors[1].querySelector('.timeline-hint--visible')?.textContent).toContain('Restart the simulation from this saved point.');
    });

    it('Restart shows disabled hint when canRestart is false', () => {
      act(() => {
        installSubsystem('active');
        useAppStore.getState().updateTimelineState({
          mode: 'review', currentTimePs: 500, reviewTimePs: 500,
          rangePs: { start: 0, end: 1000 },
          canReturnToLive: true, canRestart: false, restartTargetPs: null,
        });
      });
      const { container } = render(<TimelineBar />);
      const anchors = container.querySelectorAll('.timeline-hint-anchor');
      // Second anchor: Restart button (disabled)
      act(() => { fireEvent.mouseEnter(anchors[1]); });
      act(() => { vi.advanceTimersByTime(HINT_DELAY_MS); });
      expect(anchors[1].querySelector('.timeline-hint--visible')?.textContent).toContain('No restart point is available here.');
    });

    it('disabled Restart wrapper is keyboard-focusable with accessible name', () => {
      act(() => {
        installSubsystem('active');
        useAppStore.getState().updateTimelineState({
          mode: 'review', currentTimePs: 500, reviewTimePs: 500,
          rangePs: { start: 0, end: 1000 },
          canReturnToLive: true, canRestart: false, restartTargetPs: null,
        });
      });
      const { container } = render(<TimelineBar />);
      const anchors = container.querySelectorAll('.timeline-hint-anchor');
      // Restart anchor (second) should have tabIndex=0 when button is disabled
      expect(anchors[1].getAttribute('tabindex')).toBe('0');
      // Should have aria-label so screen readers announce the control name
      expect(anchors[1].getAttribute('aria-label')).toBe('Restart');
      expect(anchors[1].getAttribute('aria-disabled')).toBe('true');
      // Focus the wrapper and verify hint appears
      act(() => { fireEvent.focus(anchors[1]); });
      act(() => { vi.advanceTimersByTime(HINT_DELAY_MS); });
      expect(anchors[1].querySelector('.timeline-hint--visible')?.textContent).toContain('No restart point is available here.');
    });

    it('enabled Restart wrapper does not have tabIndex', () => {
      act(() => {
        installSubsystem('active');
        useAppStore.getState().updateTimelineState({
          mode: 'review', currentTimePs: 500, reviewTimePs: 500,
          rangePs: { start: 0, end: 1000 },
          canReturnToLive: true, canRestart: true, restartTargetPs: 500,
        });
      });
      const { container } = render(<TimelineBar />);
      const anchors = container.querySelectorAll('.timeline-hint-anchor');
      // Restart anchor (second) should NOT have tabIndex when button is enabled
      expect(anchors[1].hasAttribute('tabindex')).toBe(false);
    });

    it('Stop & Clear tooltip uses top-end placement class in ready state', () => {
      act(() => { installSubsystem('ready'); });
      const { container } = render(<TimelineBar />);
      const anchor = container.querySelector('.timeline-hint-anchor')!;
      const hint = anchor.querySelector('.timeline-hint')!;
      expect(hint.classList.contains('timeline-hint--top-end')).toBe(true);
    });

    it('Stop & Clear tooltip uses top-end placement class in active state', () => {
      act(() => {
        installSubsystem('active');
        useAppStore.getState().updateTimelineState({
          mode: 'live', currentTimePs: 100, reviewTimePs: null,
          rangePs: { start: 0, end: 200 },
          canReturnToLive: false, canRestart: false, restartTargetPs: null,
        });
      });
      const { container } = render(<TimelineBar />);
      const anchors = container.querySelectorAll('.timeline-hint-anchor');
      const lastHint = anchors[anchors.length - 1].querySelector('.timeline-hint')!;
      expect(lastHint.classList.contains('timeline-hint--top-end')).toBe(true);
    });
  });
});
