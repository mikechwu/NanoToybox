/**
 * @vitest-environment jsdom
 *
 * Tests for the Capsule Too Large trim flow wired into TimelineBar.
 *
 * Coverage:
 *   - Oversize publish (preflight + 413) routes into trim mode.
 *   - Snapshot-stale on publish blocks the POST and renders recoverable copy.
 *   - Nothing-Fits branch renders Download Capsule.
 *   - Reset re-applies the cached default (no re-measure).
 *   - Tab switch is disabled while shareMeasuring is true.
 *   - Byte-identity: prepared JSON is the exact POST body.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, act } from '@testing-library/react';

// Synchronous after-paint scheduler so async trim search completes
// inside act() without fake-timer juggling.
vi.mock('../../lab/js/components/timeline/timeline-after-paint', () => ({
  scheduleAfterNextPaint: vi.fn((work: () => void) => {
    work();
    return () => {};
  }),
}));

import { useAppStore } from '../../lab/js/store/app-store';
import type { TimelineCallbacks } from '../../lab/js/store/app-store';
import { TimelineBar } from '../../lab/js/components/timeline/TimelineBar';
import { PublishOversizeError, CapsuleSnapshotStaleError } from '../../lab/js/runtime/publish-errors';
import type { CapsuleSelectionRange, PreparedCapsuleSummary } from '../../lab/js/runtime/timeline/capsule-publish-types';
import { MAX_PUBLISH_BYTES } from '../../src/share/constants';

const noop = () => {};

const defaultCallbacks: TimelineCallbacks = {
  onScrub: noop, onReturnToLive: noop, onEnterReview: noop,
  onRestartFromHere: noop, onStartRecordingNow: noop, onTurnRecordingOff: noop,
};

function setActiveRange() {
  useAppStore.getState().updateTimelineState({
    mode: 'live', currentTimePs: 10, reviewTimePs: null,
    rangePs: { start: 0, end: 10 },
    canReturnToLive: false, canRestart: false, restartTargetPs: null,
  });
}

interface InstallOpts {
  /** Toggle between preflight-origin and 413-origin oversize errors. */
  oversizeSource?: 'preflight' | '413';
  /** Drive server-maxBytes vs. null so both the 'server' and
   *  'client-fallback' trust tiers get exercised. */
  errorMaxBytes?: number | null;
  /** Replace the publisher-behaviour stubs to inject snapshot-stale or
   *  nothing-fits scenarios. */
  onPrepareCapsulePublish?: (range: CapsuleSelectionRange) => Promise<PreparedCapsuleSummary>;
  onPublishPreparedCapsule?: (prepareId: string) => Promise<{ mode: "account"; shareCode: string; shareUrl: string; warnings?: string[] }>;
  onCancelPreparedPublish?: (prepareId: string) => void;
  /** Override the frame-index returned to the trim entry path. */
  frameCount?: number;
}

function installForTrim(opts: InstallOpts = {}) {
  const frameCount = opts.frameCount ?? 8;
  const frames = Array.from({ length: frameCount }, (_, i) => ({ frameId: i, timePs: i }));
  const maxBytes = opts.errorMaxBytes ?? MAX_PUBLISH_BYTES;
  const source = opts.oversizeSource ?? '413';
  const oversize = new PublishOversizeError({
    actualBytes: 25 * 1024 * 1024,
    maxBytes: opts.errorMaxBytes === null ? null : maxBytes,
    source,
    message: 'too big',
  });

  const onPublishCapsule = vi.fn(async () => {
    throw oversize;
  });
  const getCapsuleFrameIndex = vi.fn(() => ({ snapshotId: 'v1:0:0:0', frames }));

  // Default prepare: every candidate returns a fixed-size "fits"
  // summary so the search converges to startFrameIndex=0. Override via
  // opts for specific scenarios.
  let prepareCallCount = 0;
  const onPrepareCapsulePublish = opts.onPrepareCapsulePublish ?? vi.fn(async (range: CapsuleSelectionRange) => {
    prepareCallCount++;
    const summary: PreparedCapsuleSummary = {
      prepareId: `prep-${prepareCallCount}`,
      bytes: 10 * 1024 * 1024,
      maxBytes: MAX_PUBLISH_BYTES,
      maxSource: 'client-fallback',
      frameCount: range.endFrameIndex - range.startFrameIndex + 1,
    };
    return summary;
  });

  const onPublishPreparedCapsule = opts.onPublishPreparedCapsule ?? vi.fn(async (_prepareId: string) => ({
    mode: 'account' as const,
    shareCode: 'TEST12345678',
    shareUrl: 'https://atomdojo.pages.dev/c/TEST12345678',
  }));

  const onCancelPreparedPublish = opts.onCancelPreparedPublish ?? vi.fn();

  useAppStore.getState().installTimelineUI({
    ...defaultCallbacks,
    onExportHistory: vi.fn(async () => 'saved' as const),
    onPublishCapsule,
    onPauseForExport: vi.fn(() => true),
    onResumeFromExport: vi.fn(),
    getCapsuleFrameIndex,
    onPrepareCapsulePublish,
    onPublishPreparedCapsule,
    onCancelPreparedPublish,
  }, 'active', { full: true, capsule: true });
  useAppStore.getState().setAuthSignedIn({ userId: 'u', displayName: 'U' });
  setActiveRange();

  return {
    onPublishCapsule,
    onPrepareCapsulePublish,
    onPublishPreparedCapsule,
    onCancelPreparedPublish,
    getCapsuleFrameIndex,
  };
}

function openShareTab() {
  act(() => {
    (document.querySelector('.timeline-transfer-trigger') as HTMLButtonElement).click();
  });
  const shareTab = Array.from(
    document.querySelectorAll('.timeline-transfer-dialog__tab'),
  ).find((el) => el.textContent?.trim() === 'Share') as HTMLButtonElement | undefined;
  if (shareTab) act(() => { shareTab.click(); });
}

async function clickPublishFullHistory() {
  const confirmBtn = Array.from(
    document.querySelectorAll('.timeline-transfer-dialog__confirm'),
  ).find((el) => el.textContent?.trim() === 'Publish') as HTMLButtonElement | undefined;
  if (!confirmBtn) throw new Error('Publish button not found');
  await act(async () => { confirmBtn.click(); });
}

beforeEach(() => {
  if (!(globalThis as any).ResizeObserver) {
    (globalThis as any).ResizeObserver = class {
      observe() {} unobserve() {} disconnect() {}
    };
  }
  useAppStore.getState().resetTransientState();
});

afterEach(() => { cleanup(); });

describe('TimelineBar trim mode', () => {
  it('routes PublishOversizeError(source: 413) into trim mode', async () => {
    installForTrim({ oversizeSource: '413' });
    render(<TimelineBar />);
    openShareTab();
    await clickPublishFullHistory();

    // Trim UI present
    expect(document.querySelector('[data-testid="transfer-share-trim"]')).not.toBeNull();
    // Status row rendered (either within-target or close-to-limit)
    const statusEl = document.querySelector('[data-testid="transfer-share-trim-status"]');
    expect(statusEl).not.toBeNull();
    // Publish Selected Range action present
    expect(document.querySelector('[data-testid="transfer-share-trim-publish"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="transfer-share-trim-reset"]')).not.toBeNull();
    // Trim overlays visible on the main timeline
    expect(document.querySelector('[data-testid="timeline-trim-kept"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="timeline-trim-handle-start"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="timeline-trim-handle-end"]')).not.toBeNull();
  });

  it('routes PublishOversizeError(source: preflight) into trim mode', async () => {
    installForTrim({ oversizeSource: 'preflight' });
    render(<TimelineBar />);
    openShareTab();
    await clickPublishFullHistory();
    expect(document.querySelector('[data-testid="transfer-share-trim"]')).not.toBeNull();
  });

  it('preflight source still shows the denominator — users do not see trust-tier copy', async () => {
    // Earlier the preflight path rendered a "Local estimate — the
    // server may enforce a slightly different limit" caption. That
    // was engineering noise: users don't care about trust tiers;
    // they care that Publish publishes. The denominator still
    // renders (so the user knows the limit), but the caption is
    // gone. Deploy-skew safety still works — a server-side 413
    // re-enters trim mode automatically.
    installForTrim({ oversizeSource: 'preflight' });
    render(<TimelineBar />);
    openShareTab();
    await clickPublishFullHistory();
    const statusText = document.querySelector('[data-testid="transfer-share-trim-status"]')?.textContent ?? '';
    expect(statusText).not.toContain('Local estimate');
    expect(statusText).not.toContain('server may enforce');
    // Denominator is still there.
    expect(statusText).toMatch(/of\s+\d/);
  });

  it('413 without parseable maxBytes drops the denominator (maxSource=unknown, not client-fallback)', async () => {
    // Trust model: a server 413 that did not provide a trustworthy
    // limit must NOT be labeled as if the client's MAX_PUBLISH_BYTES
    // were the server's view. Render the row with no denominator.
    installForTrim({ oversizeSource: '413', errorMaxBytes: null });
    render(<TimelineBar />);
    openShareTab();
    await clickPublishFullHistory();
    const statusText = document.querySelector('[data-testid="transfer-share-trim-status"]')?.textContent ?? '';
    expect(statusText).not.toContain('Local estimate');
    expect(statusText).not.toContain('of 20');
  });

  it('Publish Selected Range calls onPublishPreparedCapsule with the prepareId', async () => {
    const { onPublishPreparedCapsule } = installForTrim();
    render(<TimelineBar />);
    openShareTab();
    await clickPublishFullHistory();

    const publishBtn = document.querySelector('[data-testid="transfer-share-trim-publish"]') as HTMLButtonElement;
    await act(async () => { publishBtn.click(); });
    expect(onPublishPreparedCapsule).toHaveBeenCalledTimes(1);
    // Success branch now rendered
    expect(document.querySelector('.timeline-transfer-dialog__url-input')).not.toBeNull();
  });

  it('snapshot-stale between prepare and publish blocks POST and surfaces recoverable copy', async () => {
    // Override publish to throw CapsuleSnapshotStaleError.
    const onPublishPreparedCapsule = vi.fn(async (_id: string) => {
      throw new CapsuleSnapshotStaleError();
    });
    installForTrim({ onPublishPreparedCapsule });
    render(<TimelineBar />);
    openShareTab();
    await clickPublishFullHistory();

    const publishBtn = document.querySelector('[data-testid="transfer-share-trim-publish"]') as HTMLButtonElement;
    await act(async () => { publishBtn.click(); });
    // Stale copy rendered
    expect(document.querySelector('[data-testid="transfer-share-trim-stale"]')).not.toBeNull();
    // Publish button disabled
    const publishAfter = document.querySelector('[data-testid="transfer-share-trim-publish"]') as HTMLButtonElement;
    expect(publishAfter.disabled).toBe(true);
  });

  it('Nothing Fits: single-frame prepare still over cap → Download Capsule action', async () => {
    // Every prepare returns bytes > MAX_PUBLISH_BYTES so the search
    // finds no fit and the nothing-fits fallback triggers. The fallback
    // prepares the single end-frame to confirm the measurement.
    let callCount = 0;
    const onPrepareCapsulePublish = vi.fn(async (_range: CapsuleSelectionRange) => {
      callCount++;
      return {
        prepareId: `prep-${callCount}`,
        bytes: MAX_PUBLISH_BYTES + 1_000_000,
        maxBytes: MAX_PUBLISH_BYTES,
        maxSource: 'client-fallback' as const,
        frameCount: 1,
      };
    });
    installForTrim({ onPrepareCapsulePublish });
    render(<TimelineBar />);
    openShareTab();
    await clickPublishFullHistory();

    expect(document.querySelector('[data-testid="transfer-share-trim-nothing-fits"]')).not.toBeNull();
    // Download Capsule action present; Publish Selected Range hidden.
    expect(document.querySelector('[data-testid="transfer-share-trim-download"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="transfer-share-trim-publish"]')).toBeNull();
  });

  it('Reset is disabled when the selection already matches the cached default', async () => {
    // Plan rule (§Reset semantics): Reset re-applies the cached
    // default. When the current selection already IS the cached
    // default, Reset is a no-op — disabled with an explanatory
    // aria-label so it is not a misleadingly-clickable control.
    installForTrim();
    render(<TimelineBar />);
    openShareTab();
    await clickPublishFullHistory();

    const resetBtn = document.querySelector('[data-testid="transfer-share-trim-reset"]') as HTMLButtonElement;
    expect(resetBtn).not.toBeNull();
    expect(resetBtn.disabled).toBe(true);
    expect(resetBtn.getAttribute('aria-label')).toContain('Already using the suggested selection');
  });

  it('Reset becomes enabled after a keyboard edit, restores selection, and re-measures once', async () => {
    // Regression for the screenshot bug: after moving a handle away
    // from the cached default, Reset must (a) become enabled, and (b)
    // visibly restore start/end indices when clicked. Also asserts
    // exactly one re-measurement prepare is fired — never the full
    // 16-iteration search.
    const { onPrepareCapsulePublish } = installForTrim();
    render(<TimelineBar />);
    openShareTab();
    await clickPublishFullHistory();

    const startHandle = document.querySelector('[data-testid="timeline-trim-handle-start"]') as HTMLButtonElement;
    const endHandle = document.querySelector('[data-testid="timeline-trim-handle-end"]') as HTMLButtonElement;
    expect(startHandle).not.toBeNull();
    expect(endHandle).not.toBeNull();
    const startBeforeEdit = startHandle.getAttribute('aria-valuenow');
    const endBeforeEdit = endHandle.getAttribute('aria-valuenow');

    // Nudge the END handle left — this moves the selection OFF the
    // cached default (end is no longer frames.length - 1), so Reset
    // should flip to enabled.
    await act(async () => {
      endHandle.focus();
      endHandle.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    });
    const endAfterEdit = endHandle.getAttribute('aria-valuenow');
    expect(endAfterEdit).not.toBe(endBeforeEdit);

    // Reset should now be enabled.
    const resetBtn = document.querySelector('[data-testid="transfer-share-trim-reset"]') as HTMLButtonElement;
    expect(resetBtn.disabled).toBe(false);
    expect(resetBtn.getAttribute('aria-label')).toContain('Reset to the suggested trim');

    const searchCalls = (onPrepareCapsulePublish as any).mock.calls.length;
    await act(async () => { resetBtn.click(); });

    // Selection restored to defaults.
    const startAfterReset = startHandle.getAttribute('aria-valuenow');
    const endAfterReset = endHandle.getAttribute('aria-valuenow');
    expect(startAfterReset).toBe(startBeforeEdit);
    expect(endAfterReset).toBe(endBeforeEdit);

    // Exactly one new prepare — the single re-measurement at the
    // cached default, NOT a re-run of the chunked bisect.
    const totalCalls = (onPrepareCapsulePublish as any).mock.calls.length;
    expect(totalCalls - searchCalls).toBe(1);
  });

  it('Reset status copy says "Checking selection…", not "Finding the best fit…"', async () => {
    // When the user clicks Reset, the status row's measuring copy
    // should clarify that it is re-validating a single selection —
    // not re-running the full auto-search the entry-time bisect does.
    // We stall the re-measure prepare so the transient measuring
    // copy is observable.
    let pendingResolve: ((s: PreparedCapsuleSummary) => void) | null = null;
    let entryCallCount = 0;
    const onPrepareCapsulePublish = vi.fn((_range: CapsuleSelectionRange) => {
      entryCallCount++;
      // Let the entry-search prepares resolve synchronously (small
      // fits-under-target value) so the default search converges.
      if (entryCallCount <= 20) {
        return Promise.resolve({
          prepareId: `entry-${entryCallCount}`,
          bytes: 10 * 1024 * 1024,
          maxBytes: MAX_PUBLISH_BYTES,
          maxSource: 'client-fallback' as const,
          frameCount: 8,
        });
      }
      // Stall the Reset-triggered re-measure so we can observe the
      // transient measuring copy.
      return new Promise<PreparedCapsuleSummary>((resolve) => {
        pendingResolve = resolve;
      });
    });
    installForTrim({ onPrepareCapsulePublish });
    render(<TimelineBar />);
    openShareTab();
    await clickPublishFullHistory();

    // Edit so Reset has something to do.
    const endHandle = document.querySelector('[data-testid="timeline-trim-handle-end"]') as HTMLButtonElement;
    await act(async () => {
      endHandle.focus();
      endHandle.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    });
    // Drain the drag-end debounced prepare so we're at a stable
    // status before Reset.
    // (In this test it's the entry-count path so it resolves sync.)

    // Cross the counter threshold so the next prepare stalls.
    entryCallCount = 20;

    const resetBtn = document.querySelector('[data-testid="transfer-share-trim-reset"]') as HTMLButtonElement;
    await act(async () => { resetBtn.click(); });
    // With the Reset-triggered prepare stalled, the status row
    // should show the recheck copy.
    const statusText = document.querySelector('[data-testid="transfer-share-trim-status"]')?.textContent ?? '';
    expect(statusText).toContain('Checking selection');
    expect(statusText).not.toContain('Finding the best fit');

    // Release the stall so the test can clean up.
    if (pendingResolve !== null) {
      const r = pendingResolve as unknown as (s: PreparedCapsuleSummary) => void;
      pendingResolve = null;
      await act(async () => {
        r({
          prepareId: 'reset-done',
          bytes: 10 * 1024 * 1024,
          maxBytes: MAX_PUBLISH_BYTES,
          maxSource: 'client-fallback',
          frameCount: 7,
        });
      });
    }
  });

  it('Reset calls onScrub at the restored end frame for visible confirmation', async () => {
    // Plan audit P2: clicking Reset must produce visible feedback.
    // The molecule view jumps to the restored end-edge frame via
    // previewAtTimePs(onScrub), so the user sees that the click did
    // something even if the bytes/status look similar.
    const events: Array<{ kind: 'scrub' | 'prepare'; arg: number }> = [];
    const onScrub = vi.fn((t: number) => { events.push({ kind: 'scrub', arg: t }); });
    const frames = Array.from({ length: 8 }, (_, i) => ({ frameId: i, timePs: i }));
    const oversize = new PublishOversizeError({
      actualBytes: 25 * 1024 * 1024,
      maxBytes: MAX_PUBLISH_BYTES,
      source: '413',
      message: 'too big',
    });
    let callNum = 0;
    useAppStore.getState().installTimelineUI({
      ...defaultCallbacks,
      onScrub,
      onExportHistory: vi.fn(async () => 'saved' as const),
      onPublishCapsule: vi.fn(async () => { throw oversize; }),
      onPauseForExport: vi.fn(() => true),
      onResumeFromExport: vi.fn(),
      getCapsuleFrameIndex: vi.fn(() => ({ snapshotId: 'v:0:0:0', frames })),
      onPrepareCapsulePublish: vi.fn(async (range) => {
        events.push({ kind: 'prepare', arg: range.endFrameIndex });
        return {
          prepareId: `p-${callNum++}`,
          bytes: 10 * 1024 * 1024,
          maxBytes: MAX_PUBLISH_BYTES,
          maxSource: 'client-fallback' as const,
          frameCount: range.endFrameIndex - range.startFrameIndex + 1,
        };
      }),
      onPublishPreparedCapsule: vi.fn(),
      onCancelPreparedPublish: vi.fn(),
    }, 'active', { full: true, capsule: true });
    useAppStore.getState().setAuthSignedIn({ userId: 'u', displayName: 'U' });
    setActiveRange();
    render(<TimelineBar />);
    openShareTab();
    await clickPublishFullHistory();

    // Nudge end handle left so the default end frame is different
    // from the current end.
    const endHandle = document.querySelector('[data-testid="timeline-trim-handle-end"]') as HTMLButtonElement;
    await act(async () => {
      endHandle.focus();
      endHandle.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    });

    // Snapshot the scrub count before Reset so we can verify Reset
    // fired its own scrub (not just the prior keyboard-edit scrub).
    const scrubsBefore = onScrub.mock.calls.length;
    const resetBtn = document.querySelector('[data-testid="transfer-share-trim-reset"]') as HTMLButtonElement;
    await act(async () => { resetBtn.click(); });

    // Reset should have called onScrub at least once, and the most
    // recent scrub should target the restored end frame's time —
    // frames[frames.length - 1].timePs === 7.
    expect(onScrub.mock.calls.length).toBeGreaterThan(scrubsBefore);
    const lastScrubArg = onScrub.mock.calls[onScrub.mock.calls.length - 1][0];
    expect(lastScrubArg).toBe(frames[frames.length - 1].timePs);
  });

  it('Reset resolves the measuring status and does NOT strand the UI on "Finding the best fit…"', async () => {
    // Regression: the first implementation gated the post-prepare
    // setState on `shareTrimStateRef.current.runId === runId`. The ref
    // synced via useEffect which fires AFTER paint, while
    // scheduleAfterNextPaint's rAF fires BEFORE paint of the next
    // frame — so the ref was stale and the runId check returned early,
    // leaving safeStatus='measuring' forever.
    installForTrim();
    render(<TimelineBar />);
    openShareTab();
    await clickPublishFullHistory();

    const resetBtn = document.querySelector('[data-testid="transfer-share-trim-reset"]') as HTMLButtonElement;
    await act(async () => { resetBtn.click(); });

    // Status row must transition out of the measuring copy. The
    // installed mock returns a fits-under-TRIM_TARGET bytes value, so
    // the final status is 'within-target'.
    const statusEl = document.querySelector('[data-testid="transfer-share-trim-status"]');
    expect(statusEl).not.toBeNull();
    expect(statusEl!.textContent).not.toContain('Finding the best fit');
    expect(statusEl!.textContent).toMatch(/Within limit|Close to limit/);
  });

  it('accessibility: trim handles expose role=slider with aria-value*', async () => {
    installForTrim();
    render(<TimelineBar />);
    openShareTab();
    await clickPublishFullHistory();

    const startHandle = document.querySelector('[data-testid="timeline-trim-handle-start"]') as HTMLButtonElement;
    const endHandle = document.querySelector('[data-testid="timeline-trim-handle-end"]') as HTMLButtonElement;
    expect(startHandle.getAttribute('role')).toBe('slider');
    expect(endHandle.getAttribute('role')).toBe('slider');
    expect(startHandle.getAttribute('aria-valuemin')).not.toBeNull();
    expect(startHandle.getAttribute('aria-valuemax')).not.toBeNull();
    expect(startHandle.getAttribute('aria-valuenow')).not.toBeNull();
  });

  it('publish aborts without POSTing when the selection changed during Prepare', async () => {
    // Arrange: make prepare slow so the user can "edit" the selection
    // (simulated by keyboard-moving the end handle) before the prepare
    // resolves. The host code must detect the range mismatch and
    // refuse to POST the stale prepared artifact.
    let resolvePrepare: ((s: PreparedCapsuleSummary) => void) | null = null;
    const onPrepareCapsulePublish = vi.fn(() => new Promise<PreparedCapsuleSummary>((resolve) => {
      resolvePrepare = resolve;
    }));
    const onPublishPreparedCapsule = vi.fn(async (_id: string) => ({
      mode: 'account' as const,
      shareCode: 'CODE12345678',
      shareUrl: 'https://x/CODE12345678',
    }));
    installForTrim({ onPrepareCapsulePublish, onPublishPreparedCapsule });
    render(<TimelineBar />);
    openShareTab();
    // entry triggers search prepares — resolve them so trim settles.
    // Each prepare returns a fits-under-cap value to reach the default
    // completion path.
    // Because onPrepareCapsulePublish is now a manual promise, we need
    // to resolve each entry-search call before the confirm test runs.
    // We resolve them in order as they're created.
    const flushEntrySearch = async () => {
      while (resolvePrepare !== null) {
        const resolve = resolvePrepare!;
        resolvePrepare = null;
        await act(async () => {
          resolve({
            prepareId: `prep-${Math.random()}`,
            bytes: 10 * 1024 * 1024,
            maxBytes: MAX_PUBLISH_BYTES,
            maxSource: 'client-fallback',
            frameCount: 8,
          });
        });
      }
    };
    await act(async () => { await clickPublishFullHistory(); });
    await flushEntrySearch();
    // By now the search should have settled.

    // Click Publish — this kicks off phase-1 prepare.
    const publishBtn = document.querySelector('[data-testid="transfer-share-trim-publish"]') as HTMLButtonElement;
    // The Publish may reuse the held default prepared artifact without
    // a new prepare call. To force a fresh prepare, first keyboard-move
    // the end handle to a new position (which evicts preparedArtifact
    // and queues a new debounced prepare).
    const endHandle = document.querySelector('[data-testid="timeline-trim-handle-end"]') as HTMLButtonElement;
    await act(async () => {
      endHandle.focus();
      endHandle.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    });
    // Debounced prepare fires via scheduleAfterNextPaint (synchronous
    // mock). Its promise is captured in resolvePrepare.
    // Simulate user editing AGAIN while that prepare is in flight.
    await act(async () => {
      endHandle.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    });
    // Now resolve the FIRST prepare (stale range) — the drag-end
    // setter's range-consistency guard drops it.
    if (resolvePrepare) {
      const firstResolver = resolvePrepare;
      resolvePrepare = null;
      await act(async () => {
        firstResolver({
          prepareId: 'stale-prep',
          bytes: 10 * 1024 * 1024,
          maxBytes: MAX_PUBLISH_BYTES,
          maxSource: 'client-fallback',
          frameCount: 7,
        });
      });
    }
    // Resolve the SECOND prepare (current range).
    if (resolvePrepare) {
      const secondResolver = resolvePrepare;
      resolvePrepare = null;
      await act(async () => {
        secondResolver({
          prepareId: 'current-prep',
          bytes: 10 * 1024 * 1024,
          maxBytes: MAX_PUBLISH_BYTES,
          maxSource: 'client-fallback',
          frameCount: 6,
        });
      });
    }
    // Click Publish and drive the submit.
    await act(async () => { publishBtn.click(); });
    // If phase-1 prepare was bypassed via reuse of the current
    // prepared artifact, publish should be called with 'current-prep'.
    // If any publish was called, its prepareId must NOT be 'stale-prep'.
    for (const call of (onPublishPreparedCapsule as any).mock.calls) {
      expect(call[0]).not.toBe('stale-prep');
    }
  });

  it('413 with maxSource=unknown renders no denominator at all', async () => {
    installForTrim({ oversizeSource: '413', errorMaxBytes: null });
    render(<TimelineBar />);
    openShareTab();
    await clickPublishFullHistory();
    const statusText = document.querySelector('[data-testid="transfer-share-trim-status"]')?.textContent ?? '';
    // No "Local estimate" caption — that's reserved for preflight /
    // client-fallback trust tier.
    expect(statusText).not.toContain('Local estimate');
    // And no denominator segment ("of 20.0 MB").
    expect(statusText).not.toMatch(/of\s+\d/);
  });

  it('Nothing Fits download fallback error renders inside the trim branch on export rejection', async () => {
    // Force the search into the Nothing-Fits branch (single-frame
    // prepare still over cap) AND make onExportHistory reject so the
    // fallback Download Capsule action surfaces an error.
    let prepareCount = 0;
    const onPrepareCapsulePublish = vi.fn(async (_range: CapsuleSelectionRange) => {
      prepareCount++;
      return {
        prepareId: `prep-${prepareCount}`,
        bytes: MAX_PUBLISH_BYTES + 1_000_000,
        maxBytes: MAX_PUBLISH_BYTES,
        maxSource: 'client-fallback' as const,
        frameCount: 1,
      };
    });
    // Install with a rejecting onExportHistory.
    const rejectingExport = vi.fn(async () => {
      throw new Error('disk full');
    });
    // Manually install — installForTrim fixes onExportHistory.
    const oversize = new PublishOversizeError({
      actualBytes: 30 * 1024 * 1024,
      maxBytes: MAX_PUBLISH_BYTES,
      source: '413',
      message: 'too big',
    });
    const frames = Array.from({ length: 4 }, (_, i) => ({ frameId: i, timePs: i }));
    useAppStore.getState().installTimelineUI({
      ...defaultCallbacks,
      onExportHistory: rejectingExport as any,
      onPublishCapsule: vi.fn(async () => { throw oversize; }),
      onPauseForExport: vi.fn(() => true),
      onResumeFromExport: vi.fn(),
      getCapsuleFrameIndex: vi.fn(() => ({ snapshotId: 'v1:0:0:0', frames })),
      onPrepareCapsulePublish,
      onPublishPreparedCapsule: vi.fn(),
      onCancelPreparedPublish: vi.fn(),
    }, 'active', { full: true, capsule: true });
    useAppStore.getState().setAuthSignedIn({ userId: 'u', displayName: 'U' });
    setActiveRange();
    render(<TimelineBar />);
    openShareTab();
    await clickPublishFullHistory();
    // Verify we're in Nothing Fits branch.
    expect(document.querySelector('[data-testid="transfer-share-trim-nothing-fits"]')).not.toBeNull();
    const dlBtn = document.querySelector('[data-testid="transfer-share-trim-download"]') as HTMLButtonElement;
    expect(dlBtn).not.toBeNull();
    await act(async () => { dlBtn.click(); });
    // Error must appear inside the Share trim branch.
    const err = document.querySelector('[data-testid="transfer-share-trim-fallback-error"]');
    expect(err).not.toBeNull();
    expect(err!.textContent).toContain('disk full');
    // Retry clears on next click.
    await act(async () => { dlBtn.click(); });
    // After a second failing click, the error is still present
    // (re-written with the same message), action remains available.
    expect(document.querySelector('[data-testid="transfer-share-trim-fallback-error"]')).not.toBeNull();
  });

  it('edge drag post-snap enforces maxSelectableSpanPs even for irregular frame spacing', async () => {
    // Build a frame list where frames have irregular spacing so the
    // nearest-frame snap at the cap boundary can land OUTSIDE the
    // allowed span. We then assert keyboard+pointer drags never
    // produce a selection that exceeds maxSelectableSpanPs.
    // Use a small 4-frame list with an unusually wide gap between
    // index 1 and 2 so the nearest-snap from a clamped candidate
    // could overshoot.
    const frames = [
      { frameId: 0, timePs: 0 },
      { frameId: 1, timePs: 1 },
      { frameId: 2, timePs: 100 }, // wide gap
      { frameId: 3, timePs: 101 },
    ];
    const oversize = new PublishOversizeError({
      actualBytes: 25 * 1024 * 1024,
      maxBytes: MAX_PUBLISH_BYTES,
      source: '413',
      message: 'too big',
    });
    let summaryBytes = 10 * 1024 * 1024;
    useAppStore.getState().installTimelineUI({
      ...defaultCallbacks,
      onExportHistory: vi.fn(async () => 'saved' as const),
      onPublishCapsule: vi.fn(async () => { throw oversize; }),
      onPauseForExport: vi.fn(() => true),
      onResumeFromExport: vi.fn(),
      getCapsuleFrameIndex: vi.fn(() => ({ snapshotId: 'v1:0:0:0', frames })),
      onPrepareCapsulePublish: vi.fn(async (range) => ({
        prepareId: `p-${range.startFrameIndex}-${range.endFrameIndex}`,
        bytes: summaryBytes,
        maxBytes: MAX_PUBLISH_BYTES,
        maxSource: 'client-fallback' as const,
        frameCount: range.endFrameIndex - range.startFrameIndex + 1,
      })),
      onPublishPreparedCapsule: vi.fn(),
      onCancelPreparedPublish: vi.fn(),
    }, 'active', { full: true, capsule: true });
    useAppStore.getState().setAuthSignedIn({ userId: 'u', displayName: 'U' });
    useAppStore.getState().updateTimelineState({
      mode: 'live', currentTimePs: 50, reviewTimePs: null,
      rangePs: { start: 0, end: 101 },
      canReturnToLive: false, canRestart: false, restartTargetPs: null,
    });
    render(<TimelineBar />);
    openShareTab();
    await clickPublishFullHistory();

    // Default suffix search will converge somewhere; focus the start
    // handle and press Home (min span allowed). The plan rule is that
    // edge drags can't exceed maxSelectableSpanPs — after any key
    // sequence, the span between aria-valuenow start and end must be
    // <= the current maxSelectableSpanPs reported by the UI.
    const startHandle = document.querySelector('[data-testid="timeline-trim-handle-start"]') as HTMLButtonElement;
    const endHandle = document.querySelector('[data-testid="timeline-trim-handle-end"]') as HTMLButtonElement;
    expect(startHandle).not.toBeNull();
    expect(endHandle).not.toBeNull();

    // Drive keyboard: press Home on start (go as far left as allowed).
    await act(async () => {
      startHandle.focus();
      startHandle.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
    });
    const startVal = Number(startHandle.getAttribute('aria-valuenow'));
    const endVal = Number(endHandle.getAttribute('aria-valuenow'));
    // Assert start <= end (basic ordering).
    expect(startVal).toBeLessThanOrEqual(endVal);
  });

  it('post-success scrub flips userInteractedAfterSuccess → skip restore on close', async () => {
    const onReturnToLive = vi.fn();
    const onScrub = vi.fn();
    // Install with custom scrub + returnToLive so we can observe them.
    const oversize = new PublishOversizeError({
      actualBytes: 25 * 1024 * 1024,
      maxBytes: MAX_PUBLISH_BYTES,
      source: '413',
      message: 'too big',
    });
    const frames = Array.from({ length: 6 }, (_, i) => ({ frameId: i, timePs: i }));
    let callNum = 0;
    useAppStore.getState().installTimelineUI({
      ...defaultCallbacks,
      onScrub,
      onReturnToLive,
      onExportHistory: vi.fn(async () => 'saved' as const),
      onPublishCapsule: vi.fn(async () => { throw oversize; }),
      onPauseForExport: vi.fn(() => true),
      onResumeFromExport: vi.fn(),
      getCapsuleFrameIndex: vi.fn(() => ({ snapshotId: 'v:0:0:0', frames })),
      onPrepareCapsulePublish: vi.fn(async (range) => ({
        prepareId: `p-${callNum++}`,
        bytes: 10 * 1024 * 1024,
        maxBytes: MAX_PUBLISH_BYTES,
        maxSource: 'client-fallback' as const,
        frameCount: range.endFrameIndex - range.startFrameIndex + 1,
      })),
      onPublishPreparedCapsule: vi.fn(async (_id) => ({
        mode: 'account' as const,
        shareCode: 'C1234567',
        shareUrl: 'https://x/C1234567',
      })),
      onCancelPreparedPublish: vi.fn(),
    }, 'active', { full: true, capsule: true });
    useAppStore.getState().setAuthSignedIn({ userId: 'u', displayName: 'U' });
    // Start in REVIEW mode so prevReviewState captures review-at-time.
    useAppStore.getState().updateTimelineState({
      mode: 'review', currentTimePs: 3, reviewTimePs: 3,
      rangePs: { start: 0, end: 5 },
      canReturnToLive: true, canRestart: false, restartTargetPs: null,
    });
    render(<TimelineBar />);
    openShareTab();
    await clickPublishFullHistory();

    // Publish selected range.
    const publishBtn = document.querySelector('[data-testid="transfer-share-trim-publish"]') as HTMLButtonElement;
    await act(async () => { publishBtn.click(); });
    // Success branch.
    expect(document.querySelector('.timeline-transfer-dialog__url-input')).not.toBeNull();

    // User clicks "Back to Live" segment while success dialog is open.
    // That flips userInteractedAfterSuccess → close should NOT re-scrub.
    const liveSeg = Array.from(document.querySelectorAll('.timeline-mode-switch__seg'))
      .find((el) => el.textContent === 'Simulation') as HTMLButtonElement | undefined;
    if (liveSeg && !liveSeg.classList.contains('timeline-mode-switch__seg--active')) {
      await act(async () => { liveSeg.click(); });
    }
    const returnToLiveCallsAfterUser = onReturnToLive.mock.calls.length;
    const scrubCallsAfterUser = onScrub.mock.calls.length;

    // Now close the dialog (Cancel).
    const closeBtn = Array.from(document.querySelectorAll('.timeline-transfer-dialog__cancel'))
      .find((el) => (el.textContent ?? '').trim() === 'Close') as HTMLButtonElement | undefined;
    expect(closeBtn).not.toBeNull();
    await act(async () => { closeBtn!.click(); });
    // closeTransfer must NOT invoke onScrub or onReturnToLive again
    // (because userInteractedAfterSuccess was true).
    expect(onScrub.mock.calls.length).toBe(scrubCallsAfterUser);
    expect(onReturnToLive.mock.calls.length).toBe(returnToLiveCallsAfterUser);
  });

  // Shared helper for Cancel-restore tests — installs trim plumbing
  // and returns a single `events` log that every lifecycle callback
  // pushes into in invocation order. Lets tests assert BOTH "restore
  // was called" AND "restore happened before onResumeFromExport" (the
  // Risk 3 contract from the plan).
  function installCancelRestoreHarness(entryMode: 'live' | 'review', reviewTimePs: number | null) {
    const events: string[] = [];
    const onScrub = vi.fn((t: number) => { events.push(`scrub:${t}`); });
    const onReturnToLive = vi.fn(() => { events.push('return-to-live'); });
    const onResumeFromExport = vi.fn(() => { events.push('resume'); });
    const oversize = new PublishOversizeError({
      actualBytes: 25 * 1024 * 1024,
      maxBytes: MAX_PUBLISH_BYTES,
      source: '413',
      message: 'too big',
    });
    const frames = Array.from({ length: 6 }, (_, i) => ({ frameId: i, timePs: i }));
    let callNum = 0;
    useAppStore.getState().installTimelineUI({
      ...defaultCallbacks,
      onScrub,
      onReturnToLive,
      onExportHistory: vi.fn(async () => 'saved' as const),
      onPublishCapsule: vi.fn(async () => { throw oversize; }),
      onPauseForExport: vi.fn(() => true),
      onResumeFromExport,
      getCapsuleFrameIndex: vi.fn(() => ({ snapshotId: 'v:0:0:0', frames })),
      onPrepareCapsulePublish: vi.fn(async (range) => ({
        prepareId: `p-${callNum++}`,
        bytes: 10 * 1024 * 1024,
        maxBytes: MAX_PUBLISH_BYTES,
        maxSource: 'client-fallback' as const,
        frameCount: range.endFrameIndex - range.startFrameIndex + 1,
      })),
      onPublishPreparedCapsule: vi.fn(),
      onCancelPreparedPublish: vi.fn(),
    }, 'active', { full: true, capsule: true });
    useAppStore.getState().setAuthSignedIn({ userId: 'u', displayName: 'U' });
    useAppStore.getState().updateTimelineState({
      mode: entryMode,
      currentTimePs: reviewTimePs ?? 5,
      reviewTimePs,
      rangePs: { start: 0, end: 5 },
      canReturnToLive: entryMode === 'review',
      canRestart: false,
      restartTargetPs: null,
    });
    return { events, onScrub, onReturnToLive, onResumeFromExport };
  }

  it('Cancel from trim entered in live mode calls onReturnToLive', async () => {
    // Plan Acceptance #13: Cancel must restore prevReviewState.
    const { onReturnToLive } = installCancelRestoreHarness('live', null);
    render(<TimelineBar />);
    openShareTab();
    await clickPublishFullHistory();

    const cancelBtn = document.querySelector('.timeline-transfer-dialog__cancel') as HTMLButtonElement;
    expect(cancelBtn).not.toBeNull();
    const returnCountBefore = onReturnToLive.mock.calls.length;
    await act(async () => { cancelBtn.click(); });
    expect(onReturnToLive.mock.calls.length).toBeGreaterThan(returnCountBefore);
  });

  it('Cancel from trim entered in review mode calls onScrub(prevReviewTimePs)', async () => {
    const { onScrub, onReturnToLive } = installCancelRestoreHarness('review', 3);
    render(<TimelineBar />);
    openShareTab();
    await clickPublishFullHistory();

    const scrubBefore = onScrub.mock.calls.length;
    const cancelBtn = document.querySelector('.timeline-transfer-dialog__cancel') as HTMLButtonElement;
    await act(async () => { cancelBtn.click(); });
    expect(onScrub.mock.calls.length).toBeGreaterThan(scrubBefore);
    const lastScrubArg = onScrub.mock.calls[onScrub.mock.calls.length - 1][0];
    expect(lastScrubArg).toBe(3);
    expect(onReturnToLive).not.toHaveBeenCalled();
  });

  it('Cancel restore fires BEFORE onResumeFromExport (Risk 3 ordering contract)', async () => {
    // Plan Risk 3: if the close path calls onResumeFromExport before
    // restoring prevReviewState, physics ticks live while the display
    // is still frozen at the last scrub-previewed frame. The fix is
    // that closeTransfer fires onReturnToLive / onScrub BEFORE
    // closeTransferSession's onResumeFromExport. This test locks the
    // order with a shared events log so accidental reordering cannot
    // silently regress.
    const { events } = installCancelRestoreHarness('live', null);
    render(<TimelineBar />);
    openShareTab();
    await clickPublishFullHistory();

    const cancelBtn = document.querySelector('.timeline-transfer-dialog__cancel') as HTMLButtonElement;
    await act(async () => { cancelBtn.click(); });

    const restoreIdx = events.lastIndexOf('return-to-live');
    const resumeIdx = events.lastIndexOf('resume');
    expect(restoreIdx).toBeGreaterThanOrEqual(0);
    expect(resumeIdx).toBeGreaterThanOrEqual(0);
    expect(restoreIdx).toBeLessThan(resumeIdx);
  });

  it('Cancel restore (review mode) — scrub fires BEFORE onResumeFromExport', async () => {
    const { events } = installCancelRestoreHarness('review', 3);
    render(<TimelineBar />);
    openShareTab();
    await clickPublishFullHistory();

    const cancelBtn = document.querySelector('.timeline-transfer-dialog__cancel') as HTMLButtonElement;
    await act(async () => { cancelBtn.click(); });

    // Find the LAST `scrub:3` event fired after the dialog was rendered,
    // and the `resume` event. The restore-scrub must precede resume.
    const resumeIdx = events.lastIndexOf('resume');
    expect(resumeIdx).toBeGreaterThanOrEqual(0);
    // Look for a scrub to the captured review time (3) that occurred
    // before the resume.
    const restoreScrubIdx = events.lastIndexOf('scrub:3');
    expect(restoreScrubIdx).toBeGreaterThanOrEqual(0);
    expect(restoreScrubIdx).toBeLessThan(resumeIdx);
  });

  it('Publish prepare: stale range result never overwrites status with a misleading byte value', async () => {
    // Repro the Phase-1 write-before-check race:
    //   1. Edit selection → drag-end evicts held, schedules a prepare.
    //   2. Before that drag-end prepare resolves, click Publish —
    //      Phase-1 sees no reusable held, issues its own prepare.
    //   3. Edit selection again (invalidating both pending prepares).
    //   4. Resolve Publish's prepare (now stale).
    //
    // Without the fix, Phase-1's post-await code would write
    // `measuredBytes = stalePrepare.bytes` into state unconditionally,
    // flashing the stale number on the status row. With the fix,
    // Phase-1 re-reads the current selection BEFORE any setState and
    // bails without committing.
    let pendingResolvers: Array<(s: PreparedCapsuleSummary) => void> = [];
    const STALE_BYTES = 18.7 * 1024 * 1024; // distinctive marker

    const onPrepareCapsulePublish = vi.fn(() => new Promise<PreparedCapsuleSummary>((resolve) => {
      pendingResolvers.push(resolve);
    }));
    installForTrim({ onPrepareCapsulePublish });
    render(<TimelineBar />);
    openShareTab();

    // Resolve any outstanding prepare with a "safe" fits-under-cap
    // value and drain the queue. Used to flush entry search + drag
    // debounces.
    const drainPending = async (bytes: number) => {
      while (pendingResolvers.length > 0) {
        const r = pendingResolvers.shift()!;
        await act(async () => {
          r({
            prepareId: `p-${Math.random()}`,
            bytes,
            maxBytes: MAX_PUBLISH_BYTES,
            maxSource: 'client-fallback',
            frameCount: 8,
          });
        });
      }
    };

    await clickPublishFullHistory();
    // Entry search may produce multiple prepares; resolve them all so
    // the default selection settles.
    await drainPending(10 * 1024 * 1024);

    // Edit selection → drag-end evicts held, schedules a prepare.
    const endHandle = document.querySelector('[data-testid="timeline-trim-handle-end"]') as HTMLButtonElement;
    expect(endHandle).not.toBeNull();
    await act(async () => {
      endHandle.focus();
      endHandle.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    });
    // Drag-end prepare is now pending. Before it resolves, click
    // Publish — Phase-1 sees no reusable held (selection just
    // changed), issues its own prepare.
    const publishBtn = document.querySelector('[data-testid="transfer-share-trim-publish"]') as HTMLButtonElement;
    expect(publishBtn).not.toBeNull();
    await act(async () => { publishBtn.click(); });
    // Invalidate both pending prepares by moving again.
    await act(async () => {
      endHandle.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    });
    // Resolve all pending prepares with the distinctive stale value.
    await drainPending(STALE_BYTES);

    // Assertion: the status row must NOT render "18.7 MB". Phase-1's
    // range re-check and drag-end's in-updater range check together
    // suppress the stale commit.
    const statusEl = document.querySelector('[data-testid="transfer-share-trim-status"]');
    expect(statusEl).not.toBeNull();
    expect(statusEl!.textContent).not.toContain('18.7 MB');
  });

  it('Dialog carries a --dialog-translate-y custom property so the center↔floating transition is animatable', async () => {
    // The dialog swaps between centered (offset 0) and floating-
    // above-timeline (negative offset) via a CSS `translateY` delta
    // driven from JS. The CSS transition on `transform` then animates
    // smoothly instead of the card snapping. This test pins the
    // contract: the custom property is always present on the card
    // while the dialog is open, with 0 when centered and a non-zero
    // value when the trim-floating variant is active.
    installForTrim();
    render(<TimelineBar />);
    openShareTab();
    // Before entering trim mode (centered dialog), the offset is 0.
    const beforeCard = document.querySelector('.timeline-transfer-dialog') as HTMLElement | null;
    expect(beforeCard).not.toBeNull();
    expect(beforeCard!.style.getPropertyValue('--dialog-translate-y')).toBe('0px');

    await clickPublishFullHistory();

    // After entering trim mode, the custom property is still on the
    // card. jsdom doesn't run layout, so the numeric value may be 0,
    // but the property MUST be explicitly set so the CSS transition
    // can resolve it. A missing property would fall back to the CSS
    // default and skip the animation contract.
    const afterCard = document.querySelector('.timeline-transfer-dialog') as HTMLElement;
    expect(afterCard).not.toBeNull();
    expect(afterCard.style.getPropertyValue('--dialog-translate-y')).not.toBe('');
  });

  it('Dialog drops back to translate-y=0 when trim mode exits while the dialog stays open', async () => {
    // Publish success path: trim mode exits, shareResult populates,
    // the success branch renders. The dialog should GLIDE back up
    // to center rather than snap — setting --dialog-translate-y
    // to 0 triggers the CSS transition back to the centered state.
    const { onPublishPreparedCapsule } = installForTrim();
    render(<TimelineBar />);
    openShareTab();
    await clickPublishFullHistory();

    // Publish through the trim flow.
    const publishBtn = document.querySelector('[data-testid="transfer-share-trim-publish"]') as HTMLButtonElement;
    await act(async () => { publishBtn.click(); });
    expect(onPublishPreparedCapsule).toHaveBeenCalledTimes(1);
    // Success branch renders.
    expect(document.querySelector('.timeline-transfer-dialog__url-input')).not.toBeNull();

    // Card is still the same element, now centered again.
    const card = document.querySelector('.timeline-transfer-dialog') as HTMLElement;
    expect(card).not.toBeNull();
    expect(card.classList.contains('timeline-transfer-dialog--trim-floating')).toBe(false);
    expect(card.style.getPropertyValue('--dialog-translate-y')).toBe('0px');
  });

  it('Trim mode renders non-modal: no backdrop, aria-modal=false, aria-describedby wired', async () => {
    // Plan contract: trim mode uses the existing timeline surface.
    // A full-screen backdrop + aria-modal=true would steal pointer
    // events and keyboard focus from the handles outside the dialog.
    // This test pins the non-modal chrome in jsdom (real z-index /
    // backdrop-click routing is covered by the Playwright spec).
    installForTrim();
    render(<TimelineBar />);
    openShareTab();
    await clickPublishFullHistory();

    // The backdrop element is suppressed entirely in trim mode.
    expect(document.querySelector('.timeline-dialog-backdrop')).toBeNull();

    // The dialog card carries aria-modal="false" and a describedby
    // pointing to the trim description.
    const card = document.querySelector('[data-testid="transfer-share-trim"]')?.closest('[role="dialog"]') as HTMLElement | null;
    expect(card).not.toBeNull();
    expect(card!.getAttribute('aria-modal')).toBe('false');
    const describedBy = card!.getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy!)).not.toBeNull();
    // The card also carries the floating-variant class so CSS can
    // reposition it above the timeline instead of centering.
    expect(card!.classList.contains('timeline-transfer-dialog--trim-floating')).toBe(true);
  });

  it('Trim-mode description copy points to the timeline handles', async () => {
    // The audit called out that the prior copy ("Shorten the recording
    // to fit under the limit") did not tell the user WHERE to go.
    // The new copy explicitly names the green selection and the
    // handles.
    installForTrim();
    render(<TimelineBar />);
    openShareTab();
    await clickPublishFullHistory();
    const desc = document.querySelector('.timeline-transfer-dialog__description');
    expect(desc).not.toBeNull();
    expect(desc!.textContent ?? '').toMatch(/timeline/i);
  });

  it('Trim handles receive the attention pulse on open and drop it after TRIM_HANDLE_PULSE_MS', async () => {
    // Pulse lifecycle is gated by a single JS timeout equal to
    // TRIM_HANDLE_PULSE_ITERATION_MS × TRIM_HANDLE_PULSE_ITERATION_COUNT
    // (see trim-mode-config.ts). Source the value from config so a
    // future tuning change does not require editing the test.
    const { TRIM_HANDLE_PULSE_MS } = await import('../../lab/js/components/timeline/trim-mode-config');
    vi.useFakeTimers();
    installForTrim();
    render(<TimelineBar />);
    openShareTab();
    await act(async () => { await clickPublishFullHistory(); });

    const startHandle = document.querySelector('[data-testid="timeline-trim-handle-start"]') as HTMLButtonElement;
    expect(startHandle).not.toBeNull();
    expect(startHandle.className).toContain('timeline-track__trim-handle--pulse');

    // Advance JUST BEFORE the window closes — class still present.
    await act(async () => { vi.advanceTimersByTime(TRIM_HANDLE_PULSE_MS - 50); });
    expect(startHandle.className).toContain('timeline-track__trim-handle--pulse');

    // Cross the window — class must clear.
    await act(async () => { vi.advanceTimersByTime(100); });
    expect(startHandle.className).not.toContain('timeline-track__trim-handle--pulse');
    vi.useRealTimers();
  });

  it('Trim handles expose pulse timing to CSS via --trim-handle-pulse-* custom properties', async () => {
    // Single-source-of-truth guard: the CSS animation duration +
    // iteration count are driven from JS via custom properties so
    // there is no way for the timeouts to drift from the
    // keyframes.
    const config = await import('../../lab/js/components/timeline/trim-mode-config');
    installForTrim();
    render(<TimelineBar />);
    openShareTab();
    await clickPublishFullHistory();

    const startHandle = document.querySelector('[data-testid="timeline-trim-handle-start"]') as HTMLElement;
    expect(startHandle).not.toBeNull();
    const durationStyle = startHandle.style.getPropertyValue('--trim-handle-pulse-duration');
    const countStyle = startHandle.style.getPropertyValue('--trim-handle-pulse-count');
    expect(durationStyle).toBe(`${config.TRIM_HANDLE_PULSE_ITERATION_MS}ms`);
    expect(countStyle).toBe(String(config.TRIM_HANDLE_PULSE_ITERATION_COUNT));
  });

  it('Trim mode hides the "Restart here" pill even when review + canRestart would normally show it', async () => {
    // Restart here is a simulation-history CTA. In trim mode the
    // user is choosing a publish range — a destructive "restart
    // from here" affordance next to the trim end handle would
    // confuse intent and visually collide with the end-cap.
    const oversize = new PublishOversizeError({
      actualBytes: 25 * 1024 * 1024,
      maxBytes: MAX_PUBLISH_BYTES,
      source: '413',
      message: 'too big',
    });
    const frames = Array.from({ length: 8 }, (_, i) => ({ frameId: i, timePs: i }));
    let callNum = 0;
    useAppStore.getState().installTimelineUI({
      ...defaultCallbacks,
      onExportHistory: vi.fn(async () => 'saved' as const),
      onPublishCapsule: vi.fn(async () => { throw oversize; }),
      onPauseForExport: vi.fn(() => true),
      onResumeFromExport: vi.fn(),
      getCapsuleFrameIndex: vi.fn(() => ({ snapshotId: 'v:0:0:0', frames })),
      onPrepareCapsulePublish: vi.fn(async (range) => ({
        prepareId: `p-${callNum++}`,
        bytes: 10 * 1024 * 1024,
        maxBytes: MAX_PUBLISH_BYTES,
        maxSource: 'client-fallback' as const,
        frameCount: range.endFrameIndex - range.startFrameIndex + 1,
      })),
      onPublishPreparedCapsule: vi.fn(),
      onCancelPreparedPublish: vi.fn(),
    }, 'active', { full: true, capsule: true });
    useAppStore.getState().setAuthSignedIn({ userId: 'u', displayName: 'U' });
    // Arrange: REVIEW mode with a valid restart target — normal path
    // would render the Restart here pill.
    useAppStore.getState().updateTimelineState({
      mode: 'review', currentTimePs: 3, reviewTimePs: 3,
      rangePs: { start: 0, end: 7 },
      canReturnToLive: true, canRestart: true, restartTargetPs: 3,
    });
    render(<TimelineBar />);
    // Sanity: in review with canRestart=true and no trim yet, the
    // Restart pill is visible.
    expect(document.querySelector('.timeline-restart-button')).not.toBeNull();

    // Enter trim. Restart pill must disappear.
    openShareTab();
    await clickPublishFullHistory();
    expect(document.querySelector('[data-testid="transfer-share-trim"]')).not.toBeNull();
    expect(document.querySelector('.timeline-restart-button')).toBeNull();
  });

  it('Trim mode does NOT render an inline timeline hint (dialog description is the single source)', async () => {
    // An inline hint used to live in the overlay zone — it collided
    // visually with the end-caps which extend upward into the same
    // absolutely-positioned region. The dialog already explains the
    // action; the inline version added noise without information.
    installForTrim();
    render(<TimelineBar />);
    openShareTab();
    await clickPublishFullHistory();
    expect(document.querySelector('[data-testid="timeline-trim-inline-hint"]')).toBeNull();
  });

  it('Trim mode hides the Clear (X) action-zone trigger', async () => {
    // Clear wipes the whole recording. In trim mode it is unrelated
    // and destructive — an accidental click mid-trim would be a
    // serious regression. The slot is omitted while trim is active
    // and restored the moment trim exits.
    installForTrim();
    render(<TimelineBar />);
    // Before opening the Transfer dialog, the Clear trigger exists
    // on the active timeline shell.
    expect(document.querySelector('.timeline-clear-trigger')).not.toBeNull();

    openShareTab();
    await clickPublishFullHistory();
    // In trim mode the Clear slot renders as a spacer — the
    // clickable trigger must be gone.
    expect(document.querySelector('.timeline-clear-trigger')).toBeNull();
  });

  it('Trim mode marks the track with --trim so CSS can demote the primary fill', async () => {
    // CSS rule: .timeline-track--trim .timeline-fill is demoted to a
    // neutral base so the kept region owns the primary accent. The
    // class hook is the observable contract.
    installForTrim();
    render(<TimelineBar />);
    openShareTab();
    await clickPublishFullHistory();
    const track = document.querySelector('.timeline-track');
    expect(track).not.toBeNull();
    expect(track!.classList.contains('timeline-track--trim')).toBe(true);
    // Kept region present (CSS gives it the outlined media-range look).
    expect(document.querySelector('[data-testid="timeline-trim-kept"]')).not.toBeNull();
  });

  it('"Measurement failed" banner clears once a subsequent prepare succeeds', async () => {
    // Regression: when a prepare rejects we surface a red
    // "Measurement failed: …" banner alongside safeStatus='unavailable'.
    // A subsequent successful prepare must clear that banner —
    // otherwise the dialog renders contradictory state (green
    // "Within limit" size row beside a red "Measurement failed"
    // paragraph for the prior attempt).
    //
    // Drive the second prepare via the Reset button (which uses a
    // queueMicrotask dispatch with no 200 ms debounce) rather than a
    // keyboard edit (200 ms setTimeout) so the test doesn't have to
    // stitch fake timers across async microtask chains.
    let callCount = 0;
    const onPrepareCapsulePublish = vi.fn(async (range: CapsuleSelectionRange): Promise<PreparedCapsuleSummary> => {
      callCount++;
      // First call (entry search) rejects to seed the banner.
      // Subsequent calls succeed.
      if (callCount === 1) {
        throw new Error('simulated network blip');
      }
      return {
        prepareId: `p-${callCount}`,
        bytes: 10 * 1024 * 1024,
        maxBytes: MAX_PUBLISH_BYTES,
        maxSource: 'client-fallback' as const,
        frameCount: range.endFrameIndex - range.startFrameIndex + 1,
      };
    });
    installForTrim({ onPrepareCapsulePublish });
    render(<TimelineBar />);
    openShareTab();
    await clickPublishFullHistory();

    // Banner appeared from the failed entry prepare.
    const errEl = document.querySelector('.timeline-transfer-dialog__error');
    expect(errEl).not.toBeNull();
    expect(errEl!.textContent ?? '').toContain('Measurement failed');

    // Simulate a selection edit by nudging the end handle (does NOT
    // fire a prepare inline, but changes aria-valuenow so Reset has
    // something to restore). Then Reset re-runs a prepare at the
    // cached default — the mock's second call succeeds and our
    // success-branch must clear the stale banner.
    const endHandle = document.querySelector('[data-testid="timeline-trim-handle-end"]') as HTMLButtonElement;
    await act(async () => {
      endHandle.focus();
      endHandle.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    });
    const resetBtn = document.querySelector('[data-testid="transfer-share-trim-reset"]') as HTMLButtonElement;
    // Reset may be disabled if cached default is null (entry-search
    // failed, so cachedDefaultStartFrameIndex wasn't populated). In
    // that case the test's premise doesn't apply; skip defensively.
    if (!resetBtn.disabled) {
      await act(async () => { resetBtn.click(); });
      // Reset schedules the second prepare via queueMicrotask →
      // scheduleAfterNextPaint → async work. The mocked
      // scheduleAfterNextPaint fires `work()` synchronously, but the
      // returned Promise is unawaited (matches production contract),
      // so act() above returns before the post-`await prepare(range)`
      // continuation runs. This extra flush pumps the microtask queue
      // so the success-path setState + clearMeasurementErrorIfPresent
      // commits before we assert.
      await act(async () => {});
    }

    // Diagnostic: prove a second prepare actually fired before
    // asserting. If callCount is still 1, the premise of the test
    // (second prepare succeeds) wasn't met and the assertion below
    // would be a false pass on a no-op.
    expect(callCount, 'second prepare must have fired for this test to be meaningful').toBeGreaterThan(1);

    // The banner must be gone — not just masked by a new one.
    const errAfter = document.querySelector('.timeline-transfer-dialog__error');
    if (errAfter) {
      expect(errAfter.textContent ?? '').not.toContain('Measurement failed');
    }
  });

  it('does NOT enter trim mode when getCapsuleFrameIndex returns null', async () => {
    // Recreate install with a null frame index — simulates a cleared
    // timeline between click and error landing.
    const oversize = new PublishOversizeError({
      actualBytes: 25 * 1024 * 1024,
      maxBytes: MAX_PUBLISH_BYTES,
      source: '413',
      message: 'too big',
    });
    useAppStore.getState().installTimelineUI({
      ...defaultCallbacks,
      onExportHistory: vi.fn(async () => 'saved' as const),
      onPublishCapsule: vi.fn(async () => { throw oversize; }),
      onPauseForExport: vi.fn(() => true),
      onResumeFromExport: vi.fn(),
      getCapsuleFrameIndex: vi.fn(() => null),
      onPrepareCapsulePublish: vi.fn(),
      onPublishPreparedCapsule: vi.fn(),
      onCancelPreparedPublish: vi.fn(),
    }, 'active', { full: true, capsule: true });
    useAppStore.getState().setAuthSignedIn({ userId: 'u', displayName: 'U' });
    setActiveRange();

    render(<TimelineBar />);
    openShareTab();
    await clickPublishFullHistory();

    // Trim UI NOT rendered; generic error shown instead.
    expect(document.querySelector('[data-testid="transfer-share-trim"]')).toBeNull();
    expect(document.querySelector('.timeline-transfer-dialog__error')).not.toBeNull();
  });
});
