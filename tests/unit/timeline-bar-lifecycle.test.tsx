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
import { HINT_DELAY_MS } from '../../lab/js/components/ActionHint';

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

// jsdom has no ResizeObserver. TimelineBar's width-aware restart clamp
// instantiates one in a layout effect, so we install a global no-op stub
// for this file. Individual tests can replace it to capture callbacks.
beforeEach(() => {
  if (!(globalThis as any).ResizeObserver) {
    (globalThis as any).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
});

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
    expect(container.querySelector('.timeline-start-anchor')?.textContent).toContain('Start Recording');
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
    expect(container.querySelector('.timeline-restart-button')?.getAttribute('aria-label')).toContain('Restart simulation at 500.0 ps');
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

  // ── Hint tooltip visibility (hover + timer) ──
  // ActionHint shows tooltip after HINT_DELAY_MS on mouseEnter, hides on mouseLeave.
  // Touch/coarse-pointer devices hide hints via CSS (by design — desktop only).

  it('start recording hint becomes visible on hover after delay', () => {
    vi.useFakeTimers();
    act(() => { installSubsystem('off'); });
    const { container } = render(<TimelineBar />);
    const anchor = container.querySelector('.timeline-start-anchor')! as HTMLElement;
    const tooltip = anchor.querySelector('[role="tooltip"]')!;
    // Initially hidden
    expect(tooltip.classList.contains('timeline-hint--visible')).toBe(false);
    // Hover
    act(() => { fireEvent.mouseEnter(anchor); });
    act(() => { vi.advanceTimersByTime(HINT_DELAY_MS); });
    expect(tooltip.classList.contains('timeline-hint--visible')).toBe(true);
    expect(tooltip.textContent).toContain('Start saving timeline history now.');
    // Leave hides
    act(() => { fireEvent.mouseLeave(anchor); });
    expect(tooltip.classList.contains('timeline-hint--visible')).toBe(false);
    vi.useRealTimers();
  });

  it('simulation segment hint visible on hover in review mode', () => {
    vi.useFakeTimers();
    act(() => {
      installSubsystem('active');
      useAppStore.getState().updateTimelineState({
        mode: 'review', currentTimePs: 500, reviewTimePs: 500,
        rangePs: { start: 0, end: 1000 },
        canReturnToLive: true, canRestart: false, restartTargetPs: null,
      });
    });
    const { container } = render(<TimelineBar />);
    const anchor = container.querySelectorAll('.timeline-mode-switch__seg')[0]!.closest('.timeline-hint-anchor')! as HTMLElement;
    const tooltip = anchor.querySelector('[role="tooltip"]')!;
    act(() => { fireEvent.mouseEnter(anchor); });
    act(() => { vi.advanceTimersByTime(HINT_DELAY_MS); });
    expect(tooltip.classList.contains('timeline-hint--visible')).toBe(true);
    expect(tooltip.textContent).toContain('Back to the current simulation.');
    vi.useRealTimers();
  });

  it('review segment hint visible on hover in live mode with range', () => {
    vi.useFakeTimers();
    act(() => {
      installSubsystem('active');
      useAppStore.getState().updateTimelineState({
        mode: 'live', currentTimePs: 500, reviewTimePs: null,
        rangePs: { start: 0, end: 1000 },
        canReturnToLive: false, canRestart: false, restartTargetPs: null,
      });
    });
    const { container } = render(<TimelineBar />);
    const anchor = container.querySelectorAll('.timeline-mode-switch__seg')[1]!.closest('.timeline-hint-anchor')! as HTMLElement;
    const tooltip = anchor.querySelector('[role="tooltip"]')!;
    act(() => { fireEvent.mouseEnter(anchor); });
    act(() => { vi.advanceTimersByTime(HINT_DELAY_MS); });
    expect(tooltip.classList.contains('timeline-hint--visible')).toBe(true);
    expect(tooltip.textContent).toContain('Enter review mode at the current time.');
    vi.useRealTimers();
  });

  it('disabled review segment hint visible on focus when no range', () => {
    vi.useFakeTimers();
    act(() => {
      installSubsystem('active');
      useAppStore.getState().updateTimelineState({
        mode: 'live', currentTimePs: 0, reviewTimePs: null,
        rangePs: null,
        canReturnToLive: false, canRestart: false, restartTargetPs: null,
      });
    });
    const { container } = render(<TimelineBar />);
    // focusableWhenDisabled wrapper is the timeline-hint-anchor
    const anchors = container.querySelectorAll('.timeline-hint-anchor');
    const disabledAnchor = Array.from(anchors).find(a => {
      const tip = a.querySelector('[role="tooltip"]');
      return tip?.textContent?.includes('No recorded history');
    })! as HTMLElement;
    expect(disabledAnchor).not.toBeUndefined();
    const tooltip = disabledAnchor.querySelector('[role="tooltip"]')!;
    // Focus the wrapper (focusableWhenDisabled gives it tabIndex=0)
    act(() => { fireEvent.focus(disabledAnchor); });
    act(() => { vi.advanceTimersByTime(HINT_DELAY_MS); });
    expect(tooltip.classList.contains('timeline-hint--visible')).toBe(true);
    vi.useRealTimers();
  });

  it('restart anchor hint visible on hover', () => {
    vi.useFakeTimers();
    act(() => {
      installSubsystem('active');
      useAppStore.getState().updateTimelineState({
        mode: 'review', currentTimePs: 500, reviewTimePs: 500,
        rangePs: { start: 0, end: 1000 },
        canReturnToLive: true, canRestart: true, restartTargetPs: 500,
      });
    });
    const { container } = render(<TimelineBar />);
    const anchor = container.querySelector('.timeline-restart-anchor')! as HTMLElement;
    const tooltip = anchor.querySelector('[role="tooltip"]')!;
    act(() => { fireEvent.mouseEnter(anchor); });
    act(() => { vi.advanceTimersByTime(HINT_DELAY_MS); });
    expect(tooltip.classList.contains('timeline-hint--visible')).toBe(true);
    expect(tooltip.textContent).toContain('Restart the simulation from this point.');
    act(() => { fireEvent.mouseLeave(anchor); });
    expect(tooltip.classList.contains('timeline-hint--visible')).toBe(false);
    vi.useRealTimers();
  });

  it('clear trigger hint visible on hover', () => {
    vi.useFakeTimers();
    act(() => {
      installSubsystem('active');
      useAppStore.getState().updateTimelineState({
        mode: 'live', currentTimePs: 100, reviewTimePs: null,
        rangePs: { start: 0, end: 200 },
        canReturnToLive: false, canRestart: false, restartTargetPs: null,
      });
    });
    const { container } = render(<TimelineBar />);
    const anchor = container.querySelector('.timeline-clear-trigger')!.closest('.timeline-hint-anchor')! as HTMLElement;
    const tooltip = anchor.querySelector('[role="tooltip"]')!;
    act(() => { fireEvent.mouseEnter(anchor); });
    act(() => { vi.advanceTimersByTime(HINT_DELAY_MS); });
    expect(tooltip.classList.contains('timeline-hint--visible')).toBe(true);
    expect(tooltip.textContent).toContain('Stop recording and clear timeline history.');
    vi.useRealTimers();
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

  // ── Export UI ──

  function installWithExport(mode: 'off' | 'ready' | 'active' = 'active', caps: { full: boolean; capsule: boolean } = { full: true, capsule: true }) {
    useAppStore.getState().installTimelineUI(
      { ...defaultCallbacks, onExportHistory: vi.fn(async () => 'saved' as const) },
      mode,
      caps,
    );
  }

  it('export trigger renders when showExport is true', () => {
    act(() => {
      installWithExport('active');
      useAppStore.getState().updateTimelineState({
        mode: 'live', currentTimePs: 100, reviewTimePs: null,
        rangePs: { start: 0, end: 200 },
        canReturnToLive: false, canRestart: false, restartTargetPs: null,
      });
    });
    const { container } = render(<TimelineBar />);
    expect(container.querySelector('.timeline-transfer-trigger')).not.toBeNull();
  });

  it('export trigger hidden when capability is null', () => {
    act(() => {
      installSubsystem('active');
      useAppStore.getState().updateTimelineState({
        mode: 'live', currentTimePs: 100, reviewTimePs: null,
        rangePs: { start: 0, end: 200 },
        canReturnToLive: false, canRestart: false, restartTargetPs: null,
      });
    });
    const { container } = render(<TimelineBar />);
    expect(container.querySelector('.timeline-transfer-trigger')).toBeNull();
  });

  it('export trigger hidden when callback exists but capability is null', () => {
    act(() => {
      installSubsystemWithCallbacks('active', { onExportHistory: vi.fn(async () => 'saved' as const) });
      // Do NOT set capabilities
      useAppStore.getState().updateTimelineState({
        mode: 'live', currentTimePs: 100, reviewTimePs: null,
        rangePs: { start: 0, end: 200 },
        canReturnToLive: false, canRestart: false, restartTargetPs: null,
      });
    });
    const { container } = render(<TimelineBar />);
    expect(container.querySelector('.timeline-transfer-trigger')).toBeNull();
  });

  it('export trigger hidden in off state', () => {
    act(() => { installWithExport('off'); });
    const { container } = render(<TimelineBar />);
    expect(container.querySelector('.timeline-transfer-trigger')).toBeNull();
  });

  it('export trigger hidden in ready state', () => {
    act(() => { installWithExport('ready'); });
    const { container } = render(<TimelineBar />);
    expect(container.querySelector('.timeline-transfer-trigger')).toBeNull();
  });

  it('clear trigger present alongside export trigger', () => {
    act(() => {
      installWithExport('active');
      useAppStore.getState().updateTimelineState({
        mode: 'live', currentTimePs: 100, reviewTimePs: null,
        rangePs: { start: 0, end: 200 },
        canReturnToLive: false, canRestart: false, restartTargetPs: null,
      });
    });
    const { container } = render(<TimelineBar />);
    expect(container.querySelector('.timeline-transfer-trigger')).not.toBeNull();
    expect(container.querySelector('.timeline-clear-trigger')).not.toBeNull();
  });

  it('action zone has export and clear slots in all states', () => {
    for (const mode of ['off', 'ready', 'active'] as const) {
      act(() => { installWithExport(mode); });
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
      expect(container.querySelector('.timeline-action-slot--transfer')).not.toBeNull();
      expect(container.querySelector('.timeline-action-slot--clear')).not.toBeNull();
      cleanup();
    }
  });

  it('export trigger opens export dialog', () => {
    act(() => {
      installWithExport('active');
      useAppStore.getState().updateTimelineState({
        mode: 'live', currentTimePs: 100, reviewTimePs: null,
        rangePs: { start: 0, end: 200 },
        canReturnToLive: false, canRestart: false, restartTargetPs: null,
      });
    });
    const { container } = render(<TimelineBar />);
    act(() => { (container.querySelector('.timeline-transfer-trigger') as HTMLButtonElement).click(); });
    expect(document.querySelector('.timeline-transfer-dialog')).not.toBeNull();
  });

  it('export dialog defaults to capsule when both available', () => {
    act(() => {
      installWithExport('active');
      useAppStore.getState().updateTimelineState({
        mode: 'live', currentTimePs: 100, reviewTimePs: null,
        rangePs: { start: 0, end: 200 },
        canReturnToLive: false, canRestart: false, restartTargetPs: null,
      });
    });
    const { container } = render(<TimelineBar />);
    act(() => { (container.querySelector('.timeline-transfer-trigger') as HTMLButtonElement).click(); });
    const capsuleRadio = document.querySelector('input[value="capsule"]') as HTMLInputElement;
    expect(capsuleRadio.checked).toBe(true);
  });

  it('export dialog disables unavailable kinds', () => {
    act(() => {
      installWithExport('active', { full: false, capsule: true });
      useAppStore.getState().updateTimelineState({
        mode: 'live', currentTimePs: 100, reviewTimePs: null,
        rangePs: { start: 0, end: 200 },
        canReturnToLive: false, canRestart: false, restartTargetPs: null,
      });
    });
    const { container } = render(<TimelineBar />);
    act(() => { (container.querySelector('.timeline-transfer-trigger') as HTMLButtonElement).click(); });
    const fullRadio = document.querySelector('input[value="full"]') as HTMLInputElement;
    expect(fullRadio.disabled).toBe(true);
  });

  it('confirm export calls onExportHistory with selected kind', () => {
    const onExport = vi.fn();
    act(() => {
      useAppStore.getState().installTimelineUI(
        { ...defaultCallbacks, onExportHistory: onExport },
        'active',
        { full: true, capsule: true },
      );
      useAppStore.getState().updateTimelineState({
        mode: 'live', currentTimePs: 100, reviewTimePs: null,
        rangePs: { start: 0, end: 200 },
        canReturnToLive: false, canRestart: false, restartTargetPs: null,
      });
    });
    const { container } = render(<TimelineBar />);
    act(() => { (container.querySelector('.timeline-transfer-trigger') as HTMLButtonElement).click(); });
    const confirmBtn = document.querySelector('.timeline-transfer-dialog__confirm') as HTMLButtonElement;
    act(() => { confirmBtn.click(); });
    expect(onExport).toHaveBeenCalledWith('capsule');
  });

  it('opening export closes clear dialog', () => {
    act(() => {
      installWithExport('active');
      useAppStore.getState().updateTimelineState({
        mode: 'live', currentTimePs: 100, reviewTimePs: null,
        rangePs: { start: 0, end: 200 },
        canReturnToLive: false, canRestart: false, restartTargetPs: null,
      });
    });
    const { container } = render(<TimelineBar />);
    // Open clear dialog first
    act(() => { (container.querySelector('.timeline-clear-trigger') as HTMLButtonElement).click(); });
    expect(document.querySelector('.timeline-clear-dialog')).not.toBeNull();
    // Now open export — clear should close
    act(() => { (container.querySelector('.timeline-transfer-trigger') as HTMLButtonElement).click(); });
    expect(document.querySelector('.timeline-clear-dialog')).toBeNull();
    expect(document.querySelector('.timeline-transfer-dialog')).not.toBeNull();
  });

  it('opening clear closes export dialog', () => {
    act(() => {
      installWithExport('active');
      useAppStore.getState().updateTimelineState({
        mode: 'live', currentTimePs: 100, reviewTimePs: null,
        rangePs: { start: 0, end: 200 },
        canReturnToLive: false, canRestart: false, restartTargetPs: null,
      });
    });
    const { container } = render(<TimelineBar />);
    // Open export dialog first
    act(() => { (container.querySelector('.timeline-transfer-trigger') as HTMLButtonElement).click(); });
    expect(document.querySelector('.timeline-transfer-dialog')).not.toBeNull();
    // Now open clear — export should close
    act(() => { (container.querySelector('.timeline-clear-trigger') as HTMLButtonElement).click(); });
    expect(document.querySelector('.timeline-transfer-dialog')).toBeNull();
    expect(document.querySelector('.timeline-clear-dialog')).not.toBeNull();
  });

  it('hidden export spacer is aria-hidden and not focusable', () => {
    act(() => {
      installSubsystem('active');
      useAppStore.getState().updateTimelineState({
        mode: 'live', currentTimePs: 100, reviewTimePs: null,
        rangePs: { start: 0, end: 200 },
        canReturnToLive: false, canRestart: false, restartTargetPs: null,
      });
    });
    const { container } = render(<TimelineBar />);
    const shareSlot = container.querySelector('.timeline-action-slot--transfer');
    const spacer = shareSlot?.querySelector('.timeline-action-spacer');
    expect(spacer).not.toBeNull();
    expect(spacer!.getAttribute('aria-hidden')).toBe('true');
    expect(spacer!.getAttribute('tabindex')).toBeNull();
  });

  it('transfer trigger tooltip visible on hover after delay', () => {
    vi.useFakeTimers();
    act(() => {
      installWithExport('active');
      useAppStore.getState().updateTimelineState({
        mode: 'live', currentTimePs: 100, reviewTimePs: null,
        rangePs: { start: 0, end: 200 },
        canReturnToLive: false, canRestart: false, restartTargetPs: null,
      });
    });
    const { container } = render(<TimelineBar />);
    const anchor = container.querySelector('.timeline-transfer-trigger')!.closest('.timeline-hint-anchor')! as HTMLElement;
    const tooltip = anchor.querySelector('[role="tooltip"]')!;
    act(() => { fireEvent.mouseEnter(anchor); });
    act(() => { vi.advanceTimersByTime(HINT_DELAY_MS); });
    expect(tooltip.classList.contains('timeline-hint--visible')).toBe(true);
    expect(tooltip.textContent).toContain('Transfer history');
    vi.useRealTimers();
  });

  it('export dialog renders via portal to document.body, not inside timeline', () => {
    act(() => {
      installWithExport('active');
      useAppStore.getState().updateTimelineState({
        mode: 'live', currentTimePs: 100, reviewTimePs: null,
        rangePs: { start: 0, end: 200 },
        canReturnToLive: false, canRestart: false, restartTargetPs: null,
      });
    });
    const { container } = render(<TimelineBar />);
    act(() => { (container.querySelector('.timeline-transfer-trigger') as HTMLButtonElement).click(); });
    // Dialog should be in document.body, not inside the timeline container
    expect(document.body.querySelector('.timeline-transfer-dialog')).not.toBeNull();
    expect(document.body.querySelector('.timeline-dialog-backdrop')).not.toBeNull();
    // The timeline container itself should NOT contain the dialog
    expect(container.querySelector('.timeline-transfer-dialog')).toBeNull();
    expect(container.querySelector('.timeline-dialog-backdrop')).toBeNull();
  });

  // ── Export dynamic lifecycle ──

  it('export dialog closes when capability is removed', () => {
    act(() => {
      installWithExport('active');
      useAppStore.getState().updateTimelineState({
        mode: 'live', currentTimePs: 100, reviewTimePs: null,
        rangePs: { start: 0, end: 200 },
        canReturnToLive: false, canRestart: false, restartTargetPs: null,
      });
    });
    const { container } = render(<TimelineBar />);
    // Open export dialog
    act(() => { (container.querySelector('.timeline-transfer-trigger') as HTMLButtonElement).click(); });
    expect(document.querySelector('.timeline-transfer-dialog')).not.toBeNull();
    // Remove capability
    act(() => { useAppStore.getState().setTimelineExportCapabilities(null); });
    expect(document.querySelector('.timeline-transfer-dialog')).toBeNull();
  });

  it('selected full falls back to capsule when full becomes unavailable', () => {
    act(() => {
      installWithExport('active', { full: true, capsule: true });
      useAppStore.getState().updateTimelineState({
        mode: 'live', currentTimePs: 100, reviewTimePs: null,
        rangePs: { start: 0, end: 200 },
        canReturnToLive: false, canRestart: false, restartTargetPs: null,
      });
    });
    const { container } = render(<TimelineBar />);
    act(() => { (container.querySelector('.timeline-transfer-trigger') as HTMLButtonElement).click(); });
    // Select full
    const fullRadio = document.querySelector('input[value="full"]') as HTMLInputElement;
    act(() => { fireEvent.click(fullRadio); });
    expect(fullRadio.checked).toBe(true);
    // Remove full capability
    act(() => { useAppStore.getState().setTimelineExportCapabilities({ full: false, capsule: true }); });
    // Should fall back to capsule
    const capsuleRadio = document.querySelector('input[value="capsule"]') as HTMLInputElement;
    expect(capsuleRadio.checked).toBe(true);
  });

  it('publishTimelineOffState clears capability atomically', () => {
    act(() => {
      installWithExport('active');
      useAppStore.getState().updateTimelineState({
        mode: 'live', currentTimePs: 100, reviewTimePs: null,
        rangePs: { start: 0, end: 200 },
        canReturnToLive: false, canRestart: false, restartTargetPs: null,
      });
    });
    expect(useAppStore.getState().timelineExportCapabilities).not.toBeNull();
    act(() => { useAppStore.getState().publishTimelineOffState(); });
    expect(useAppStore.getState().timelineExportCapabilities).toBeNull();
    expect(useAppStore.getState().timelineRecordingMode).toBe('off');
  });

  it('transfer trigger hidden when caps exist but neither callback is wired', () => {
    // Under the action-availability contract, stored capabilities alone are
    // not enough — the corresponding callback must also be wired. If neither
    // onExportHistory nor onPublishCapsule is provided, the transfer trigger
    // must not render at all (the old "disabled confirm inside an empty
    // dialog" UX is gone, because the dialog can no longer open).
    act(() => {
      useAppStore.getState().installTimelineUI(defaultCallbacks, 'active', { full: true, capsule: true });
      useAppStore.getState().updateTimelineState({
        mode: 'live', currentTimePs: 100, reviewTimePs: null,
        rangePs: { start: 0, end: 200 },
        canReturnToLive: false, canRestart: false, restartTargetPs: null,
      });
    });
    const { container } = render(<TimelineBar />);
    expect(container.querySelector('.timeline-transfer-trigger')).toBeNull();
  });

  it('export trigger reappears after stop → restart recording cycle', () => {
    // Regression: user stops recording, starts again — export button must come back
    const { container, rerender } = render(<TimelineBar />);

    // 1. Install with export capability + create range so export is visible
    act(() => {
      installWithExport('active');
      useAppStore.getState().updateTimelineState({
        mode: 'live', currentTimePs: 100, reviewTimePs: null,
        rangePs: { start: 0, end: 200 },
        canReturnToLive: false, canRestart: false, restartTargetPs: null,
      });
    });
    rerender(<TimelineBar />);
    expect(container.querySelector('.timeline-transfer-trigger')).not.toBeNull();

    // 2. Simulate stop/off — publishTimelineOffState clears capability + range
    act(() => {
      useAppStore.getState().publishTimelineOffState();
    });
    rerender(<TimelineBar />);
    expect(container.querySelector('.timeline-transfer-trigger')).toBeNull();

    // 3. Simulate start recording again — restore mode + capability + range
    act(() => {
      useAppStore.getState().setTimelineRecordingMode('active');
      useAppStore.getState().setTimelineExportCapabilities({ full: true, capsule: true });
      useAppStore.getState().updateTimelineState({
        mode: 'live', currentTimePs: 50, reviewTimePs: null,
        rangePs: { start: 0, end: 100 },
        canReturnToLive: false, canRestart: false, restartTargetPs: null,
      });
    });
    rerender(<TimelineBar />);
    expect(container.querySelector('.timeline-transfer-trigger')).not.toBeNull();
  });

  it('uninstallTimelineUI clears export capability atomically', () => {
    act(() => {
      installWithExport('active');
      useAppStore.getState().updateTimelineState({
        mode: 'live', currentTimePs: 100, reviewTimePs: null,
        rangePs: { start: 0, end: 200 },
        canReturnToLive: false, canRestart: false, restartTargetPs: null,
      });
    });
    expect(useAppStore.getState().timelineExportCapabilities).not.toBeNull();
    act(() => { useAppStore.getState().uninstallTimelineUI(); });
    expect(useAppStore.getState().timelineExportCapabilities).toBeNull();
    expect(useAppStore.getState().timelineInstalled).toBe(false);
  });

  // ── Publish UI ──

  function installWithPublish(opts: {
    mode?: 'off' | 'ready' | 'active';
    caps?: { full: boolean; capsule: boolean };
    onPublish?: () => Promise<{ shareCode: string; shareUrl: string }>;
    onPause?: () => boolean;
    onResume?: () => void;
  } = {}) {
    const mode = opts.mode ?? 'active';
    const onPublish = opts.onPublish ?? vi.fn(async () => ({ shareCode: 'ABC123DEF456', shareUrl: 'https://atomdojo.pages.dev/c/ABC123DEF456' }));
    const onPause = opts.onPause ?? vi.fn(() => true);
    const onResume = opts.onResume ?? vi.fn();
    useAppStore.getState().installTimelineUI(
      {
        ...defaultCallbacks,
        onExportHistory: vi.fn(async () => 'saved' as const),
        onPublishCapsule: onPublish,
        onPauseForExport: onPause,
        onResumeFromExport: onResume,
      },
      mode,
      opts.caps ?? { full: true, capsule: true },
    );
  }

  function setActiveRange() {
    useAppStore.getState().updateTimelineState({
      mode: 'live', currentTimePs: 100, reviewTimePs: null,
      rangePs: { start: 0, end: 200 },
      canReturnToLive: false, canRestart: false, restartTargetPs: null,
    });
  }

  it('publish trigger visible when onPublishCapsule and range exist', () => {
    act(() => { installWithPublish(); setActiveRange(); });
    const { container } = render(<TimelineBar />);
    expect(container.querySelector('.timeline-transfer-trigger')).not.toBeNull();
  });

  it('transfer trigger still visible when only export is provided (no publish)', () => {
    // Under the unified transfer model, the trigger shows when either
    // export OR publish is available. When only export is provided,
    // clicking the trigger opens the Download tab only.
    act(() => {
      installWithExport('active');
      setActiveRange();
    });
    const { container } = render(<TimelineBar />);
    expect(container.querySelector('.timeline-transfer-trigger')).not.toBeNull();
  });

  it('transfer trigger hidden when no range exists', () => {
    act(() => { installWithPublish(); });
    // No setActiveRange — rangePs stays null
    const { container } = render(<TimelineBar />);
    expect(container.querySelector('.timeline-transfer-trigger')).toBeNull();
  });

  it('clicking publish trigger opens publish dialog and pauses', () => {
    const onPause = vi.fn(() => true);
    act(() => { installWithPublish({ onPause }); setActiveRange(); });
    render(<TimelineBar />);

    act(() => { (document.querySelector('.timeline-transfer-trigger') as HTMLButtonElement).click(); });
    expect(document.querySelector('.timeline-transfer-dialog')).not.toBeNull();
    expect(onPause).toHaveBeenCalled();
  });

  // Helper: transfer dialog defaults to Download tab; switch to Share tab.
  function switchToShareTab() {
    const shareTab = Array.from(
      document.querySelectorAll('.timeline-transfer-dialog__tab'),
    ).find((el) => el.textContent?.trim() === 'Share') as HTMLButtonElement | undefined;
    if (shareTab) act(() => { shareTab.click(); });
  }

  it('successful publish shows share URL and code', async () => {
    const onPublish = vi.fn(async () => ({
      shareCode: 'TEST12345678',
      shareUrl: 'https://atomdojo.pages.dev/c/TEST12345678',
    }));
    act(() => { installWithPublish({ onPublish }); setActiveRange(); });
    render(<TimelineBar />);

    // Open dialog (defaults to Download tab)
    act(() => { (document.querySelector('.timeline-transfer-trigger') as HTMLButtonElement).click(); });
    // Switch to Share tab
    switchToShareTab();

    // Click Publish confirm
    const confirmBtn = document.querySelector('.timeline-transfer-dialog__confirm') as HTMLButtonElement;
    await act(async () => { confirmBtn.click(); });

    // Should show success state with URL
    const urlInput = document.querySelector('.timeline-transfer-dialog__url-input') as HTMLInputElement;
    expect(urlInput).not.toBeNull();
    expect(urlInput.value).toBe('https://atomdojo.pages.dev/c/TEST12345678');

    // Should show share code
    expect(document.querySelector('.timeline-transfer-dialog__code')?.textContent).toContain('TEST12345678');

    // No warnings in the response → no warning note rendered
    expect(document.querySelector('[data-testid="transfer-dialog-warning"]')).toBeNull();
  });

  it('successful publish with warnings surfaces a subtle note (non-blocking)', async () => {
    // Server returned 201 with warnings: ['quota_accounting_failed'].
    // The share URL must still render (primary surface), plus a low-
    // emphasis note so operators/support can see the reconciliation
    // signal without confusing normal users.
    const onPublish = vi.fn(async () => ({
      shareCode: 'WARN12345678',
      shareUrl: 'https://atomdojo.pages.dev/c/WARN12345678',
      warnings: ['quota_accounting_failed'],
    }));
    act(() => { installWithPublish({ onPublish }); setActiveRange(); });
    render(<TimelineBar />);

    act(() => { (document.querySelector('.timeline-transfer-trigger') as HTMLButtonElement).click(); });
    switchToShareTab();

    const confirmBtn = document.querySelector('.timeline-transfer-dialog__confirm') as HTMLButtonElement;
    await act(async () => { confirmBtn.click(); });

    // Share URL is still primary — must remain visible and usable.
    const urlInput = document.querySelector('.timeline-transfer-dialog__url-input') as HTMLInputElement;
    expect(urlInput.value).toBe('https://atomdojo.pages.dev/c/WARN12345678');

    // Warning note is present with the operator-facing copy.
    const warning = document.querySelector('[data-testid="transfer-dialog-warning"]');
    expect(warning).not.toBeNull();
    expect(warning?.textContent).toContain('operator review');

    // Accessibility: polite live region so it doesn't interrupt anything.
    expect(warning?.getAttribute('role')).toBe('status');
    expect(warning?.getAttribute('aria-live')).toBe('polite');
  });

  it('unknown warning code still renders a note with the code visible', async () => {
    const onPublish = vi.fn(async () => ({
      shareCode: 'UNKN12345678',
      shareUrl: 'https://atomdojo.pages.dev/c/UNKN12345678',
      warnings: ['some_future_warning'],
    }));
    act(() => { installWithPublish({ onPublish }); setActiveRange(); });
    render(<TimelineBar />);

    act(() => { (document.querySelector('.timeline-transfer-trigger') as HTMLButtonElement).click(); });
    switchToShareTab();
    const confirmBtn = document.querySelector('.timeline-transfer-dialog__confirm') as HTMLButtonElement;
    await act(async () => { confirmBtn.click(); });

    const warning = document.querySelector('[data-testid="transfer-dialog-warning"]');
    expect(warning).not.toBeNull();
    expect(warning?.textContent).toContain('some_future_warning');
  });

  it('cancel/close resumes simulation when publish caused pause', () => {
    const onResume = vi.fn();
    act(() => { installWithPublish({ onResume }); setActiveRange(); });
    render(<TimelineBar />);

    // Open dialog (which pauses)
    act(() => { (document.querySelector('.timeline-transfer-trigger') as HTMLButtonElement).click(); });
    expect(document.querySelector('.timeline-transfer-dialog')).not.toBeNull();

    // Click Cancel
    act(() => { (document.querySelector('.timeline-transfer-dialog__cancel') as HTMLButtonElement).click(); });
    expect(document.querySelector('.timeline-transfer-dialog')).toBeNull();
    expect(onResume).toHaveBeenCalled();
  });

  it('cancel does not resume if pause was not needed', () => {
    const onPause = vi.fn(() => false); // already paused
    const onResume = vi.fn();
    act(() => { installWithPublish({ onPause, onResume }); setActiveRange(); });
    render(<TimelineBar />);

    act(() => { (document.querySelector('.timeline-transfer-trigger') as HTMLButtonElement).click(); });
    act(() => { (document.querySelector('.timeline-transfer-dialog__cancel') as HTMLButtonElement).click(); });
    expect(onResume).not.toHaveBeenCalled();
  });

  it('publish failure keeps dialog open and shows inline error', async () => {
    const onPublish = vi.fn(async () => { throw new Error('Auth required'); });
    act(() => { installWithPublish({ onPublish }); setActiveRange(); });
    render(<TimelineBar />);

    act(() => { (document.querySelector('.timeline-transfer-trigger') as HTMLButtonElement).click(); });
    switchToShareTab();

    const confirmBtn = document.querySelector('.timeline-transfer-dialog__confirm') as HTMLButtonElement;
    await act(async () => { confirmBtn.click(); });

    // Dialog still open
    expect(document.querySelector('.timeline-transfer-dialog')).not.toBeNull();
    // Error shown
    expect(document.querySelector('.timeline-transfer-dialog__error')?.textContent).toContain('Auth required');
    // Confirm button re-enabled (not stuck in submitting state)
    expect(confirmBtn.disabled).toBe(false);
  });

  it('unmount while publish dialog is open resumes simulation', () => {
    const onResume = vi.fn();
    act(() => { installWithPublish({ onResume }); setActiveRange(); });
    const { unmount } = render(<TimelineBar />);

    // Open dialog (pauses)
    act(() => { (document.querySelector('.timeline-transfer-trigger') as HTMLButtonElement).click(); });
    expect(document.querySelector('.timeline-transfer-dialog')).not.toBeNull();

    // Unmount while dialog is open
    unmount();
    expect(onResume).toHaveBeenCalled();
  });

  // ── Transfer dialog busy-guard ──

  it('in-flight share disables tab switching and cancel', async () => {
    // Return a promise that we control — share stays "in flight" until we resolve.
    let resolveShare: (v: { shareCode: string; shareUrl: string }) => void;
    const sharePromise = new Promise<{ shareCode: string; shareUrl: string }>((r) => { resolveShare = r; });
    const onPublish = vi.fn(() => sharePromise);

    act(() => { installWithPublish({ onPublish }); setActiveRange(); });
    render(<TimelineBar />);

    act(() => { (document.querySelector('.timeline-transfer-trigger') as HTMLButtonElement).click(); });
    switchToShareTab();

    // Start share — stays in flight
    const confirmBtn = document.querySelector('.timeline-transfer-dialog__confirm') as HTMLButtonElement;
    act(() => { confirmBtn.click(); });

    // While busy: both tabs, cancel, and inactive confirm must be disabled
    const tabs = document.querySelectorAll('.timeline-transfer-dialog__tab');
    const cancelBtn = document.querySelector('.timeline-transfer-dialog__cancel') as HTMLButtonElement;
    expect(cancelBtn.disabled).toBe(true);
    // The inactive (Download) tab is disabled; the active (Share) tab stays enabled so focus-trap works
    const inactiveTab = Array.from(tabs).find(t => t.getAttribute('aria-selected') === 'false') as HTMLButtonElement;
    expect(inactiveTab.disabled).toBe(true);

    // Aria-busy is set on the dialog
    const dialog = document.querySelector('.timeline-transfer-dialog') as HTMLElement;
    expect(dialog.getAttribute('aria-busy')).toBe('true');

    // Resolve so the component unmounts cleanly
    await act(async () => { resolveShare!({ shareCode: 'OK0000000000', shareUrl: 'https://x/c/OK0000000000' }); });
  });

  it('in-flight share ignores Escape so the flow cannot be hidden', async () => {
    let resolveShare: (v: { shareCode: string; shareUrl: string }) => void;
    const sharePromise = new Promise<{ shareCode: string; shareUrl: string }>((r) => { resolveShare = r; });
    const onPublish = vi.fn(() => sharePromise);

    act(() => { installWithPublish({ onPublish }); setActiveRange(); });
    render(<TimelineBar />);

    act(() => { (document.querySelector('.timeline-transfer-trigger') as HTMLButtonElement).click(); });
    switchToShareTab();

    // Start share
    const confirmBtn = document.querySelector('.timeline-transfer-dialog__confirm') as HTMLButtonElement;
    act(() => { confirmBtn.click(); });

    // Press Escape — should be suppressed while busy
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(document.querySelector('.timeline-transfer-dialog')).not.toBeNull();

    await act(async () => { resolveShare!({ shareCode: 'OK0000000000', shareUrl: 'https://x/c/OK0000000000' }); });
  });

  it('tab bar is hidden when only one destination is available (share only)', () => {
    // Install publish callback but NO export callback — Share is the only tab.
    act(() => {
      useAppStore.getState().installTimelineUI(
        {
          ...defaultCallbacks,
          onPublishCapsule: vi.fn(async () => ({ shareCode: 'AB1234567890', shareUrl: 'https://x/c/AB1234567890' })),
          onPauseForExport: vi.fn(() => true),
          onResumeFromExport: vi.fn(),
        },
        'active',
        // No export capabilities
      );
      setActiveRange();
    });
    render(<TimelineBar />);

    act(() => { (document.querySelector('.timeline-transfer-trigger') as HTMLButtonElement).click(); });

    // Tab bar should be hidden — only one destination available
    expect(document.querySelector('.timeline-transfer-dialog__tabs')).toBeNull();
    // Share panel should be the one rendered
    expect(document.querySelector('[role="tabpanel"][aria-label="Share"]')).not.toBeNull();
  });

  it('tab bar is hidden when only download is available (no publish callback)', () => {
    act(() => {
      installWithExport('active');
      setActiveRange();
    });
    render(<TimelineBar />);

    act(() => { (document.querySelector('.timeline-transfer-trigger') as HTMLButtonElement).click(); });

    expect(document.querySelector('.timeline-transfer-dialog__tabs')).toBeNull();
    expect(document.querySelector('[role="tabpanel"][aria-label="Download"]')).not.toBeNull();
  });

  it('tab bar shows both tabs when both destinations are available', () => {
    act(() => { installWithPublish(); setActiveRange(); });
    render(<TimelineBar />);

    act(() => { (document.querySelector('.timeline-transfer-trigger') as HTMLButtonElement).click(); });

    const tabs = document.querySelectorAll('.timeline-transfer-dialog__tab');
    expect(tabs.length).toBe(2);
  });

  // Regression: stored export capability must NOT make Download "available"
  // unless the onExportHistory callback is also wired. This covers the
  // callback-wiring transition window where caps are installed before the
  // handler, and prevents a dead Download tab from rendering.
  it('caps present but onExportHistory missing → transfer opens to Share only, no Download tab', () => {
    const onPublish = vi.fn(async () => ({
      shareCode: 'CAPONLY00000',
      shareUrl: 'https://atomdojo.pages.dev/c/CAPONLY00000',
    }));
    act(() => {
      // Install export capability but NO onExportHistory callback. Publish is wired.
      useAppStore.getState().installTimelineUI(
        {
          ...defaultCallbacks,
          // onExportHistory intentionally omitted
          onPublishCapsule: onPublish,
          onPauseForExport: vi.fn(() => true),
          onResumeFromExport: vi.fn(),
        },
        'active',
        { full: true, capsule: true }, // caps present
      );
      setActiveRange();
    });
    const { container } = render(<TimelineBar />);

    // Trigger still visible — share makes transfer useful
    expect(container.querySelector('.timeline-transfer-trigger')).not.toBeNull();

    // Open dialog
    act(() => { (document.querySelector('.timeline-transfer-trigger') as HTMLButtonElement).click(); });

    // Tab bar should be hidden (only one destination is actually actionable)
    expect(document.querySelector('.timeline-transfer-dialog__tabs')).toBeNull();
    // The Share panel should be the one rendered
    expect(document.querySelector('[role="tabpanel"][aria-label="Share"]')).not.toBeNull();
    // No Download panel — the dead tab must not render
    expect(document.querySelector('[role="tabpanel"][aria-label="Download"]')).toBeNull();
    // And no per-kind radio options exist (they belong to the Download panel)
    expect(document.querySelector('.timeline-transfer-dialog__options')).toBeNull();
  });

  // Regression: estimate computation must be gated on Download being
  // actionable. In Share-only flows the artifact build + stringify cost
  // should not run at all — the estimate effect is for the Download panel
  // which is not rendered.
  it('getExportEstimates is NOT called when only Share is actionable', async () => {
    const getExportEstimates = vi.fn(() => ({ capsule: '100 KB', full: '1 MB' }));
    const onPublish = vi.fn(async () => ({
      shareCode: 'SHAREONLY111',
      shareUrl: 'https://atomdojo.pages.dev/c/SHAREONLY111',
    }));
    act(() => {
      useAppStore.getState().installTimelineUI(
        {
          ...defaultCallbacks,
          // onExportHistory intentionally omitted — Download is not actionable
          onPublishCapsule: onPublish,
          onPauseForExport: vi.fn(() => true),
          onResumeFromExport: vi.fn(),
          getExportEstimates, // wired but must not be invoked
        },
        'active',
        { full: true, capsule: true }, // caps present to tempt the old logic
      );
      setActiveRange();
    });
    render(<TimelineBar />);

    // Open the transfer dialog — Share-only flow
    act(() => { (document.querySelector('.timeline-transfer-trigger') as HTMLButtonElement).click(); });
    // Let the microtask queue drain
    await act(async () => { await Promise.resolve(); });

    // The estimate function must never have been invoked in this flow.
    expect(getExportEstimates).not.toHaveBeenCalled();
  });

  it('getExportEstimates IS called when Download is actionable', async () => {
    const getExportEstimates = vi.fn(() => ({ capsule: '100 KB', full: '1 MB' }));
    act(() => {
      installWithPublish({}); // provides both onExportHistory and onPublishCapsule
      // Overwrite the callbacks to add the estimate spy
      useAppStore.getState().installTimelineUI(
        {
          ...defaultCallbacks,
          onExportHistory: vi.fn(async () => 'saved' as const),
          onPublishCapsule: vi.fn(async () => ({ shareCode: 'X', shareUrl: 'https://x/c/X' })),
          onPauseForExport: vi.fn(() => true),
          onResumeFromExport: vi.fn(),
          getExportEstimates,
        },
        'active',
        { full: true, capsule: true },
      );
      setActiveRange();
    });
    render(<TimelineBar />);

    act(() => { (document.querySelector('.timeline-transfer-trigger') as HTMLButtonElement).click(); });
    await act(async () => { await Promise.resolve(); });

    expect(getExportEstimates).toHaveBeenCalledTimes(1);
  });

  // ── Restart anchor layout regression ──
  //
  // Guards against the collision where the restart-here overlay extends past
  // the track-zone boundary (into the action-zone sibling) when the target
  // is near the right edge. The fix is a width-aware pixel clamp to
  // [halfBtn, trackWidth - halfBtn].

  // Helper: stub jsdom layout APIs so TimelineBar's restart-anchor clamp can
  // measure overlay/button widths. Returns a cleanup function.
  function withMockedLayout(overlayWidth: number, buttonWidth: number): () => void {
    const originalClientWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth');
    const originalOffsetWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth');
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
      configurable: true,
      get(this: HTMLElement) {
        if (this.classList.contains('timeline-overlay-zone')) return overlayWidth;
        return 0;
      },
    });
    Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
      configurable: true,
      get(this: HTMLElement) {
        if (this.classList.contains('timeline-restart-button')) return buttonWidth;
        return 0;
      },
    });
    return () => {
      if (originalClientWidth) Object.defineProperty(HTMLElement.prototype, 'clientWidth', originalClientWidth);
      else delete (HTMLElement.prototype as any).clientWidth;
      if (originalOffsetWidth) Object.defineProperty(HTMLElement.prototype, 'offsetWidth', originalOffsetWidth);
      else delete (HTMLElement.prototype as any).offsetWidth;
    };
  }

  it('restart anchor clamps to trackWidth - halfBtn when target near right edge', () => {
    // Overlay 600px, button 120px, target at 95% → center at 570,
    // right edge would reach 630 (overflow). Clamp center to 540.
    const cleanup = withMockedLayout(600, 120);
    try {
      act(() => {
        installWithPublish();
        useAppStore.getState().updateTimelineState({
          mode: 'review', currentTimePs: 950, reviewTimePs: 950,
          rangePs: { start: 0, end: 1000 },
          canReturnToLive: true, canRestart: true, restartTargetPs: 950,
        });
      });

      const { container } = render(<TimelineBar />);
      const anchor = container.querySelector('.timeline-restart-anchor') as HTMLElement | null;
      expect(anchor).not.toBeNull();

      const left = anchor!.style.left;
      expect(left).toMatch(/px$/);
      const leftPx = parseFloat(left);
      // 0.95 * 600 = 570 → clamp to trackWidth - halfBtn = 540
      expect(leftPx).toBe(540);
      // Button edges stay inside the track:
      //   left edge: 540 - 60 = 480 (>= 0) ✓
      //   right edge: 540 + 60 = 600 (<= 600) ✓
    } finally {
      cleanup();
    }
  });

  it('restart anchor clamps to halfBtn when target near left edge', () => {
    const cleanup = withMockedLayout(600, 120);
    try {
      act(() => {
        installWithPublish();
        useAppStore.getState().updateTimelineState({
          mode: 'review', currentTimePs: 10, reviewTimePs: 10,
          rangePs: { start: 0, end: 1000 },
          canReturnToLive: true, canRestart: true, restartTargetPs: 10,
        });
      });

      const { container } = render(<TimelineBar />);
      const anchor = container.querySelector('.timeline-restart-anchor') as HTMLElement | null;
      expect(anchor).not.toBeNull();

      const leftPx = parseFloat(anchor!.style.left);
      // 0.01 * 600 = 6, below halfBtn=60 → clamp to 60
      expect(leftPx).toBe(60);
    } finally {
      cleanup();
    }
  });

  it('restart anchor pins to center when button wider than track (pathological)', () => {
    const cleanup = withMockedLayout(100, 150);
    try {
      act(() => {
        installWithPublish();
        useAppStore.getState().updateTimelineState({
          mode: 'review', currentTimePs: 500, reviewTimePs: 500,
          rangePs: { start: 0, end: 1000 },
          canReturnToLive: true, canRestart: true, restartTargetPs: 500,
        });
      });

      const { container } = render(<TimelineBar />);
      const anchor = container.querySelector('.timeline-restart-anchor') as HTMLElement | null;
      // Pins to center of track: 100 / 2 = 50
      expect(parseFloat(anchor!.style.left)).toBe(50);
    } finally {
      cleanup();
    }
  });
});
