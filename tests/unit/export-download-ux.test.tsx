/**
 * @vitest-environment jsdom
 */
/**
 * Tests for the export download UX refinement:
 *   - formatBytes: B, KB, MB thresholds
 *   - generateExportFileName: prefix + timestamp format
 *   - saveHistoryFile: picker success, picker cancel, anchor fallback
 *   - Dialog estimate slot: three-state rendering
 *   - TimelineBar: pause lifecycle, estimate computation, confirm branching
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, act, fireEvent } from '@testing-library/react';

// Mock the after-paint scheduler so the estimate effect fires
// synchronously under test. Real production code yields a paint via
// rAF + setTimeout; that timing is covered by manual verification.
// MUST be a vi.fn so individual tests can override the implementation.
vi.mock('../../lab/js/components/timeline/timeline-after-paint', () => ({
  scheduleAfterNextPaint: vi.fn((work: () => void) => {
    work();
    return () => {};
  }),
}));

import { scheduleAfterNextPaint } from '../../lab/js/components/timeline/timeline-after-paint';
import { formatBytes, generateExportFileName, saveHistoryFile } from '../../lab/js/runtime/timeline/history-export';
import { useAppStore } from '../../lab/js/store/app-store';
import type { TimelineCallbacks } from '../../lab/js/store/app-store';
import { TimelineBar } from '../../lab/js/components/timeline/TimelineBar';
import { TimelineExportDialog, useExportDialog } from '../../lab/js/components/timeline/timeline-export-dialog';

// Reset the scheduler mock to synchronous default before each test so
// per-case overrides do not leak into the next test.
beforeEach(() => {
  vi.mocked(scheduleAfterNextPaint).mockImplementation((work) => {
    work();
    return () => {};
  });
});

// ── formatBytes ──

describe('formatBytes', () => {
  it('formats bytes below 1 KB', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1023)).toBe('1023 B');
  });

  it('formats kilobytes', () => {
    expect(formatBytes(1024)).toBe('1.0 KB');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(10240)).toBe('10.0 KB');
    expect(formatBytes(1024 * 1024 - 1)).toBe('1024.0 KB');
  });

  it('formats megabytes', () => {
    expect(formatBytes(1024 * 1024)).toBe('1.0 MB');
    expect(formatBytes(1.5 * 1024 * 1024)).toBe('1.5 MB');
    expect(formatBytes(100 * 1024 * 1024)).toBe('100.0 MB');
  });
});

// ── generateExportFileName ──

describe('generateExportFileName', () => {
  it('produces correct prefix and .atomdojo extension', () => {
    const name = generateExportFileName('atomdojo-capsule');
    expect(name).toMatch(/^atomdojo-capsule-\d{8}-\d{6}\.atomdojo$/);
  });

  it('uses different prefix for full', () => {
    const name = generateExportFileName('atomdojo-full');
    expect(name.startsWith('atomdojo-full-')).toBe(true);
  });
});

// ── saveHistoryFile ──

describe('saveHistoryFile', () => {
  afterEach(() => {
    // Restore showSaveFilePicker if overridden
    delete (window as any).showSaveFilePicker;
  });

  it('returns "saved" via anchor fallback when picker is unavailable', async () => {
    // Ensure no picker
    delete (window as any).showSaveFilePicker;

    const blob = new Blob(['test'], { type: 'application/json' });
    const result = await saveHistoryFile(blob, 'test.atomdojo');
    expect(result).toBe('saved');
  });

  it('returns "saved" via picker on success', async () => {
    const mockWritable = { write: vi.fn(), close: vi.fn() };
    const mockHandle = { createWritable: vi.fn().mockResolvedValue(mockWritable) };
    (window as any).showSaveFilePicker = vi.fn().mockResolvedValue(mockHandle);

    const blob = new Blob(['test'], { type: 'application/json' });
    const result = await saveHistoryFile(blob, 'test.atomdojo');
    expect(result).toBe('saved');
    expect(mockWritable.write).toHaveBeenCalledWith(blob);
    expect(mockWritable.close).toHaveBeenCalled();
  });

  it('returns "picker-cancelled" when user cancels the picker', async () => {
    const abortError = new DOMException('The user aborted a request.', 'AbortError');
    (window as any).showSaveFilePicker = vi.fn().mockRejectedValue(abortError);

    const blob = new Blob(['test'], { type: 'application/json' });
    const result = await saveHistoryFile(blob, 'test.atomdojo');
    expect(result).toBe('picker-cancelled');
  });

  it('throws non-AbortError errors from picker', async () => {
    const otherError = new Error('Permission denied');
    (window as any).showSaveFilePicker = vi.fn().mockRejectedValue(otherError);

    const blob = new Blob(['test'], { type: 'application/json' });
    await expect(saveHistoryFile(blob, 'test.atomdojo')).rejects.toThrow('Permission denied');
  });
});

// ── Dialog estimate slot ──

describe('TimelineExportDialog estimate slot', () => {
  afterEach(() => { cleanup(); });

  function renderDialog(overrides: Partial<Parameters<typeof TimelineExportDialog>[0]> = {}) {
    return render(
      <TimelineExportDialog
        open={true}
        availableKinds={{ full: true, capsule: true }}
        kind="capsule"
        submitting={false}
        confirmEnabled={true}
        error={null}
        onSelectKind={() => {}}
        onCancel={() => {}}
        onConfirm={() => {}}
        {...overrides}
      />,
    );
  }

  it('shows "Estimating…" when estimate is undefined', () => {
    renderDialog({ capsuleEstimate: undefined, fullEstimate: undefined });
    const slots = document.querySelectorAll('.timeline-export-dialog__estimate');
    expect(slots.length).toBe(2);
    expect(slots[0].textContent).toBe('Estimating…');
    expect(slots[1].textContent).toBe('Estimating…');
  });

  it('shows formatted size when estimate is a string', () => {
    renderDialog({ capsuleEstimate: '1.2 MB', fullEstimate: '3.4 MB' });
    const slots = document.querySelectorAll('.timeline-export-dialog__estimate');
    expect(slots[0].textContent).toBe('1.2 MB');
    expect(slots[1].textContent).toBe('3.4 MB');
  });

  it('shows "Unavailable" when estimate is null', () => {
    renderDialog({ capsuleEstimate: null, fullEstimate: null });
    const slots = document.querySelectorAll('.timeline-export-dialog__estimate');
    expect(slots[0].textContent).toBe('Unavailable');
    expect(slots[1].textContent).toBe('Unavailable');
  });

  it('muted class on estimating and unavailable states', () => {
    renderDialog({ capsuleEstimate: undefined, fullEstimate: null });
    const slots = document.querySelectorAll('.timeline-export-dialog__estimate');
    expect(slots[0].classList.contains('timeline-export-dialog__estimate--muted')).toBe(true);
    expect(slots[1].classList.contains('timeline-export-dialog__estimate--muted')).toBe(true);
  });

  it('no muted class on resolved estimates', () => {
    renderDialog({ capsuleEstimate: '500 KB', fullEstimate: '2.1 MB' });
    const slots = document.querySelectorAll('.timeline-export-dialog__estimate');
    expect(slots[0].classList.contains('timeline-export-dialog__estimate--muted')).toBe(false);
    expect(slots[1].classList.contains('timeline-export-dialog__estimate--muted')).toBe(false);
  });

  it('does not render estimate slot when kind is unavailable', () => {
    renderDialog({
      availableKinds: { full: false, capsule: true },
      capsuleEstimate: '1.0 MB',
      fullEstimate: '3.0 MB',
    });
    const slots = document.querySelectorAll('.timeline-export-dialog__estimate');
    // Only capsule slot should render
    expect(slots.length).toBe(1);
    expect(slots[0].textContent).toBe('1.0 MB');
  });
});

// ── TimelineBar pause lifecycle ──

const noop = () => {};

function makeCallbacks(overrides: Partial<TimelineCallbacks> = {}): TimelineCallbacks {
  return {
    onScrub: noop,
    onReturnToLive: noop,
    onEnterReview: noop,
    onRestartFromHere: noop,
    onStartRecordingNow: noop,
    onTurnRecordingOff: noop,
    ...overrides,
  };
}

function setupActiveTimeline(callbacks: TimelineCallbacks) {
  useAppStore.getState().installTimelineUI(callbacks, 'active', { full: true, capsule: true });
  useAppStore.getState().updateTimelineState({
    mode: 'live',
    currentTimePs: 500,
    reviewTimePs: null,
    rangePs: { start: 0, end: 1000 },
    canReturnToLive: false,
    canRestart: false,
    restartTargetPs: null,
  });
}

describe('TimelineBar export pause lifecycle', () => {
  beforeEach(() => { useAppStore.getState().resetTransientState(); });
  afterEach(() => { cleanup(); });

  it('pauses simulation when export dialog opens while playing', () => {
    const onPause = vi.fn(() => true);
    const cbs = makeCallbacks({
      onPauseForExport: onPause,
      onExportHistory: vi.fn(async () => 'saved' as const),
    });
    act(() => { setupActiveTimeline(cbs); });
    const { container } = render(<TimelineBar />);

    const trigger = container.querySelector('.timeline-transfer-trigger');
    expect(trigger).not.toBeNull();
    act(() => { fireEvent.click(trigger!); });

    expect(onPause).toHaveBeenCalledTimes(1);
  });

  it('does not pause when already paused', () => {
    const onPause = vi.fn(() => false);
    const cbs = makeCallbacks({
      onPauseForExport: onPause,
      onExportHistory: vi.fn(async () => 'saved' as const),
    });
    act(() => { setupActiveTimeline(cbs); });
    render(<TimelineBar />);

    const trigger = document.querySelector('.timeline-transfer-trigger');
    act(() => { fireEvent.click(trigger!); });

    expect(onPause).toHaveBeenCalledTimes(1);
    // returned false — no resume should happen on cancel
  });

  it('resumes on cancel only if export caused pause', () => {
    const onResume = vi.fn();
    const cbs = makeCallbacks({
      onPauseForExport: () => true,
      onResumeFromExport: onResume,
      onExportHistory: vi.fn(async () => 'saved' as const),
    });
    act(() => { setupActiveTimeline(cbs); });
    render(<TimelineBar />);

    // Open
    act(() => { fireEvent.click(document.querySelector('.timeline-transfer-trigger')!); });
    // Cancel
    act(() => { fireEvent.click(document.querySelector('.timeline-transfer-dialog__cancel')!); });

    expect(onResume).toHaveBeenCalledTimes(1);
  });

  it('does not resume on cancel if export did not cause pause', () => {
    const onResume = vi.fn();
    const cbs = makeCallbacks({
      onPauseForExport: () => false,
      onResumeFromExport: onResume,
      onExportHistory: vi.fn(async () => 'saved' as const),
    });
    act(() => { setupActiveTimeline(cbs); });
    render(<TimelineBar />);

    act(() => { fireEvent.click(document.querySelector('.timeline-transfer-trigger')!); });
    act(() => { fireEvent.click(document.querySelector('.timeline-transfer-dialog__cancel')!); });

    expect(onResume).not.toHaveBeenCalled();
  });

  it('resumes on successful save', async () => {
    const onResume = vi.fn();
    let resolveExport: (v: 'saved' | 'picker-cancelled') => void;
    const exportPromise = new Promise<'saved' | 'picker-cancelled'>((r) => { resolveExport = r; });
    const cbs = makeCallbacks({
      onPauseForExport: () => true,
      onResumeFromExport: onResume,
      onExportHistory: vi.fn(() => exportPromise),
    });
    act(() => { setupActiveTimeline(cbs); });
    render(<TimelineBar />);

    // Open
    act(() => { fireEvent.click(document.querySelector('.timeline-transfer-trigger')!); });
    // Confirm
    act(() => { fireEvent.click(document.querySelector('.timeline-transfer-dialog__confirm')!); });
    // Resolve export
    await act(async () => { resolveExport!('saved'); });

    expect(onResume).toHaveBeenCalledTimes(1);
    // Dialog should be closed
    expect(document.querySelector('.timeline-transfer-dialog')).toBeNull();
  });

  it('keeps dialog open on picker-cancelled, no resume', async () => {
    const onResume = vi.fn();
    let resolveExport: (v: 'saved' | 'picker-cancelled') => void;
    const exportPromise = new Promise<'saved' | 'picker-cancelled'>((r) => { resolveExport = r; });
    const cbs = makeCallbacks({
      onPauseForExport: () => true,
      onResumeFromExport: onResume,
      onExportHistory: vi.fn(() => exportPromise),
    });
    act(() => { setupActiveTimeline(cbs); });
    render(<TimelineBar />);

    act(() => { fireEvent.click(document.querySelector('.timeline-transfer-trigger')!); });
    act(() => { fireEvent.click(document.querySelector('.timeline-transfer-dialog__confirm')!); });
    await act(async () => { resolveExport!('picker-cancelled'); });

    expect(onResume).not.toHaveBeenCalled();
    // Dialog should remain open
    expect(document.querySelector('.timeline-transfer-dialog')).not.toBeNull();
  });

  it('keeps dialog open on error, no resume', async () => {
    const onResume = vi.fn();
    const cbs = makeCallbacks({
      onPauseForExport: () => true,
      onResumeFromExport: onResume,
      onExportHistory: vi.fn(async () => { throw new Error('Export failed'); }),
    });
    act(() => { setupActiveTimeline(cbs); });
    render(<TimelineBar />);

    act(() => { fireEvent.click(document.querySelector('.timeline-transfer-trigger')!); });
    await act(async () => { fireEvent.click(document.querySelector('.timeline-transfer-dialog__confirm')!); });

    expect(onResume).not.toHaveBeenCalled();
    expect(document.querySelector('.timeline-transfer-dialog')).not.toBeNull();
    expect(document.querySelector('.timeline-transfer-dialog__error')?.textContent).toBe('Export failed');
  });

  it('resumes when capability loss closes the dialog', () => {
    const onResume = vi.fn();
    const cbs = makeCallbacks({
      onPauseForExport: () => true,
      onResumeFromExport: onResume,
      onExportHistory: vi.fn(async () => 'saved' as const),
    });
    act(() => { setupActiveTimeline(cbs); });
    render(<TimelineBar />);

    // Open
    act(() => { fireEvent.click(document.querySelector('.timeline-transfer-trigger')!); });
    expect(document.querySelector('.timeline-transfer-dialog')).not.toBeNull();

    // Simulate capability loss
    act(() => {
      useAppStore.getState().setTimelineExportCapabilities(null);
    });

    expect(onResume).toHaveBeenCalledTimes(1);
  });

  it('computes and displays estimates after dialog opens', async () => {
    // Invariant: NO onPublishCapsule — dialog opens directly to
    // Download. If a future refactor adds a default publish callback
    // and flips this to Share-default, the Download-panel precondition
    // assertion below will fail first with a clear signal instead of
    // the estimate assertions failing for a misleading reason.
    const cbs = makeCallbacks({
      onPauseForExport: () => true,
      onResumeFromExport: noop,
      onExportHistory: vi.fn(async () => 'saved' as const),
      getExportEstimates: () => ({ capsule: '256 KB', full: '1.2 MB' }),
    });
    act(() => { setupActiveTimeline(cbs); });
    render(<TimelineBar />);

    // Open
    act(() => { fireEvent.click(document.querySelector('.timeline-transfer-trigger')!); });

    // Precondition: dialog opened on Download (no publish available).
    expect(document.querySelector('[role="tabpanel"][aria-label="Download"]')).not.toBeNull();

    // Mocked scheduler fires work synchronously, so estimates should
    // already be populated — the muted (Estimating…) state is
    // covered by the Download-only render-before-compute test in
    // timeline-bar-lifecycle.test.tsx (which overrides the mock to
    // capture without firing).
    const slots = document.querySelectorAll('.timeline-transfer-dialog__estimate');
    const texts = Array.from(slots).map((s) => s.textContent);
    expect(texts).toContain('256 KB');
    expect(texts).toContain('1.2 MB');
  });

  it('estimates clear on dialog close', async () => {
    // Invariant: Download-only setup (see sibling test for rationale).
    const cbs = makeCallbacks({
      onPauseForExport: () => true,
      onResumeFromExport: noop,
      onExportHistory: vi.fn(async () => 'saved' as const),
      getExportEstimates: () => ({ capsule: '100 KB', full: '500 KB' }),
    });
    act(() => { setupActiveTimeline(cbs); });
    render(<TimelineBar />);

    // Open and let estimates populate (scheduler mock fires synchronously).
    act(() => { fireEvent.click(document.querySelector('.timeline-transfer-trigger')!); });
    expect(document.querySelector('[role="tabpanel"][aria-label="Download"]')).not.toBeNull();
    expect(document.querySelectorAll('.timeline-transfer-dialog__estimate').length).toBeGreaterThan(0);

    // Cancel
    act(() => { fireEvent.click(document.querySelector('.timeline-transfer-dialog__cancel')!); });
    expect(document.querySelector('.timeline-transfer-dialog')).toBeNull();
  });

  it('resumes on component unmount if export caused pause', () => {
    const onResume = vi.fn();
    const cbs = makeCallbacks({
      onPauseForExport: () => true,
      onResumeFromExport: onResume,
      onExportHistory: vi.fn(async () => 'saved' as const),
    });
    act(() => { setupActiveTimeline(cbs); });
    const { unmount } = render(<TimelineBar />);

    // Open export dialog (causes pause)
    act(() => { fireEvent.click(document.querySelector('.timeline-transfer-trigger')!); });
    expect(document.querySelector('.timeline-transfer-dialog')).not.toBeNull();

    // Unmount while dialog is open
    unmount();
    expect(onResume).toHaveBeenCalledTimes(1);
  });

  it('shows "Unavailable" when getExportEstimates returns null for a kind', async () => {
    // Invariant: Download-only setup (no onPublishCapsule).
    const cbs = makeCallbacks({
      onPauseForExport: () => true,
      onResumeFromExport: noop,
      onExportHistory: vi.fn(async () => 'saved' as const),
      getExportEstimates: () => ({ capsule: null, full: null }),
    });
    act(() => { setupActiveTimeline(cbs); });
    render(<TimelineBar />);

    act(() => { fireEvent.click(document.querySelector('.timeline-transfer-trigger')!); });
    expect(document.querySelector('[role="tabpanel"][aria-label="Download"]')).not.toBeNull();

    const slots = document.querySelectorAll('.timeline-transfer-dialog__estimate');
    const texts = Array.from(slots).map((s) => s.textContent);
    expect(texts).toContain('Unavailable');
    expect(texts.every((t) => t === 'Unavailable')).toBe(true);
  });

  it('unmount resume uses latest callbacks even when installed after mount', () => {
    // Mount with no timeline callbacks installed
    act(() => { useAppStore.getState().resetTransientState(); });
    const { unmount, rerender } = render(<TimelineBar />);

    // Now install callbacks (simulates subsystem wiring after mount)
    const onResume = vi.fn();
    const cbs = makeCallbacks({
      onPauseForExport: () => true,
      onResumeFromExport: onResume,
      onExportHistory: vi.fn(async () => 'saved' as const),
    });
    act(() => { setupActiveTimeline(cbs); });
    rerender(<TimelineBar />);

    // Open export dialog
    act(() => { fireEvent.click(document.querySelector('.timeline-transfer-trigger')!); });
    expect(document.querySelector('.timeline-transfer-dialog')).not.toBeNull();

    // Unmount — should call the latest onResumeFromExport, not the stale null
    unmount();
    expect(onResume).toHaveBeenCalledTimes(1);
  });

  it('shows "Unavailable" when getExportEstimates throws', async () => {
    // Invariant: Download-only setup (no onPublishCapsule). The try/catch
    // in the estimate effect catches the throw synchronously under the
    // mocked scheduler and falls back to { capsule: null, full: null },
    // which EstimateSlot renders as "Unavailable".
    const cbs = makeCallbacks({
      onPauseForExport: () => true,
      onResumeFromExport: noop,
      onExportHistory: vi.fn(async () => 'saved' as const),
      getExportEstimates: () => { throw new Error('builder crashed'); },
    });
    act(() => { setupActiveTimeline(cbs); });
    render(<TimelineBar />);

    act(() => { fireEvent.click(document.querySelector('.timeline-transfer-trigger')!); });
    expect(document.querySelector('[role="tabpanel"][aria-label="Download"]')).not.toBeNull();

    const slots = document.querySelectorAll('.timeline-transfer-dialog__estimate');
    const texts = Array.from(slots).map((s) => s.textContent);
    expect(texts).toContain('Unavailable');
    expect(texts.every((t) => t === 'Unavailable')).toBe(true);
  });
});
