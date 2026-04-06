/**
 * @vitest-environment jsdom
 */
/**
 * Tests for TimelineBar component with 2-column shell layout.
 *
 * All states (off, ready, live, review) render through one shared shell:
 *   - .timeline-shell with __left (mode rail) and __center (timeline lane)
 *   - Mode rail uses vertical segmented control across all states
 *   - Timeline lane: time + track + clear icon (track is dominant)
 *   - Review adds restart chip above thumb; Simulation segment returns to live
 *   - Destructive clear uses compact icon consistently across ready/live/review
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, act, fireEvent } from '@testing-library/react';
import { useAppStore } from '../../lab/js/store/app-store';
import type { TimelineCallbacks } from '../../lab/js/store/app-store';
import { TimelineBar } from '../../lab/js/components/TimelineBar';

const noop = () => {};

const defaultCallbacks: TimelineCallbacks = {
  onScrub: noop, onReturnToLive: noop, onEnterReview: noop,
  onRestartFromHere: noop, onStartRecordingNow: noop, onTurnRecordingOff: noop,
};

function installSubsystem(mode: 'off' | 'ready' | 'active' = 'off') {
  useAppStore.getState().installTimelineUI({ ...defaultCallbacks }, mode);
}

function installSubsystemWithCallbacks(mode: 'off' | 'ready' | 'active', callbacks: Partial<TimelineCallbacks>) {
  useAppStore.getState().installTimelineUI({ ...defaultCallbacks, ...callbacks }, mode);
}

describe('TimelineBar unified shell', () => {
  beforeEach(() => { useAppStore.getState().resetTransientState(); });
  afterEach(() => { cleanup(); });

  // ── Render gate ──

  it('returns null when timeline subsystem is not installed', () => {
    const { container } = render(<TimelineBar />);
    expect(container.querySelector('.timeline-shell')).toBeNull();
  });

  // ── All states use unified shell ──

  it('off state renders simple label, not segmented switch', () => {
    act(() => { installSubsystem('off'); });
    const { container } = render(<TimelineBar />);
    const shell = container.querySelector('.timeline-shell');
    expect(shell).not.toBeNull();
    expect(shell!.querySelector('.timeline-shell__left')).not.toBeNull();
    expect(shell!.querySelector('.timeline-shell__center')).not.toBeNull();
    // Simple label, not segmented control
    expect(container.querySelector('.timeline-mode-label__text')?.textContent).toBe('History Off');
    expect(container.querySelector('.timeline-mode-switch')).toBeNull();
    // Start Recording as center overlay
    expect(container.querySelector('.timeline-start-overlay')?.textContent).toBe('Start Recording');
  });

  it('ready state renders simple label with clear icon', () => {
    act(() => { installSubsystem('ready'); });
    const { container } = render(<TimelineBar />);
    expect(container.querySelector('.timeline-shell')).not.toBeNull();
    // Simple label, not segmented control
    expect(container.querySelector('.timeline-mode-label__text')?.textContent).toBe('Ready');
    expect(container.querySelector('.timeline-mode-switch')).toBeNull();
    // Clear icon
    expect(container.querySelector('.timeline-clear-trigger')).not.toBeNull();
  });

  it('active live state renders two-segment mode switch with Simulation active', () => {
    act(() => {
      installSubsystem('active');
      useAppStore.getState().updateTimelineState({
        mode: 'live', currentTimePs: 500, reviewTimePs: null,
        rangePs: { start: 0, end: 1000 },
        canReturnToLive: false, canRestart: false, restartTargetPs: null,
      });
    });
    const { container } = render(<TimelineBar />);
    expect(container.querySelector('.timeline-shell')).not.toBeNull();
    // Two-segment mode switch: Simulation (active) | Review
    const segs = container.querySelectorAll('.timeline-mode-switch__seg');
    expect(segs.length).toBe(2);
    expect(segs[0].textContent).toBe('Simulation');
    expect(segs[0].classList.contains('timeline-mode-switch__seg--active')).toBe(true);
    expect(segs[1].textContent).toBe('Review');
    // Thick track with thumb
    expect(container.querySelector('.timeline-track--thick')).not.toBeNull();
    expect(container.querySelector('.timeline-thumb')).not.toBeNull();
    // Clear icon (not text button)
    expect(container.querySelector('.timeline-clear-trigger')).not.toBeNull();
  });

  it('review state renders two-segment mode switch with Review active', () => {
    act(() => {
      installSubsystem('active');
      useAppStore.getState().updateTimelineState({
        mode: 'review', currentTimePs: 500, reviewTimePs: 500,
        rangePs: { start: 0, end: 1000 },
        canReturnToLive: true, canRestart: true, restartTargetPs: 500,
      });
    });
    const { container } = render(<TimelineBar />);
    expect(container.querySelector('.timeline-shell')).not.toBeNull();
    // Two-segment mode switch: Simulation | Review (active)
    const segs = container.querySelectorAll('.timeline-mode-switch__seg');
    expect(segs.length).toBe(2);
    expect(segs[0].textContent).toBe('Simulation');
    expect(segs[1].textContent).toBe('Review');
    expect(segs[1].classList.contains('timeline-mode-switch__seg--active')).toBe(true);
    // Simulation segment has return-to-sim accessible label
    expect(segs[0].getAttribute('aria-label')).toBe('Back to simulation');
    // Restart chip (compact label; full time in aria-label)
    expect(container.querySelector('.timeline-restart-anchor')?.textContent).toContain('Restart here');
    // Clear icon (same as live/ready)
    expect(container.querySelector('.timeline-clear-trigger')).not.toBeNull();
  });

  // ── Invariant 2-slot mode rail ──

  it('off/ready use simple label; active uses two-segment switch', () => {
    // Off → label
    act(() => { installSubsystem('off'); });
    let { container } = render(<TimelineBar />);
    expect(container.querySelector('.timeline-mode-label')).not.toBeNull();
    expect(container.querySelector('.timeline-mode-switch')).toBeNull();
    cleanup();

    // Ready → label
    act(() => { installSubsystem('ready'); });
    ({ container } = render(<TimelineBar />));
    expect(container.querySelector('.timeline-mode-label')).not.toBeNull();
    expect(container.querySelector('.timeline-mode-switch')).toBeNull();
    cleanup();

    // Active → two-segment switch
    act(() => {
      installSubsystem('active');
      useAppStore.getState().updateTimelineState({
        mode: 'live', currentTimePs: 100, reviewTimePs: null,
        rangePs: { start: 0, end: 200 },
        canReturnToLive: false, canRestart: false, restartTargetPs: null,
      });
    });
    ({ container } = render(<TimelineBar />));
    expect(container.querySelector('.timeline-mode-switch')).not.toBeNull();
    expect(container.querySelectorAll('.timeline-mode-switch__seg').length).toBe(2);
    expect(container.querySelector('.timeline-mode-label')).toBeNull();
    cleanup();
  });

  // ── No old layout remnants ──

  it('no state uses old row1/row2 layout', () => {
    for (const mode of ['off', 'ready', 'active'] as const) {
      act(() => { installSubsystem(mode); });
      const { container } = render(<TimelineBar />);
      expect(container.querySelector('.timeline-row1')).toBeNull();
      expect(container.querySelector('.timeline-row2')).toBeNull();
      cleanup();
    }
  });

  // ── Thick track across all modes ──

  it('all states use thick track (timeline-track--thick)', () => {
    // Off
    act(() => { installSubsystem('off'); });
    let { container } = render(<TimelineBar />);
    expect(container.querySelector('.timeline-track--thick')).not.toBeNull();
    cleanup();

    // Ready
    act(() => { installSubsystem('ready'); });
    ({ container } = render(<TimelineBar />));
    expect(container.querySelector('.timeline-track--thick')).not.toBeNull();
    cleanup();

    // Active/live
    act(() => {
      installSubsystem('active');
      useAppStore.getState().updateTimelineState({
        mode: 'live', currentTimePs: 100, reviewTimePs: null,
        rangePs: { start: 0, end: 200 },
        canReturnToLive: false, canRestart: false, restartTargetPs: null,
      });
    });
    ({ container } = render(<TimelineBar />));
    expect(container.querySelector('.timeline-track--thick')).not.toBeNull();
    cleanup();

    // Active/review
    act(() => {
      installSubsystem('active');
      useAppStore.getState().updateTimelineState({
        mode: 'review', currentTimePs: 100, reviewTimePs: 100,
        rangePs: { start: 0, end: 200 },
        canReturnToLive: true, canRestart: false, restartTargetPs: null,
      });
    });
    ({ container } = render(<TimelineBar />));
    expect(container.querySelector('.timeline-track--thick')).not.toBeNull();
    cleanup();
  });

  it('ready state has no helper text — label is sufficient', () => {
    act(() => { installSubsystem('ready'); });
    const { container } = render(<TimelineBar />);
    expect(container.querySelector('.timeline-helper')).toBeNull();
    expect(container.querySelector('.timeline-mode-label__text')?.textContent).toBe('Ready');
  });

  // ── Layout contract: time in center, mode switch in left ──

  it('all modes render invariant lane skeleton: time + overlay-zone + track + action-zone', () => {
    for (const mode of ['off', 'ready', 'active'] as const) {
      act(() => { installSubsystem(mode); });
      if (mode === 'active') {
        act(() => {
          useAppStore.getState().updateTimelineState({
            mode: 'live', currentTimePs: 100, reviewTimePs: null,
            rangePs: { start: 0, end: 200 },
            canReturnToLive: false, canRestart: false, restartTargetPs: null,
          });
        });
      }
      const { container } = render(<TimelineBar />);
      const lane = container.querySelector('.timeline-shell__center')!;
      const rail = container.querySelector('.timeline-shell__left')!;
      // Mode rail has content (label or switch)
      expect(rail.children.length).toBeGreaterThan(0);
      // Invariant lane skeleton
      expect(lane.querySelector('.timeline-time')).not.toBeNull();
      expect(lane.querySelector('.timeline-track-zone')).not.toBeNull();
      expect(lane.querySelector('.timeline-overlay-zone')).not.toBeNull();
      expect(lane.querySelector('.timeline-track--thick')).not.toBeNull();
      expect(lane.querySelector('.timeline-action-zone')).not.toBeNull();
      cleanup();
    }
  });

  it('lane structure is identical for short and long time values', () => {
    // Short time (3.0 ps)
    act(() => {
      installSubsystem('active');
      useAppStore.getState().updateTimelineState({
        mode: 'live', currentTimePs: 3, reviewTimePs: null,
        rangePs: { start: 0, end: 100 },
        canReturnToLive: false, canRestart: false, restartTargetPs: null,
      });
    });
    const { container: c1 } = render(<TimelineBar />);
    const lane1 = c1.querySelector('.timeline-shell__center')!;
    const children1 = lane1.children.length;
    cleanup();

    // Long time (12345.67 ps → ns range)
    act(() => {
      installSubsystem('active');
      useAppStore.getState().updateTimelineState({
        mode: 'live', currentTimePs: 12345.67, reviewTimePs: null,
        rangePs: { start: 0, end: 100000 },
        canReturnToLive: false, canRestart: false, restartTargetPs: null,
      });
    });
    const { container: c2 } = render(<TimelineBar />);
    const lane2 = c2.querySelector('.timeline-shell__center')!;
    // Same number of grid children regardless of time string length
    expect(lane2.children.length).toBe(children1);
    // Both have the same structural elements
    expect(lane2.querySelector('.timeline-time')).not.toBeNull();
    expect(lane2.querySelector('.timeline-track-zone')).not.toBeNull();
    expect(lane2.querySelector('.timeline-action-zone')).not.toBeNull();
    cleanup();
  });

  // ── Restart anchor ──

  it('restart anchor absent when canRestart is false', () => {
    act(() => {
      installSubsystem('active');
      useAppStore.getState().updateTimelineState({
        mode: 'review', currentTimePs: 500, reviewTimePs: 500,
        rangePs: { start: 0, end: 1000 },
        canReturnToLive: true, canRestart: false, restartTargetPs: null,
      });
    });
    const { container } = render(<TimelineBar />);
    expect(container.querySelector('.timeline-restart-anchor')).toBeNull();
  });

  it('restart anchor clamps to safe inset at range start (0% progress)', () => {
    act(() => {
      installSubsystem('active');
      useAppStore.getState().updateTimelineState({
        mode: 'review', currentTimePs: 0, reviewTimePs: 0,
        rangePs: { start: 0, end: 1000 },
        canReturnToLive: true, canRestart: true, restartTargetPs: 0,
      });
    });
    const { container } = render(<TimelineBar />);
    const anchor = container.querySelector('.timeline-restart-anchor') as HTMLElement;
    expect(anchor).not.toBeNull();
    // Clamped to 5%, not 0%
    expect(anchor.style.left).toBe('5%');
  });

  it('restart anchor clamps to safe inset at range end (100% progress)', () => {
    act(() => {
      installSubsystem('active');
      useAppStore.getState().updateTimelineState({
        mode: 'review', currentTimePs: 1000, reviewTimePs: 1000,
        rangePs: { start: 0, end: 1000 },
        canReturnToLive: true, canRestart: true, restartTargetPs: 1000,
      });
    });
    const { container } = render(<TimelineBar />);
    const anchor = container.querySelector('.timeline-restart-anchor') as HTMLElement;
    expect(anchor).not.toBeNull();
    // Clamped to 95%, not 100%
    expect(anchor.style.left).toBe('95%');
  });

  // ── Bidirectional mode switch ──

  it('clicking Review in live mode calls onEnterReview', () => {
    const onEnterReview = vi.fn();
    act(() => {
      installSubsystemWithCallbacks('active', { onEnterReview });
      useAppStore.getState().updateTimelineState({
        mode: 'live', currentTimePs: 500, reviewTimePs: null,
        rangePs: { start: 0, end: 1000 },
        canReturnToLive: false, canRestart: false, restartTargetPs: null,
      });
    });
    const { container } = render(<TimelineBar />);
    const segs = container.querySelectorAll('.timeline-mode-switch__seg');
    const reviewSeg = segs[1] as HTMLButtonElement;
    expect(reviewSeg.textContent).toBe('Review');
    expect(reviewSeg.disabled).toBe(false);
    act(() => { reviewSeg.click(); });
    expect(onEnterReview).toHaveBeenCalledTimes(1);
  });

  it('clicking Simulation in review mode calls onReturnToLive', () => {
    const onReturnToLive = vi.fn();
    act(() => {
      installSubsystemWithCallbacks('active', { onReturnToLive });
      useAppStore.getState().updateTimelineState({
        mode: 'review', currentTimePs: 500, reviewTimePs: 500,
        rangePs: { start: 0, end: 1000 },
        canReturnToLive: true, canRestart: false, restartTargetPs: null,
      });
    });
    const { container } = render(<TimelineBar />);
    const segs = container.querySelectorAll('.timeline-mode-switch__seg');
    const simSeg = segs[0] as HTMLButtonElement;
    expect(simSeg.textContent).toBe('Simulation');
    expect(simSeg.disabled).toBe(false);
    act(() => { simSeg.click(); });
    expect(onReturnToLive).toHaveBeenCalledTimes(1);
  });

  it('Review segment disabled in live when no recorded range', () => {
    act(() => {
      installSubsystem('active');
      useAppStore.getState().updateTimelineState({
        mode: 'live', currentTimePs: 0, reviewTimePs: null,
        rangePs: null,
        canReturnToLive: false, canRestart: false, restartTargetPs: null,
      });
    });
    const { container } = render(<TimelineBar />);
    const segs = container.querySelectorAll('.timeline-mode-switch__seg');
    expect((segs[1] as HTMLButtonElement).disabled).toBe(true);
  });

  // ── Callback tests ──

  it('Start Recording button invokes onStartRecordingNow', () => {
    const onStart = vi.fn();
    act(() => { installSubsystemWithCallbacks('off', { onStartRecordingNow: onStart }); });
    const { container } = render(<TimelineBar />);
    const startBtn = container.querySelector('.timeline-action') as HTMLButtonElement;
    act(() => { startBtn.click(); });
    expect(onStart).toHaveBeenCalledTimes(1);
  });

  it('clear icon always opens confirmation dialog before destructive action', () => {
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
    const clearBtn = container.querySelector('.timeline-clear-trigger') as HTMLButtonElement;
    act(() => { clearBtn.click(); });
    // Should NOT fire immediately — confirmation dialog opens first
    expect(onTurnOff).not.toHaveBeenCalled();
    // Dialog should be visible
    expect(document.querySelector('.timeline-clear-dialog')).not.toBeNull();
    expect(document.querySelector('.timeline-clear-backdrop')).not.toBeNull();
    // Confirm fires the destructive action
    const confirmBtn = document.querySelector('.timeline-clear-dialog__confirm') as HTMLButtonElement;
    act(() => { confirmBtn.click(); });
    expect(onTurnOff).toHaveBeenCalledTimes(1);
  });

  it('clear confirmation dialog Cancel does not invoke destructive action', () => {
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
    act(() => { (container.querySelector('.timeline-clear-trigger') as HTMLButtonElement).click(); });
    // Click Cancel
    const cancelBtn = document.querySelector('.timeline-clear-dialog__cancel') as HTMLButtonElement;
    act(() => { cancelBtn.click(); });
    expect(onTurnOff).not.toHaveBeenCalled();
    // Dialog should be dismissed
    expect(document.querySelector('.timeline-clear-dialog')).toBeNull();
  });

  // ── Mode transitions ──

  it('renders off, ready, and active states correctly on store mode changes', () => {
    act(() => { installSubsystem('off'); });
    const { container, rerender } = render(<TimelineBar />);
    expect(container.querySelector('.timeline-mode-label__text')?.textContent).toBe('History Off');

    act(() => { useAppStore.getState().setTimelineRecordingMode('ready'); });
    rerender(<TimelineBar />);
    expect(container.querySelector('.timeline-mode-label__text')?.textContent).toBe('Ready');

    act(() => {
      useAppStore.getState().setTimelineRecordingMode('active');
      useAppStore.getState().updateTimelineState({
        mode: 'live', currentTimePs: 0.002, reviewTimePs: null,
        rangePs: { start: 0.002, end: 0.002 },
        canReturnToLive: false, canRestart: false, restartTargetPs: null,
      });
    });
    rerender(<TimelineBar />);
    expect(container.querySelector('.timeline-mode-switch__seg--active')?.textContent).toBe('Simulation');
  });

  it('startup: no render before installed, ready immediately after installAndEnable', () => {
    const { container, rerender } = render(<TimelineBar />);
    expect(container.querySelector('.timeline-shell')).toBeNull();

    act(() => { installSubsystem('ready'); });
    rerender(<TimelineBar />);
    expect(container.querySelector('.timeline-mode-label__text')?.textContent).toBe('Ready');
  });

  // ── Accessibility ──

  it('review mode Simulation segment has accessible return label', () => {
    act(() => {
      installSubsystem('active');
      useAppStore.getState().updateTimelineState({
        mode: 'review', currentTimePs: 500, reviewTimePs: 500,
        rangePs: { start: 0, end: 1000 },
        canReturnToLive: true, canRestart: true, restartTargetPs: 500,
      });
    });
    const { container } = render(<TimelineBar />);
    const simSeg = container.querySelectorAll('.timeline-mode-switch__seg')[0];
    expect(simSeg?.getAttribute('aria-label')).toBe('Back to simulation');
  });

  it('restart anchor has accessible label with time', () => {
    act(() => {
      installSubsystem('active');
      useAppStore.getState().updateTimelineState({
        mode: 'review', currentTimePs: 500, reviewTimePs: 500,
        rangePs: { start: 0, end: 1000 },
        canReturnToLive: true, canRestart: true, restartTargetPs: 500,
      });
    });
    const { container } = render(<TimelineBar />);
    expect(container.querySelector('.timeline-restart-anchor')?.getAttribute('aria-label')).toContain('Restart simulation at 500.0 ps');
  });

  // ── Time formatting contract ──

  it('formatTime renders correct units across all ranges', () => {
    // Each entry: [inputPs, expectedOutput]
    // Width-fit is enforced by --tl-time-width in CSS; this test protects formatting policy.
    const cases: [number, string][] = [
      [0.0001, '0.1 fs'],    // sub-fs
      [0.5, '500 fs'],       // fs range
      [3.14, '3.14 ps'],     // ps range
      [9999.9, '9999.9 ps'], // upper ps
      [500000, '500.00 ns'], // ns range
      [2000000, '2.00 µs'],  // µs range
    ];
    for (const [inputPs, expected] of cases) {
      act(() => {
        installSubsystem('active');
        useAppStore.getState().updateTimelineState({
          mode: 'live', currentTimePs: inputPs, reviewTimePs: null,
          rangePs: { start: 0, end: inputPs + 1 },
          canReturnToLive: false, canRestart: false, restartTargetPs: null,
        });
      });
      const { container } = render(<TimelineBar />);
      expect(container.querySelector('.timeline-time')?.textContent).toBe(expected);
      cleanup();
    }
  });

  it('clear trigger has accessible label', () => {
    act(() => {
      installSubsystem('active');
      useAppStore.getState().updateTimelineState({
        mode: 'live', currentTimePs: 100, reviewTimePs: null,
        rangePs: { start: 0, end: 200 },
        canReturnToLive: false, canRestart: false, restartTargetPs: null,
      });
    });
    const { container } = render(<TimelineBar />);
    expect(container.querySelector('.timeline-clear-trigger')?.getAttribute('aria-label')).toBe('Stop recording and clear history');
  });
});
