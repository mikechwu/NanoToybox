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
import { render, cleanup, act } from '@testing-library/react';
import { useAppStore } from '../../page/js/store/app-store';
import type { TimelineCallbacks } from '../../page/js/store/app-store';
import { TimelineBar } from '../../page/js/components/TimelineBar';

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
});
