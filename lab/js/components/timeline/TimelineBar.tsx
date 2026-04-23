/**
 * TimelineBar — composition layer for the timeline UI.
 *
 * Layout contract (CSS variables defined on .timeline-bar):
 *   --tl-rail-width   Mode rail width (96px desktop, 84px mobile)
 *   --tl-time-width   Time column width (56px desktop, 48px mobile)
 *   --tl-action-width Action column width (64px, two-slot: clear + unified transfer)
 *   --tl-shell-height Shell row height (44px desktop, 38px mobile)
 *   --tl-mode-height  Mode switch height (36px desktop, 32px mobile)
 *
 * The track width is invariant because every grid column is fixed or 1fr.
 * Overlays (Start Recording, Restart here) float in a reserved zone above
 * the track. Empty spacers preserve the grid skeleton in modes that don't
 * use overlays or actions.
 *
 * Module split:
 *   timeline-format.ts        — formatTime, getTimelineProgress, getRestartAnchorStyle
 *   timeline-mode-switch.tsx  — TimelineModeSwitch, buildModeSlots, ModeSegment
 *   timeline-clear-dialog.tsx — TimelineClearDialog, useClearConfirm, ClearTrigger
 *   timeline-transfer-dialog.tsx — unified Download + Share dialog (single trigger)
 *   timeline-export-dialog.tsx — TimelineExportKind, useExportDialog (kind state only; legacy dialog no longer mounted)
 */

import React, { useCallback, useRef, useState, useEffect, useLayoutEffect } from 'react';
import { useAppStore } from '../../store/app-store';
import { formatTime, getTimelineProgress, getRestartAnchorStyle } from './timeline-format';
import { TimelineModeSwitch } from './timeline-mode-switch';
import { TimelineClearDialog, useClearConfirm, ClearTrigger } from './timeline-clear-dialog';
import type { TimelineExportKind } from './timeline-export-dialog';
import {
  TimelineTransferDialog,
  useTransferDialog,
  TransferTrigger,
} from './timeline-transfer-dialog';
import { hydrateAuthSession, AuthRequiredError, AgeConfirmationRequiredError } from '../../runtime/auth-runtime';
import { ActionHint } from '../ActionHint';
import { TIMELINE_HINTS } from './timeline-hints';
import { scheduleAfterNextPaint } from './timeline-after-paint';
import { measureSync } from './timeline-performance';
import {
  isPublishOversizeError,
  isCapsuleSnapshotStaleError,
  type PublishOversizeError,
} from '../../runtime/publish-errors';
import { MAX_PUBLISH_BYTES } from '../../../../src/share/constants';
import type { ShareResult } from '../../../../src/share/share-result';
import {
  GuestTurnstileError,
  GuestAgeAttestationError,
  GuestQuotaExceededError,
  GuestPublishDisabledError,
} from '../../runtime/publish-guest-artifact';

/** Minimal Turnstile widget handle the dialog owns and hands back to
 *  TimelineBar via a mutable ref. Keeps the widget lifecycle local to
 *  the dialog while letting the submit handler read the latest token. */
export interface GuestTurnstileController {
  /** Returns the latest solved token, or null when none is live. */
  getToken: () => string | null;
  /** Dispose the current token so the next submit requires a fresh solve. */
  reset: () => void;
}
import type {
  CapsuleSnapshotId,
  CapsuleSelectionRange,
  PreparedCapsuleSummary,
  HeldPreparedCapsule,
} from '../../runtime/timeline/capsule-publish-types';
import { timePsFromClientX } from './timeline-track-geometry';
import {
  TRIM_TARGET_BYTES,
  MAX_SEARCH_ITERATIONS,
  FRAME_FALLBACK_SUFFIX,
  TRIM_KEYBOARD_PREPARE_DEBOUNCE_MS,
  TRIM_HANDLE_PULSE_MS,
  TRIM_HANDLE_PULSE_ITERATION_MS,
  TRIM_HANDLE_PULSE_ITERATION_COUNT,
} from './trim-mode-config';

function snapToFrameIndex(frames: ReadonlyArray<{ timePs: number }>, timePs: number): number {
  if (frames.length === 0) return 0;
  if (timePs <= frames[0].timePs) return 0;
  if (timePs >= frames[frames.length - 1].timePs) return frames.length - 1;
  let lo = 0, hi = frames.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (frames[mid].timePs < timePs) lo = mid + 1;
    else hi = mid;
  }
  // `lo` is the first index with timePs >= target — check previous for
  // closeness to the target.
  if (lo > 0 && Math.abs(frames[lo - 1].timePs - timePs) <= Math.abs(frames[lo].timePs - timePs)) {
    return lo - 1;
  }
  return lo;
}

// ── Shared shell ──

interface TimelineShellProps {
  modeRail: React.ReactNode;
  time: string;
  overlay: React.ReactNode;
  track: React.ReactNode;
  action: React.ReactNode;
  className?: string;
}

function TimelineShell({ modeRail, time, overlay, track, action, className = '' }: TimelineShellProps) {
  return (
    <div className={`timeline-bar timeline-shell ${className}`.trim()} role="region" aria-label="Simulation timeline">
      <div className="timeline-shell__left">{modeRail}</div>
      <div className="timeline-shell__center">
        <span className="timeline-time">{time}</span>
        <div className="timeline-track-zone">
          <div className="timeline-overlay-zone">{overlay}</div>
          {track}
        </div>
        <div className="timeline-action-zone">{action}</div>
      </div>
    </div>
  );
}

// ── Action zone (two-slot: clear + unified transfer) ──
//
// Layout: slot A (clear, nearest to track) + slot B (unified transfer trigger).
// Fits within the invariant --tl-action-width (64px) column.
// The transfer trigger opens a tabbed dialog with Download and Share sections —
// one entry point replaces the former stacked publish+export pair.

/** Renders triggers only. Dialogs are siblings rendered by the parent. */
function TimelineActionZone({ showTransfer, onTransfer, showClear, onClear }: {
  showTransfer: boolean;
  onTransfer?: () => void;
  showClear: boolean;
  onClear?: () => void;
}) {
  return (
    <>
      {/* Slot A: clear (nearest to track) */}
      <span className="timeline-action-slot timeline-action-slot--clear">
        {showClear && onClear ? (
          <ClearTrigger onClick={onClear} />
        ) : (
          <span className="timeline-action-spacer" aria-hidden="true" />
        )}
      </span>
      {/* Slot B: unified transfer (download + share) */}
      <span className="timeline-action-slot timeline-action-slot--transfer">
        {showTransfer && onTransfer ? (
          <TransferTrigger onClick={onTransfer} />
        ) : (
          <span className="timeline-action-spacer" aria-hidden="true" />
        )}
      </span>
    </>
  );
}

// ── Top-level ──

export function TimelineBar() {
  const installed = useAppStore((s) => s.timelineInstalled);
  const recordingMode = useAppStore((s) => s.timelineRecordingMode);

  if (!installed) return null;

  if (recordingMode === 'off') return <TimelineBarOff />;
  if (recordingMode === 'ready') return <TimelineBarReady />;
  return <TimelineBarActive />;
}

function TimelineBarOff() {
  const callbacks = useAppStore((s) => s.timelineCallbacks);
  const handleStart = useCallback(() => { callbacks?.onStartRecordingNow(); }, [callbacks]);

  return (
    <TimelineShell
      className="timeline-shell--disabled"
      modeRail={<TimelineModeSwitch mode="off" />}
      time="0.0 fs"
      overlay={
        <ActionHint text={TIMELINE_HINTS.startRecording} anchorClassName="timeline-start-anchor">
          <button className="timeline-action" onClick={handleStart}>Start Recording</button>
        </ActionHint>
      }
      track={<div className="timeline-track timeline-track--thick timeline-track--disabled" />}
      action={<TimelineActionZone showTransfer={false} showClear={false} />}
    />
  );
}

function TimelineBarReady() {
  const callbacks = useAppStore((s) => s.timelineCallbacks);
  const handleTurnOff = useCallback(() => { callbacks?.onTurnRecordingOff(); }, [callbacks]);
  const clear = useClearConfirm(handleTurnOff);

  return (
    <>
      <TimelineShell
        className="timeline-shell--disabled"
        modeRail={<TimelineModeSwitch mode="ready" />}
        time="0.0 fs"
        overlay={<span />}
        track={<div className="timeline-track timeline-track--thick timeline-track--disabled" />}
        action={<TimelineActionZone showTransfer={false} showClear onClear={clear.request} />}
      />
      <TimelineClearDialog open={clear.open} onCancel={clear.cancel} onConfirm={clear.confirm} />
    </>
  );
}

function TimelineBarActive() {
  const mode = useAppStore((s) => s.timelineMode);
  const currentTimePs = useAppStore((s) => s.timelineCurrentTimePs);
  const rangePs = useAppStore((s) => s.timelineRangePs);
  const canReturnToLive = useAppStore((s) => s.timelineCanReturnToLive);
  const canRestart = useAppStore((s) => s.timelineCanRestart);
  const restartTargetPs = useAppStore((s) => s.timelineRestartTargetPs);
  const callbacks = useAppStore((s) => s.timelineCallbacks);
  const exportCaps = useAppStore((s) => s.timelineExportCapabilities);

  // Auth UX (Phase 6) — drives the Share tab's auth gating. We pass the
  // raw `status` through to the dialog so it can render the five ordered
  // Share-panel states — success / checking / unverified / signed-out /
  // signed-in — without re-deriving the discriminator on the rendering side.
  // Keep this list in sync with the priority-ordered branches in
  // timeline-transfer-dialog.tsx's Share panel.
  const authStatus = useAppStore((s) => s.auth.status);
  const authCallbacks = useAppStore((s) => s.authCallbacks);
  const authPopupBlocked = useAppStore((s) => s.authPopupBlocked);
  const guestPublishConfig = useAppStore((s) => s.publicConfig.guestPublish);
  const shareTabOpenRequested = useAppStore((s) => s.shareTabOpenRequested);

  const trackRef = useRef<HTMLDivElement>(null);
  const isDragging = useRef(false);

  const progress = getTimelineProgress(rangePs, currentTimePs);
  const restartProgress = getTimelineProgress(rangePs, restartTargetPs ?? 0);
  const hasRange = rangePs != null && (rangePs.end - rangePs.start) > 0;

  // Export visibility — sole render gate (store capability, not callback presence).
  // Feeds into the unified transfer dialog's Download tab availability.
  const exportAvailable = !!(exportCaps?.full || exportCaps?.capsule);

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

  const handlePointerUp = useCallback(() => { isDragging.current = false; }, []);

  // When a trimmed publish has succeeded, `pendingTrimSuccessRestore`
  // holds the pre-trim review/live state so closeTransfer can restore
  // it before resume. Any user-initiated timeline interaction during
  // that window (before close) means the user is now looking at a
  // different view than the pre-trim state — flipping this flag tells
  // closeTransfer to skip the restore so we don't yank the user back
  // to a frame they just navigated away from.
  const markPostSuccessInteraction = useCallback(() => {
    setPendingTrimSuccessRestore((prev) =>
      prev && !prev.userInteractedAfterSuccess
        ? { ...prev, userInteractedAfterSuccess: true }
        : prev,
    );
  }, []);

  const handleReturnToLive = useCallback(() => {
    markPostSuccessInteraction();
    callbacks?.onReturnToLive();
  }, [callbacks, markPostSuccessInteraction]);
  const handleEnterReview = useCallback(() => {
    markPostSuccessInteraction();
    callbacks?.onEnterReview();
  }, [callbacks, markPostSuccessInteraction]);
  const handleRestart = useCallback(() => {
    markPostSuccessInteraction();
    callbacks?.onRestartFromHere();
  }, [callbacks, markPostSuccessInteraction]);
  const handleTurnOff = useCallback(() => { callbacks?.onTurnRecordingOff(); }, [callbacks]);

  // Clear confirmation
  const clear = useClearConfirm(handleTurnOff);

  // ── Unified transfer dialog (download + share) ──
  //
  // One dialog + one trigger replaces the former separate export and publish
  // dialogs. Both tabs share the pause lifecycle but maintain independent
  // submitting/error/result state so switching tabs does not reset progress.

  const transferDialog = useTransferDialog();
  const [downloadKind, setDownloadKind] = useState<TimelineExportKind>('capsule');
  const [downloadSubmitting, setDownloadSubmitting] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [estimates, setEstimates] = useState<{ capsule?: string | null; full?: string | null }>({});
  const [shareSubmitting, setShareSubmitting] = useState(false);
  // shareError is kind-tagged so the dialog can render each error class in
  // the correct branch without cross-bleed:
  //   - kind: 'auth'  → AuthRequiredError (401 recovery); rendered as the
  //                     signed-out panel's auth-note alongside the OAuth
  //                     buttons.
  //   - kind: 'other' → rate-limit (429), generic publish failures; rendered
  //                     as a red error above the Publish button in the
  //                     signed-in panel.
  // An auth-kind error must NOT render as a generic red error; an other-kind
  // error must NOT render as an auth-note (misleads the user about why
  // sign-in is being asked for). The dialog reads these as two separate
  // props rather than one field + a conditional clear effect.
  const [shareError, setShareError] = useState<
    | { kind: 'auth'; message: string }
    | { kind: 'other'; message: string }
    | { kind: 'age-confirmation'; message: string; policyVersion: string | null }
    | null
  >(null);
  const [shareResult, setShareResult] = useState<ShareResult | null>(null);
  const transferDidPause = useRef(false);

  // ── Trim mode state ──
  //
  // Local to the Transfer session so the persistent timeline state
  // machine is not polluted with export-selection concerns (plan §1).
  // All async results are dropped when `trimRunIdRef.current` differs
  // from the captured runId at dispatch time.
  interface ShareTrimStateLocal {
    active: boolean;
    snapshotId: CapsuleSnapshotId;
    frames: ReadonlyArray<{ frameId: number; timePs: number }>;
    startFrameIndex: number;
    endFrameIndex: number;
    rangeStartPs: number;
    rangeEndPs: number;
    maxSelectableSpanPs: number;
    dragMode: 'start' | 'end' | 'window' | null;
    previewTarget: 'start' | 'end' | null;
    previewingOutsideKept: boolean;
    preparedArtifact: HeldPreparedCapsule | null;
    measuredBytes: number | null;
    safeStatus: 'measuring' | 'within-target' | 'close-to-limit' | 'over-limit' | 'unavailable';
    /** Differentiates the two sources of `safeStatus: 'measuring'`:
     *    'search'  — initial entry-time chunked bisect (up to 16
     *                serializations). User-facing copy: "Finding the
     *                best fit…".
     *    'recheck' — a single prepare triggered by Reset (or any
     *                future single-prepare trigger). User-facing copy:
     *                "Checking selection…". This keeps Reset from
     *                implying the app is re-running the whole search
     *                — plan §9 Reset semantics. */
    measuringKind: 'search' | 'recheck';
    originalActualBytes: number | null;
    maxBytes: number | null;
    maxSource: 'server' | 'client-fallback' | 'unknown';
    prevReviewState: { mode: 'live' | 'review'; reviewTimePs: number | null };
    cachedDefaultStartFrameIndex: number | null;
    runId: number;
    snapshotStale: boolean;
    /** True when the search found no non-empty suffix under the cap
     *  (single-frame selection). Drives the Nothing-Fits branch. */
    nothingFits: boolean;
  }
  const initialShareTrim: ShareTrimStateLocal = {
    active: false,
    snapshotId: '',
    frames: [],
    startFrameIndex: 0,
    endFrameIndex: 0,
    rangeStartPs: 0,
    rangeEndPs: 0,
    maxSelectableSpanPs: 0,
    dragMode: null,
    previewTarget: null,
    previewingOutsideKept: false,
    preparedArtifact: null,
    measuredBytes: null,
    safeStatus: 'measuring',
    measuringKind: 'search',
    originalActualBytes: null,
    maxBytes: null,
    maxSource: 'unknown',
    prevReviewState: { mode: 'live', reviewTimePs: null },
    cachedDefaultStartFrameIndex: null,
    runId: 0,
    snapshotStale: false,
    nothingFits: false,
  };
  const [shareTrimState, setShareTrimState] = useState<ShareTrimStateLocal>(initialShareTrim);
  // Brief attention pulse on the trim handles when the mode opens —
  // the handles live on the main timeline, outside the Share panel,
  // so the user could miss them on first trigger. Pulse for ~1.2 s
  // then auto-clear; reduced-motion users get the static state
  // thanks to the CSS media query.
  const [handlesPulse, setHandlesPulse] = useState(false);
  useEffect(() => {
    if (!shareTrimState.active) { setHandlesPulse(false); return; }
    setHandlesPulse(true);
    const t = setTimeout(() => setHandlesPulse(false), TRIM_HANDLE_PULSE_MS);
    return () => clearTimeout(t);
  }, [shareTrimState.active]);
  const shareTrimStateRef = useRef(shareTrimState);
  // useLayoutEffect (not useEffect): the ref must reflect the latest
  // state BEFORE any subsequent rAF callback runs. scheduleAfterNextPaint
  // schedules rAF+setTimeout(0); in React 18, useEffect fires AFTER
  // paint while rAF fires BEFORE paint of the next frame — so a Reset
  // that queues a microtask which then calls scheduleAfterNextPaint can
  // have its async body see a stale ref and bail out on the runId check,
  // leaving safeStatus stuck at 'measuring'. useLayoutEffect fires
  // synchronously after commit, before paint, so async work scheduled
  // during the same click always observes the latest ref.
  useLayoutEffect(() => { shareTrimStateRef.current = shareTrimState; }, [shareTrimState]);

  // Monotonic run id used by the async default-selection search and by
  // the drag-end measurement. Both compare captured runId vs. current
  // after every await — any mismatch drops the result AND evicts the
  // cache entry via onCancelPreparedPublish.
  const trimRunIdRef = useRef(0);
  // Best prepared artifact held during the default-selection search.
  // Wrapped as HeldPreparedCapsule so we can always prove range
  // identity; the bare PreparedCapsuleSummary never escapes.
  const bestPreparedRef = useRef<HeldPreparedCapsule | null>(null);
  // Cancellers for scheduled trim async work — one for the chunked
  // default-selection search, one for the drag-end debounced prepare.
  const trimSearchCancelRef = useRef<(() => void) | null>(null);
  const trimDragPrepareCancelRef = useRef<(() => void) | null>(null);
  // Share-measuring is the "publish-time prepare in flight" flag from
  // the plan — drives the Preparing… label, the tab-switch disable,
  // and the internal measuring-copy choice.
  const [shareMeasuring, setShareMeasuring] = useState(false);
  // Dedicated error slot for the Nothing-Fits Download Capsule action.
  // Kept separate from `downloadError` (Download tab) and `shareError`
  // (Share panel red error) so the fallback branch can render its own
  // retry affordance without bleeding into the Download tab that isn't
  // visible from the Share trim branch.
  const [shareFallbackDownloadError, setShareFallbackDownloadError] = useState<string | null>(null);
  // Pending restore handoff for post-success close policy (§11).
  const [pendingTrimSuccessRestore, setPendingTrimSuccessRestore] = useState<
    | { prevReviewState: { mode: 'live' | 'review'; reviewTimePs: number | null }; userInteractedAfterSuccess: boolean }
    | null
  >(null);

  // Latest callbacks ref — keeps unmount cleanup current even when callbacks
  // are installed after mount or reinstalled by the subsystem.
  const latestCallbacksRef = useRef(callbacks);
  useEffect(() => { latestCallbacksRef.current = callbacks; }, [callbacks]);

  // Unified pause entry point for the Transfer dialog — wraps the pause
  // callback in a User Timing measure so DevTools Performance can show
  // the main-thread cost of pausing the simulation. Used by BOTH dialog
  // open paths (direct click AND OAuth-return Share resume) so one
  // doesn't silently drift ahead of the other in future refactors.
  // Reads through latestCallbacksRef so the helper stays stable even
  // when the store reinstalls timelineCallbacks mid-session.
  //
  // If onPauseForExport throws, treat it as "did not pause" — the caller
  // then skips the matching resume call on close. The alternative (let
  // the throw propagate) would abort the entire click path: the dialog
  // would never open and the user would see the Transfer button do
  // nothing, with no signal why. Log at warn so the failure is
  // diagnosable; downstream UI stays usable.
  const pauseForTransfer = useCallback(() => {
    return measureSync('transfer-pause', () => {
      try {
        return latestCallbacksRef.current?.onPauseForExport?.() ?? false;
      } catch (err) {
        console.warn('[TimelineBar] onPauseForExport threw; continuing unpaused:', err);
        return false;
      }
    });
  }, []);

  // Preferred default kind — computed at open time, not hook init
  const preferredKind = exportCaps?.capsule ? 'capsule' as const : 'full' as const;

  // Guards — action availability is the single source of truth for
  // "can the user actually do this?". A stored capability (exportCaps) is
  // not enough on its own — the corresponding callback must also be wired.
  // This keeps the dialog honest during callback-wiring transitions and
  // prevents dead tabs (stored artifact exists but no runtime handler).
  const downloadActionAvailable = !!callbacks?.onExportHistory && exportAvailable;
  const shareAvailable = !!callbacks?.onPublishCapsule && hasRange;
  const showTransfer = hasRange && (downloadActionAvailable || shareAvailable);

  // Mounted ref for safe async state updates after dialog close or unmount
  const mountedRef = useRef(true);
  useEffect(() => () => { mountedRef.current = false; }, []);

  // Generation counter for in-flight share publishes.
  //
  // Problem without this: the `showTransfer` auto-close guard (see
  // `useEffect` below) can invoke `closeTransferSession` while a publish
  // is still awaiting `onPublishCapsule`. When the publish resolves, it
  // would land `setShareResult(result)` after state was cleared, leaving
  // a stale shareUrl/warnings visible the next time the dialog opens.
  //
  // Fix: bump the generation on every close; compare after the await and
  // drop the result if the generation moved on.
  const shareRunIdRef = useRef(0);

  // Canonical close helper — resets pause, dialog, and all transient state.
  const closeTransferSession = useCallback(() => {
    // Invalidate any in-flight publish result so late resolutions cannot
    // repaint the dialog with stale data after the user has closed it.
    shareRunIdRef.current++;
    if (transferDidPause.current) {
      callbacks?.onResumeFromExport?.();
      transferDidPause.current = false;
    }
    transferDialog.reset();
    setEstimates({});
    setDownloadSubmitting(false);
    setDownloadError(null);
    setShareSubmitting(false);
    setShareError(null);
    setShareResult(null);
    // Inline trim teardown — avoids a forward reference to the
    // `exitTrimMode` helper defined later in this component. Evict any
    // still-allocated prepareId (search best-known + current prepared
    // artifact) so a close during measurement or between prepare and
    // publish can't leak a cached payload.
    trimRunIdRef.current++;
    if (trimSearchCancelRef.current) { trimSearchCancelRef.current(); trimSearchCancelRef.current = null; }
    if (trimDragPrepareCancelRef.current) { trimDragPrepareCancelRef.current(); trimDragPrepareCancelRef.current = null; }
    const trim = shareTrimStateRef.current;
    const evictCb = callbacks?.onCancelPreparedPublish;
    if (evictCb) {
      if (trim.preparedArtifact) evictCb(trim.preparedArtifact.prepareId);
      if (bestPreparedRef.current) evictCb(bestPreparedRef.current.prepareId);
    }
    bestPreparedRef.current = null;
    setShareMeasuring(false);
    setShareTrimState(initialShareTrim);
    setPendingTrimSuccessRestore(null);
    setShareFallbackDownloadError(null);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [callbacks, transferDialog]);

  // Wrap closeTransferSession with the pre-teardown restore policy.
  // The Transfer dialog has two scenarios where closing must restore a
  // prior timeline view before the inline teardown wipes trim state:
  //
  //   1. **Trim Cancel (Acceptance #13)** — user entered trim from
  //      live or review, may have scrub-previewed a handle frame, and
  //      is now cancelling. The display is in review at a historical
  //      frame; letting onResumeFromExport fire without restoring
  //      would resume live physics against a review-rendered scene.
  //      Restore prevReviewState captured at trim entry.
  //
  //   2. **Post-success restore (§11)** — trimmed publish succeeded,
  //      success branch is showing, user has not manually interacted
  //      with the timeline since. Same risk as above; restore via
  //      pendingTrimSuccessRestore.
  //
  // Post-success takes priority over trim-active — by the time the
  // success branch renders we've already cleared shareTrimState.
  // Priority order is: pending success > trim active > no action.
  const closeTransfer = useCallback(() => {
    const pending = pendingTrimSuccessRestore;
    if (pending) {
      if (!pending.userInteractedAfterSuccess) {
        if (pending.prevReviewState.mode === 'live') {
          callbacks?.onReturnToLive();
        } else if (pending.prevReviewState.reviewTimePs !== null) {
          callbacks?.onScrub(pending.prevReviewState.reviewTimePs);
        }
      }
    } else {
      const trim = shareTrimStateRef.current;
      if (trim.active) {
        if (trim.prevReviewState.mode === 'live') {
          callbacks?.onReturnToLive();
        } else if (trim.prevReviewState.reviewTimePs !== null) {
          callbacks?.onScrub(trim.prevReviewState.reviewTimePs);
        }
      }
    }
    closeTransferSession();
  }, [pendingTrimSuccessRestore, callbacks, closeTransferSession]);

  const openTransfer = useCallback(() => {
    clear.reset();
    setDownloadKind(preferredKind);
    setDownloadSubmitting(false);
    setDownloadError(null);
    setEstimates({});
    setShareSubmitting(false);
    setShareError(null);
    setShareResult(null);
    setShareFallbackDownloadError(null);
    transferDidPause.current = pauseForTransfer();
    // Default to Share tab (Phase 6 Auth UX contract) — the cross-session,
    // higher-value path. Fall back to Download only when Share is not
    // actionable (no publishCapsule callback or no recorded range).
    transferDialog.request(shareAvailable ? 'share' : 'download');
  }, [clear, preferredKind, pauseForTransfer, transferDialog, shareAvailable]);

  const openClear = useCallback(() => {
    // Route through closeTransfer so a trim-active Cancel path
    // restores prevReviewState (Acceptance #13) instead of leaving
    // the display stuck on the last scrub-previewed frame while the
    // Clear dialog opens on top.
    closeTransfer();
    clear.request();
  }, [clear, closeTransfer]);

  // Sign-in handler for the Share tab's auth prompt. Always sets the
  // resume-publish intent so the user lands back on the Share tab after the
  // OAuth round-trip — the store's requestShareTabOpen() will then flip the
  // flag and the effect below will re-open this dialog.
  //
  // No age-intent argument: the runtime fetches the intent JIT and owns
  // the popup-shell-then-fetch-then-navigate sequence (D120 — supersedes
  // D118). The handler MUST stay synchronous (no awaits) so the runtime
  // can open the popup shell inside the live user gesture.
  const handleAuthSignIn = useCallback(
    (provider: 'google' | 'github') => {
      authCallbacks?.onSignIn(provider, { resumePublish: true });
    },
    [authCallbacks],
  );

  // Popup-blocked Retry button: re-issues the same sign-in call that was
  // blocked. The runtime clears the popup-blocked flag at the start of
  // each onSignIn attempt and fetches a fresh age intent JIT — there is
  // no stale-token recovery to perform here.
  const handleRetryPopup = useCallback(() => {
    const pending = authPopupBlocked;
    if (!pending) return;
    authCallbacks?.onSignIn(pending.provider, { resumePublish: pending.resumePublish });
  }, [authPopupBlocked, authCallbacks]);

  // Popup-blocked Continue-in-tab button: explicit user consent to the
  // destructive same-tab redirect. The runtime fetches a fresh intent
  // before navigation.
  const handleContinueInTab = useCallback(() => {
    authCallbacks?.onSignInSameTab();
  }, [authCallbacks]);

  // Popup-blocked Back button: dismiss the pending descriptor so the
  // provider picker re-renders and the user can try a different provider
  // without being forced through Retry or the destructive same-tab path.
  // Delegates to the runtime so the resume-publish sentinel is also
  // cleared when the abandoned flow was a publish-initiated sign-in.
  const handleDismissPopupBlocked = useCallback(() => {
    authCallbacks?.onDismissPopupBlocked();
  }, [authCallbacks]);

  // Resume-publish intent bridge: main.ts sets `shareTabOpenRequested` to
  // true after a successful OAuth return that carried the `?authReturn=1`
  // marker. When the flag is true and Share is actionable, we consume it
  // (atomically clearing it via the store action) and open the Transfer
  // dialog on the Share tab.
  //
  // Why a one-shot boolean (not a monotonic counter): a counter compared
  // against a captured-on-mount ref silently dropped the intent if
  // TimelineBarActive remounted between the producer write and the
  // consumer's first effect run. The store-side consume is idempotent
  // across remounts — the flag stays set until explicitly consumed.
  useEffect(() => {
    if (!shareTabOpenRequested || !shareAvailable) return;
    if (!useAppStore.getState().consumeShareTabOpen()) return;
    setDownloadKind(preferredKind);
    setDownloadSubmitting(false);
    setDownloadError(null);
    setEstimates({});
    setShareSubmitting(false);
    setShareError(null);
    setShareResult(null);
    transferDidPause.current = pauseForTransfer();
    transferDialog.request('share');
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shareTabOpenRequested, shareAvailable]);

  // Async estimate computation — the artifact build + JSON.stringify
  // cost lives behind three guards to keep it off the Transfer-click
  // interaction path:
  //
  // 1. tab === 'download'. Share-first openings (the common path and
  //    the one shown in the INP report) skip the cost entirely.
  // 2. downloadActionAvailable. Stored capability alone is not enough;
  //    the runtime callback must also be wired.
  // 3. Success cache: skip if a prior run in THIS open already produced
  //    at least one usable size string. Failed runs (both fields null)
  //    are NOT cached — tab switching retries, which covers transient
  //    failures without locking the user out of a valid estimate for
  //    the whole session. Close+reopen always clears both cases via
  //    openTransfer() / closeTransferSession()'s setEstimates({}).
  //
  // Scheduling goes through scheduleAfterNextPaint so the dialog gets
  // a paint opportunity before the expensive work runs — microtask
  // queues (Promise.resolve) are not sufficient for INP because they
  // can still run before paint.
  //
  // Callback read through latestCallbacksRef (not a captured `callbacks`
  // closure) so the effect does not rerun when the store reinstalls
  // timelineCallbacks. The `cancelled` flag is LOAD-BEARING: once the
  // rAF has fired, cancelAnimationFrame is a no-op and this flag is the
  // only thing preventing a stale setState after unmount or dialog
  // close. Do not remove it in a future refactor.
  useEffect(() => {
    if (!transferDialog.open) return;
    if (transferDialog.tab !== 'download') return;
    if (!downloadActionAvailable) return;
    const hasSuccessfulEstimate =
      typeof estimates.capsule === 'string' || typeof estimates.full === 'string';
    if (hasSuccessfulEstimate) return;

    let cancelled = false;
    const cancelSchedule = scheduleAfterNextPaint(() => {
      if (cancelled) return;
      try {
        const result = measureSync('export-estimate', () =>
          latestCallbacksRef.current?.getExportEstimates?.() ?? { capsule: null, full: null },
        );
        if (!cancelled) setEstimates(result);
      } catch (err) {
        console.warn('[TimelineBar] estimate computation failed:', err);
        if (!cancelled) setEstimates({ capsule: null, full: null });
      }
    });

    return () => {
      cancelled = true;
      cancelSchedule();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [transferDialog.open, transferDialog.tab, downloadActionAvailable]);

  // Cleanup: resume on unmount if transfer caused pause.
  // Uses latestCallbacksRef so cleanup calls the current handler even if
  // callbacks were installed after mount or reinstalled.
  useEffect(() => {
    return () => {
      if (transferDidPause.current) {
        latestCallbacksRef.current?.onResumeFromExport?.();
      }
    };
  }, []);

  const handleDownloadConfirm = useCallback(async () => {
    if (!callbacks?.onExportHistory) {
      setDownloadError('Download is not available right now.');
      return;
    }
    setDownloadSubmitting(true);
    setDownloadError(null);
    try {
      const result = await callbacks.onExportHistory(downloadKind);
      if (!mountedRef.current) return;
      if (result === 'saved') {
        // Route through closeTransfer so if trim mode happened to be
        // active while the user switched to Download and saved, the
        // trim preview-frame is restored to the pre-trim view.
        closeTransfer();
      } else if (result === 'picker-cancelled') {
        setDownloadSubmitting(false);
        // keep dialog open, keep paused, keep estimates
      }
    } catch (e) {
      console.error('[TimelineBar] download failed:', e);
      if (mountedRef.current) {
        setDownloadError(e instanceof Error ? e.message : 'Download failed.');
        setDownloadSubmitting(false);
      }
    }
  }, [callbacks, downloadKind, closeTransfer]);

  // ── Guest Quick Share wiring ──
  //
  // The Turnstile widget lives inside the Transfer dialog (signed-out
  // Share panel only — rendered when `publicConfig.guestPublish.enabled`
  // + a non-null `turnstileSiteKey`). The dialog owns the widget
  // lifecycle and surfaces a controller ref that TimelineBar reads
  // from at submit time.
  const guestTurnstileControllerRef = useRef<GuestTurnstileController | null>(null);

  const handleConfirmGuestShare = useCallback(async () => {
    if (!callbacks?.onConfirmGuestShare) {
      setShareError({ kind: 'other', message: 'Quick Share is not available right now.' });
      return;
    }
    const token = guestTurnstileControllerRef.current?.getToken?.() ?? null;
    if (!token) {
      setShareError({
        kind: 'other',
        message: 'Verification required. Please solve the challenge above.',
      });
      return;
    }
    const runId = ++shareRunIdRef.current;
    setShareSubmitting(true);
    setShareError(null);
    try {
      const result = await callbacks.onConfirmGuestShare(token);
      if (!mountedRef.current || shareRunIdRef.current !== runId) return;
      setShareResult(result);
      setShareSubmitting(false);
    } catch (e) {
      if (!mountedRef.current || shareRunIdRef.current !== runId) return;
      // Guest-specific error mapping — see §TimelineBar Ownership.
      if (e instanceof GuestTurnstileError) {
        // Invalidate the token on failed/unavailable Siteverify so the
        // user is not allowed to resubmit with the same stale bytes.
        guestTurnstileControllerRef.current?.reset?.();
        setShareError({ kind: 'other', message: e.message });
        setShareSubmitting(false);
        return;
      }
      if (e instanceof GuestAgeAttestationError) {
        setShareError({ kind: 'other', message: e.message });
        setShareSubmitting(false);
        return;
      }
      if (e instanceof GuestQuotaExceededError) {
        setShareError({ kind: 'other', message: e.message });
        setShareSubmitting(false);
        return;
      }
      if (e instanceof GuestPublishDisabledError) {
        setShareError({ kind: 'other', message: e.message });
        setShareSubmitting(false);
        return;
      }
      if (isPublishOversizeError(e)) {
        // Guest path does not support trim in v1 — surface the sign-in
        // upsell helper copy rather than routing into trim mode.
        setShareError({
          kind: 'other',
          message: 'Capture exceeds 20 MB. Trim is available after sign-in.',
        });
        setShareSubmitting(false);
        return;
      }
      console.error('[TimelineBar] guest share failed:', e);
      setShareError({
        kind: 'other',
        message: e instanceof Error ? e.message : 'Share failed.',
      });
      setShareSubmitting(false);
    }
  }, [callbacks]);

  const handleShareConfirm = useCallback(async () => {
    if (!callbacks?.onPublishCapsule) {
      setShareError({ kind: 'other', message: 'Share is not available right now.' });
      return;
    }
    // Capture the generation at submit time. If closeTransferSession
    // runs while this await is pending, the generation moves and we
    // drop the late result — the dialog has been torn down.
    const runId = ++shareRunIdRef.current;
    setShareSubmitting(true);
    setShareError(null);
    try {
      const result = await callbacks.onPublishCapsule();
      if (!mountedRef.current || shareRunIdRef.current !== runId) return;
      setShareResult(result);
      setShareSubmitting(false);
    } catch (e) {
      if (!mountedRef.current || shareRunIdRef.current !== runId) return;
      if (isPublishOversizeError(e)) {
        // Capsule too large — enter trim mode. Frames are captured
        // from getCapsuleFrameIndex at entry; failure to capture (no
        // frames or capsule gated off) falls through to the generic
        // error branch so the user isn't stranded in a half-rendered
        // trim UI with no data.
        const entered = enterTrimMode(e);
        setShareSubmitting(false);
        if (!entered) {
          setShareError({
            kind: 'other',
            message: e instanceof Error ? e.message : 'Share failed.',
          });
        }
        return;
      }
      if (e instanceof AuthRequiredError) {
        // 401 from publish is an authoritative signed-out answer — flip
        // the store so the Share panel re-renders the in-context prompt.
        // The message is tagged as 'auth' so the dialog routes it into the
        // signed-out auth-note slot (not the red-error slot).
        useAppStore.getState().setAuthSignedOut();
        setShareError({ kind: 'auth', message: e.message });
        setShareSubmitting(false);
        return;
      }
      if (e instanceof AgeConfirmationRequiredError) {
        // 428 — user is signed in but has no age_13_plus acceptance row
        // (legacy / pre-D120 account). Surface the publish-clickwrap
        // fallback inline; the dialog's single Publish button POSTs to
        // /api/account/age-confirmation (shared helper) and triggers a
        // re-publish via the passed-through retryShare callback.
        setShareError({
          kind: 'age-confirmation',
          message: e.message,
          policyVersion: e.policyVersion,
        });
        setShareSubmitting(false);
        return;
      }
      console.error('[TimelineBar] share failed:', e);
      setShareError({
        kind: 'other',
        message: e instanceof Error ? e.message : 'Share failed.',
      });
      setShareSubmitting(false);
    }
  }, [callbacks]);

  // ── Trim-mode machinery ──

  const cancelPreparedRef = useRef<((id: string) => void) | null>(null);
  useEffect(() => {
    cancelPreparedRef.current = callbacks?.onCancelPreparedPublish ?? null;
  }, [callbacks]);

  const clampTrimRange = useCallback((
    startIdx: number,
    endIdx: number,
    frames: ReadonlyArray<{ frameId: number; timePs: number }>,
    maxSpanPs: number,
  ): { startFrameIndex: number; endFrameIndex: number; rangeStartPs: number; rangeEndPs: number } => {
    const n = frames.length;
    const s = Math.max(0, Math.min(startIdx, n - 1));
    const e = Math.max(s, Math.min(endIdx, n - 1));
    let startFrame = s;
    let endFrame = e;
    const width = frames[endFrame].timePs - frames[startFrame].timePs;
    if (maxSpanPs > 0 && width > maxSpanPs) {
      // Shrink the longer end toward the shorter. Edge-drag callers
      // should already have clamped against maxSpanPs; this is a
      // defensive pass after window-drag.
      // Prefer contracting the start (newest-kept policy).
      while (startFrame < endFrame && frames[endFrame].timePs - frames[startFrame].timePs > maxSpanPs) {
        startFrame++;
      }
    }
    return {
      startFrameIndex: startFrame,
      endFrameIndex: endFrame,
      rangeStartPs: frames[startFrame].timePs,
      rangeEndPs: frames[endFrame].timePs,
    };
  }, []);

  const cancelPrepared = useCallback((prepareId: string | null | undefined) => {
    if (!prepareId) return;
    const cb = cancelPreparedRef.current;
    if (cb) cb(prepareId);
  }, []);

  const cancelInFlightTrimSearch = useCallback(() => {
    if (trimSearchCancelRef.current) {
      trimSearchCancelRef.current();
      trimSearchCancelRef.current = null;
    }
    if (bestPreparedRef.current) {
      cancelPrepared(bestPreparedRef.current.prepareId);
      bestPreparedRef.current = null;
    }
  }, [cancelPrepared]);

  const cancelInFlightTrimDragPrepare = useCallback(() => {
    if (trimDragPrepareCancelRef.current) {
      trimDragPrepareCancelRef.current();
      trimDragPrepareCancelRef.current = null;
    }
  }, []);

  /** Compute the next safeStatus bucket for a measured byte size. */
  const classifySafeStatus = useCallback((
    bytes: number,
    effectiveHardCap: number,
  ): 'within-target' | 'close-to-limit' | 'over-limit' => {
    if (bytes > effectiveHardCap) return 'over-limit';
    if (bytes > TRIM_TARGET_BYTES) return 'close-to-limit';
    return 'within-target';
  }, []);

  /** Gated-idempotent patcher for ShareTrimStateLocal.
   *
   *  Repeated six+ times across the async paths: apply `patch` only
   *  if the session is still active AND the captured `runId` still
   *  matches the current run. A mismatch means a Cancel / Reset /
   *  Exit already bumped the runId, and a late async completion
   *  must not overwrite the next session's state. Dropping the
   *  patch here costs nothing (the original source already
   *  evicted any held prepareId). */
  const patchActiveTrim = useCallback((runId: number, patch: Partial<ShareTrimStateLocal>) => {
    setShareTrimState((prev) =>
      prev.active && prev.runId === runId ? { ...prev, ...patch } : prev,
    );
  }, []);

  /** Clear a previously-surfaced measurement error after a prepare
   *  finally succeeds. Otherwise a drag-throw → drag-succeed sequence
   *  shows a stale "Measurement failed: …" red banner next to a valid
   *  green "Within limit" size row — contradictory state.
   *  Narrowly scoped to `kind: 'other'` errors whose message begins
   *  with "Measurement failed:" so we don't accidentally clear 429
   *  quota errors, auth errors, or age-confirmation errors that came
   *  from different code paths. */
  const clearMeasurementErrorIfPresent = useCallback(() => {
    setShareError((prev) => {
      if (prev && prev.kind === 'other' && prev.message.startsWith('Measurement failed')) {
        return null;
      }
      return prev;
    });
  }, []);

  const abortSearchSnapshotStale = useCallback((runId: number) => {
    if (runId !== trimRunIdRef.current) return;
    cancelInFlightTrimSearch();
    cancelInFlightTrimDragPrepare();
    trimRunIdRef.current++;
    let toCancel: string | null = null;
    setShareTrimState((prev) => {
      if (!prev.active) return prev;
      if (prev.preparedArtifact) toCancel = prev.preparedArtifact.prepareId;
      return {
        ...prev,
        preparedArtifact: null,
        safeStatus: 'unavailable',
        snapshotStale: true,
      };
    });
    if (toCancel) cancelPrepared(toCancel);
  }, [cancelInFlightTrimSearch, cancelInFlightTrimDragPrepare, cancelPrepared]);

  /** Chunked suffix search — one prepare per scheduled tick.
   *  Bisects dense-frame start indices for the widest suffix that
   *  serializes under TRIM_TARGET_BYTES. Honors runId cancellation
   *  both before and after every await. */
  const scheduleDefaultSelectionSearch = useCallback((
    runId: number,
    snapshotId: CapsuleSnapshotId,
    frames: ReadonlyArray<{ frameId: number; timePs: number }>,
    endFrameIndex: number,
  ) => {
    const n = frames.length;
    const prepare = callbacks?.onPrepareCapsulePublish;
    if (!prepare) {
      patchActiveTrim(runId, { safeStatus: 'unavailable' });
      return;
    }
    let lo = 0;
    let hi = endFrameIndex; // inclusive
    let bestStart: number | null = null;
    let iterations = 0;

    const scheduleNext = () => {
      trimSearchCancelRef.current = scheduleAfterNextPaint(async () => {
        if (runId !== trimRunIdRef.current) return;
        if (lo > hi || iterations >= MAX_SEARCH_ITERATIONS) {
          finalize();
          return;
        }
        iterations++;
        const mid = (lo + hi) >>> 1;
        const candidateRange: CapsuleSelectionRange = {
          snapshotId,
          startFrameIndex: mid,
          endFrameIndex,
        };
        let summary: PreparedCapsuleSummary;
        try {
          summary = await prepare(candidateRange);
        } catch (err) {
          if (isCapsuleSnapshotStaleError(err)) {
            abortSearchSnapshotStale(runId);
            return;
          }
          console.warn('[trim] default-selection prepare failed:', err);
          // A prior iteration may have produced a best-so-far whose
          // prepareId is still held in `bestPreparedRef`. Evict it
          // here so the cached JSON doesn't survive past the
          // aborted search — next Cancel / Reset / close-after-exit
          // would otherwise log a stray cancel for it, and the
          // publisher cache could retain the payload until its
          // bound kicks in.
          if (bestPreparedRef.current) {
            cancelPrepared(bestPreparedRef.current.prepareId);
            bestPreparedRef.current = null;
          }
          patchActiveTrim(runId, { safeStatus: 'unavailable' });
          // Distinguish "prepare call threw" from "measurement
          // yielded no fit" — the status row's `'unavailable'` copy
          // ("Couldn't measure. Drag the handles to adjust.") alone
          // is indistinguishable between the two. Surface a red
          // error explicitly so the user knows to retry, not to
          // keep adjusting.
          setShareError({
            kind: 'other',
            message: err instanceof Error
              ? `Measurement failed: ${err.message}`
              : 'Measurement failed — try again.',
          });
          return;
        }
        if (runId !== trimRunIdRef.current) {
          cancelPrepared(summary.prepareId);
          return;
        }
        const held: HeldPreparedCapsule = { ...summary, range: candidateRange };
        if (held.bytes <= TRIM_TARGET_BYTES) {
          // Fits — this is a new best; try earlier (wider suffix).
          const prev = bestPreparedRef.current;
          bestPreparedRef.current = held;
          if (prev) cancelPrepared(prev.prepareId);
          bestStart = mid;
          hi = mid - 1;
        } else {
          // Does not fit — must start later (narrower suffix).
          cancelPrepared(held.prepareId);
          lo = mid + 1;
        }
        if (lo > hi || iterations >= MAX_SEARCH_ITERATIONS) {
          finalize();
        } else {
          scheduleNext();
        }
      });
    };

    const finalize = () => {
      if (runId !== trimRunIdRef.current) return;
      trimSearchCancelRef.current = null;
      const best = bestPreparedRef.current;
      if (!best) {
        // Nothing fits — check if even a single-frame end serializes.
        // Run one more prepare for the single-frame case to confirm.
        (async () => {
          try {
            const singleRange: CapsuleSelectionRange = {
              snapshotId,
              startFrameIndex: endFrameIndex,
              endFrameIndex,
            };
            const summary = await prepare(singleRange);
            if (runId !== trimRunIdRef.current) {
              cancelPrepared(summary.prepareId);
              return;
            }
            const held: HeldPreparedCapsule = { ...summary, range: singleRange };
            const status = classifySafeStatus(held.bytes, MAX_PUBLISH_BYTES);
            const nothingFits = status === 'over-limit';
            // If even the single-frame case exceeds the cap, we still
            // keep a prepared artifact so the user can inspect the
            // measurement but publish is disabled.
            setShareTrimState((prev) => {
              if (!prev.active || prev.runId !== runId) return prev;
              return {
                ...prev,
                startFrameIndex: endFrameIndex,
                endFrameIndex,
                rangeStartPs: frames[endFrameIndex].timePs,
                rangeEndPs: frames[endFrameIndex].timePs,
                maxSelectableSpanPs: 0,
                measuredBytes: held.bytes,
                preparedArtifact: held,
                safeStatus: status,
                nothingFits,
                cachedDefaultStartFrameIndex: endFrameIndex,
              };
            });
            clearMeasurementErrorIfPresent();
          } catch (err) {
            if (isCapsuleSnapshotStaleError(err)) {
              abortSearchSnapshotStale(runId);
              return;
            }
            console.warn('[trim] nothing-fits fallback prepare failed:', err);
            patchActiveTrim(runId, { safeStatus: 'unavailable' });
            setShareError({
              kind: 'other',
              message: err instanceof Error
                ? `Measurement failed: ${err.message}`
                : 'Measurement failed — try again.',
            });
          }
        })();
        return;
      }
      // Best suffix found — commit.
      const startIdx = bestStart ?? best.range.startFrameIndex;
      setShareTrimState((prev) => {
        if (!prev.active || prev.runId !== runId) return prev;
        const spanPs = frames[endFrameIndex].timePs - frames[startIdx].timePs;
        return {
          ...prev,
          startFrameIndex: startIdx,
          endFrameIndex,
          rangeStartPs: frames[startIdx].timePs,
          rangeEndPs: frames[endFrameIndex].timePs,
          maxSelectableSpanPs: spanPs,
          measuredBytes: best.bytes,
          preparedArtifact: best,
          safeStatus: classifySafeStatus(best.bytes, MAX_PUBLISH_BYTES),
          cachedDefaultStartFrameIndex: startIdx,
          nothingFits: false,
        };
      });
      bestPreparedRef.current = null;
      clearMeasurementErrorIfPresent();
    };

    scheduleNext();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [callbacks, abortSearchSnapshotStale, cancelPrepared, classifySafeStatus]);

  const enterTrimMode = useCallback((error: PublishOversizeError) => {
    const frameIndex = callbacks?.getCapsuleFrameIndex?.();
    if (!frameIndex || frameIndex.frames.length === 0) {
      // Not viable for trim mode — fall through to generic error.
      return false;
    }
    // Cancel any existing trim work and capture prevReviewState.
    cancelInFlightTrimSearch();
    cancelInFlightTrimDragPrepare();
    const runId = ++trimRunIdRef.current;
    const timelineState = useAppStore.getState();
    const prevReviewState = {
      mode: (timelineState.timelineMode === 'review' ? 'review' : 'live') as 'live' | 'review',
      reviewTimePs:
        timelineState.timelineMode === 'review' && timelineState.timelineCurrentTimePs != null
          ? timelineState.timelineCurrentTimePs
          : null,
    };
    const frames = frameIndex.frames;
    const endFrameIndex = frames.length - 1;
    const fallbackStart = Math.max(0, endFrameIndex - (FRAME_FALLBACK_SUFFIX - 1));
    // Derive maxSource from the error's provenance, not just whether
    // maxBytes is non-null:
    //   · preflight: the client already decided to reject against
    //     MAX_PUBLISH_BYTES — render as client-fallback since the
    //     client IS the source of truth for its own preflight check.
    //   · 413 with parsed maxBytes: server confirmed the cap — 'server'.
    //   · 413 without parsed maxBytes: server rejected but gave no
    //     trustworthy limit. Rendering MAX_PUBLISH_BYTES here with a
    //     'client-fallback' label would assert a limit the client has
    //     no authority for under deploy skew. Render 'unknown' (no
    //     denominator) instead — the effectiveHardCap gate still
    //     enforces MAX_PUBLISH_BYTES internally.
    const errorMaxBytes = error.maxBytes;
    let maxSource: 'server' | 'client-fallback' | 'unknown';
    let maxBytes: number | null;
    if (error.source === 'preflight') {
      maxSource = 'client-fallback';
      maxBytes = MAX_PUBLISH_BYTES;
    } else if (errorMaxBytes !== null) {
      maxSource = 'server';
      maxBytes = errorMaxBytes;
    } else {
      maxSource = 'unknown';
      maxBytes = null;
    }
    const next: ShareTrimStateLocal = {
      active: true,
      snapshotId: frameIndex.snapshotId,
      frames,
      startFrameIndex: fallbackStart,
      endFrameIndex,
      rangeStartPs: frames[fallbackStart].timePs,
      rangeEndPs: frames[endFrameIndex].timePs,
      maxSelectableSpanPs: frames[endFrameIndex].timePs - frames[fallbackStart].timePs,
      dragMode: null,
      previewTarget: null,
      previewingOutsideKept: false,
      preparedArtifact: null,
      measuredBytes: null,
      safeStatus: 'measuring',
      measuringKind: 'search',
      originalActualBytes: error.actualBytes,
      maxBytes,
      maxSource,
      prevReviewState,
      cachedDefaultStartFrameIndex: null,
      runId,
      snapshotStale: false,
      nothingFits: false,
    };
    setShareTrimState(next);
    // Kick off the chunked suffix search off the click path.
    scheduleDefaultSelectionSearch(runId, frameIndex.snapshotId, frames, endFrameIndex);
    return true;
  }, [callbacks, cancelInFlightTrimSearch, cancelInFlightTrimDragPrepare, scheduleDefaultSelectionSearch]);

  // Trim teardown lives in two places intentionally:
  //   · `closeTransferSession` (above) owns the inline teardown —
  //     cancels in-flight search / drag prepare, evicts any held
  //     prepareId, resets `shareTrimState`, clears `shareMeasuring`.
  //     Defined BEFORE the trim machinery helpers so it can be called
  //     as an onCancel prop / from effects without a forward-reference
  //     TDZ hazard.
  //   · `closeTransfer` (above) wraps `closeTransferSession` with the
  //     restore policy: if pendingTrimSuccessRestore or
  //     shareTrimStateRef.current.active is set, fire the prior
  //     live/review callback BEFORE the inline teardown runs (so the
  //     subsequent onResumeFromExport sees the correct mode — Risk 3).
  //
  // An earlier `exitTrimMode({ restore: true })` helper existed here
  // but became dead once all close paths routed through closeTransfer.
  // Intentionally removed to prevent two-lifecycle drift: a future
  // contributor fixing one path and missing the duplicate.

  // Preview the frame at the given edge (start or end), entering review
  // if necessary — routed through callbacks.onScrub which the
  // coordinator decides how to handle.
  const previewAtTimePs = useCallback((timePs: number) => {
    callbacks?.onScrub(timePs);
  }, [callbacks]);

  const handleResetShareTrim = useCallback(() => {
    // Read pre-Reset state from the ref (synced via useLayoutEffect,
    // so it reflects the latest committed state at click time). We
    // can't read it inside the setShareTrimState updater because in
    // React 18 the updater may not execute synchronously — any
    // post-setState variable reads would land stale.
    const pre = shareTrimStateRef.current;
    if (!pre.active || pre.frames.length === 0) return;
    const frames = pre.frames;
    const endIdx = frames.length - 1;
    const startIdx = pre.cachedDefaultStartFrameIndex ?? Math.max(0, endIdx - (FRAME_FALLBACK_SUFFIX - 1));

    // Bump the runId + cancel in-flight drag prepare so any concurrent
    // drag-end completion with the pre-reset runId is dropped by its
    // own post-await runId check.
    trimRunIdRef.current++;
    cancelInFlightTrimDragPrepare();
    const runId = trimRunIdRef.current;

    // Evict any prior prepared artifact synchronously — the ref gave
    // us the committed value, so this is not racy against a concurrent
    // drag-end setState.
    if (pre.preparedArtifact) cancelPrepared(pre.preparedArtifact.prepareId);

    setShareTrimState((prev) => {
      if (!prev.active) return prev;
      // Re-check the prior artifact in case a drag-end commit landed
      // between the ref read above and this updater (idempotent cancel).
      if (prev.preparedArtifact) cancelPrepared(prev.preparedArtifact.prepareId);
      const f = prev.frames;
      return {
        ...prev,
        startFrameIndex: startIdx,
        endFrameIndex: endIdx,
        rangeStartPs: f[startIdx].timePs,
        rangeEndPs: f[endIdx].timePs,
        maxSelectableSpanPs: f[endIdx].timePs - f[startIdx].timePs,
        safeStatus: 'measuring',
        // Reset fires a single prepare against the cached default,
        // not the entry-time chunked bisect. The status row renders
        // "Checking selection…" instead of "Finding the best fit…"
        // so users don't assume the app is redoing the full search.
        measuringKind: 'recheck',
        preparedArtifact: null,
        measuredBytes: null,
        previewingOutsideKept: false,
        runId,
        dragMode: null,
        previewTarget: null,
      };
    });

    // Visible feedback: scrub the molecule view to the restored end
    // edge so the click has an immediate on-screen effect. Without
    // this the user may not notice anything happened when the reset
    // size matches what's already displayed — the status row just
    // flips to a brief "Checking selection…" which is easy to miss.
    // `endIdx` is the right-anchored edge (plan §Default Selection),
    // and matches the preview contract for whole-region and end-drag
    // moves (plan §Live Preview Rule).
    previewAtTimePs(frames[endIdx].timePs);

    // Issue the prepare after the setter commits. `debouncedPrepareAfterEdit`
    // is resolved at call time (TDZ-safe) since this only runs on user
    // action, after all other top-level bindings are defined.
    queueMicrotask(() => debouncedPrepareAfterEdit(runId, { startFrameIndex: startIdx, endFrameIndex: endIdx }));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cancelPrepared, cancelInFlightTrimDragPrepare]);

  /** Debounced prepare after a drag-end / keyboard-commit. Evicts any
   *  prior prepared artifact, then issues a single prepare for the
   *  current selection. runId gate drops stale completions. */
  const debouncedPrepareAfterEdit = useCallback((runId: number, selection: { startFrameIndex: number; endFrameIndex: number }) => {
    if (trimDragPrepareCancelRef.current) {
      trimDragPrepareCancelRef.current();
      trimDragPrepareCancelRef.current = null;
    }
    const prepare = callbacks?.onPrepareCapsulePublish;
    if (!prepare) return;
    trimDragPrepareCancelRef.current = scheduleAfterNextPaint(async () => {
      if (runId !== trimRunIdRef.current) return;
      const current = shareTrimStateRef.current;
      // `trimRunIdRef` is the authoritative staleness signal; do NOT
      // additionally gate on `current.runId !== runId` here. That check
      // is a false-positive trap: the ref sync runs via useLayoutEffect
      // but any lingering ordering quirk would strand the measurement
      // at 'measuring' forever — we only need to confirm trim mode is
      // still open, which `current.active` expresses precisely.
      if (!current.active) return;
      const range: CapsuleSelectionRange = {
        snapshotId: current.snapshotId,
        startFrameIndex: selection.startFrameIndex,
        endFrameIndex: selection.endFrameIndex,
      };
      let summary: PreparedCapsuleSummary;
      try {
        summary = await prepare(range);
      } catch (err) {
        if (isCapsuleSnapshotStaleError(err)) {
          abortSearchSnapshotStale(runId);
          return;
        }
        console.warn('[trim] drag-end prepare failed:', err);
        patchActiveTrim(runId, { safeStatus: 'unavailable' });
        // Same rationale as the default-selection search: the
        // "Couldn't measure" copy reads as a range problem rather
        // than a network/server problem. Surface the error class
        // explicitly so the user reaches for "try again" instead of
        // "drag some more".
        setShareError({
          kind: 'other',
          message: err instanceof Error
            ? `Measurement failed: ${err.message}`
            : 'Measurement failed — try again.',
        });
        return;
      }
      if (runId !== trimRunIdRef.current) {
        cancelPrepared(summary.prepareId);
        return;
      }
      const held: HeldPreparedCapsule = { ...summary, range };
      // Decide whether this result will actually commit BEFORE scheduling
      // the setState — `setShareTrimState`'s updater does NOT run
      // synchronously in React 18, so a closure-assignment inside it
      // cannot be read by follow-up code in this turn. The ref is
      // kept in sync via useLayoutEffect and — because we're past the
      // `await` boundary — reflects the latest committed state.
      const refSnapshot = shareTrimStateRef.current;
      const willCommit =
        refSnapshot.active
        && refSnapshot.snapshotId === held.range.snapshotId
        && refSnapshot.startFrameIndex === held.range.startFrameIndex
        && refSnapshot.endFrameIndex === held.range.endFrameIndex;
      if (!willCommit) {
        cancelPrepared(held.prepareId);
        return;
      }
      setShareTrimState((prev) => {
        // Same rule as the outer guard: `runId !== trimRunIdRef.current`
        // (checked above) is the authoritative staleness signal.
        if (!prev.active) {
          cancelPrepared(held.prepareId);
          return prev;
        }
        // Re-check range consistency defensively: the ref snapshot
        // above reflects commits up to the await boundary, but another
        // microtask-queued setState could have landed in between. Drop
        // the result rather than overwriting the displayed size/status
        // with a measurement for a range the user is no longer on.
        const rangeStillCurrent =
          prev.snapshotId === held.range.snapshotId
          && prev.startFrameIndex === held.range.startFrameIndex
          && prev.endFrameIndex === held.range.endFrameIndex;
        if (!rangeStillCurrent) {
          cancelPrepared(held.prepareId);
          return prev;
        }
        // Evict any prior preparedArtifact — the selection changed.
        if (prev.preparedArtifact && prev.preparedArtifact.prepareId !== held.prepareId) {
          cancelPrepared(prev.preparedArtifact.prepareId);
        }
        return {
          ...prev,
          preparedArtifact: held,
          measuredBytes: held.bytes,
          safeStatus: classifySafeStatus(held.bytes, MAX_PUBLISH_BYTES),
        };
      });
      clearMeasurementErrorIfPresent();
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [callbacks, cancelPrepared, classifySafeStatus, abortSearchSnapshotStale]);

  const handleConfirmShareTrim = useCallback(async () => {
    if (shareMeasuring || shareSubmitting) return; // no-op second click
    const prepare = callbacks?.onPrepareCapsulePublish;
    const publishPrepared = callbacks?.onPublishPreparedCapsule;
    if (!prepare || !publishPrepared) {
      setShareError({ kind: 'other', message: 'Share is not available right now.' });
      return;
    }
    const captured = shareTrimStateRef.current;
    if (!captured.active || captured.snapshotStale) return;

    // Phase 1 — Prepare (if not already prepared for current selection).
    const currentRange: CapsuleSelectionRange = {
      snapshotId: captured.snapshotId,
      startFrameIndex: captured.startFrameIndex,
      endFrameIndex: captured.endFrameIndex,
    };
    const runId = trimRunIdRef.current;

    let held: HeldPreparedCapsule | null = null;
    const existing = captured.preparedArtifact;
    const reusable = existing
      && existing.range.snapshotId === currentRange.snapshotId
      && existing.range.startFrameIndex === currentRange.startFrameIndex
      && existing.range.endFrameIndex === currentRange.endFrameIndex;
    if (reusable && existing) {
      held = existing;
    } else {
      if (existing) cancelPrepared(existing.prepareId);
      setShareMeasuring(true);
      try {
        const summary = await prepare(currentRange);
        if (runId !== trimRunIdRef.current) {
          cancelPrepared(summary.prepareId);
          setShareMeasuring(false);
          return;
        }
        // Range-consistency check happens BEFORE we commit any
        // measurement to state. If the user edited the selection while
        // this prepare was in flight, writing `measuredBytes: summary.bytes`
        // into state — even momentarily — flashes the wrong size on
        // the status row (the newer drag-end prepare hasn't landed yet,
        // but we've already overwritten 'measuring' with a stale
        // number). Cancel the prepareId, leave the row in 'measuring'
        // for the newer prepare to own, and bail without POSTing.
        const latest = shareTrimStateRef.current;
        const stillCurrent = latest.active
          && latest.snapshotId === currentRange.snapshotId
          && latest.startFrameIndex === currentRange.startFrameIndex
          && latest.endFrameIndex === currentRange.endFrameIndex;
        if (!stillCurrent) {
          cancelPrepared(summary.prepareId);
          setShareMeasuring(false);
          return;
        }
        held = { ...summary, range: currentRange };
        // Safe to commit — the range is still what the user sees.
        patchActiveTrim(runId, {
          preparedArtifact: held,
          measuredBytes: held.bytes,
        });
        // Phase-1 prepare succeeded; any prior "Measurement failed"
        // banner from a transient earlier attempt is now stale.
        clearMeasurementErrorIfPresent();
      } catch (err) {
        setShareMeasuring(false);
        if (isCapsuleSnapshotStaleError(err)) {
          abortSearchSnapshotStale(runId);
          return;
        }
        console.error('[trim] publish prepare failed:', err);
        setShareError({
          kind: 'other',
          message: err instanceof Error ? err.message : 'Share failed.',
        });
        return;
      }
    }

    // Second range-check just before Phase 3 submit: even if the
    // reused-path held artifact was current at click time, state could
    // have shifted between the reuse decision and this point. Cheap
    // invariant — if mismatched, do not POST.
    const latestBeforeSubmit = shareTrimStateRef.current;
    const stillCurrent = latestBeforeSubmit.active
      && latestBeforeSubmit.snapshotId === held.range.snapshotId
      && latestBeforeSubmit.startFrameIndex === held.range.startFrameIndex
      && latestBeforeSubmit.endFrameIndex === held.range.endFrameIndex;
    if (!stillCurrent) {
      cancelPrepared(held.prepareId);
      setShareMeasuring(false);
      // Clear the held reference from state if it's still the same
      // prepareId so a subsequent click doesn't try to reuse it.
      setShareTrimState((prev) => {
        if (!prev.active) return prev;
        if (prev.preparedArtifact?.prepareId === held!.prepareId) {
          return { ...prev, preparedArtifact: null };
        }
        return prev;
      });
      return;
    }

    // Phase 2 — Decide.
    const effectiveHardCap = Math.min(
      captured.maxBytes ?? MAX_PUBLISH_BYTES,
      MAX_PUBLISH_BYTES,
    );
    if (held.bytes > effectiveHardCap) {
      // Over the hard cap — keep trim active, mark over-limit, evict prepared.
      cancelPrepared(held.prepareId);
      patchActiveTrim(runId, {
        preparedArtifact: null,
        measuredBytes: held.bytes,
        safeStatus: 'over-limit',
      });
      setShareMeasuring(false);
      return;
    }

    // Phase 3 — Submit.
    setShareMeasuring(false);
    setShareSubmitting(true);
    setShareError(null);
    try {
      const result = await publishPrepared(held.prepareId);
      if (!mountedRef.current || trimRunIdRef.current !== runId) return;
      // Record pending-restore BEFORE clearing trim state so the
      // close-after-success policy has what it needs.
      setPendingTrimSuccessRestore({
        prevReviewState: captured.prevReviewState,
        userInteractedAfterSuccess: false,
      });
      setShareResult(result);
      setShareSubmitting(false);
      // Clear trim state so the success branch renders.
      cancelInFlightTrimSearch();
      cancelInFlightTrimDragPrepare();
      setShareTrimState(initialShareTrim);
    } catch (e) {
      if (!mountedRef.current) return;
      setShareSubmitting(false);
      if (isCapsuleSnapshotStaleError(e)) {
        abortSearchSnapshotStale(runId);
        return;
      }
      if (isPublishOversizeError(e)) {
        // Race-with-quota — re-enter trim with the new oversize error.
        // Existing trim session already active; just refresh the state.
        cancelInFlightTrimSearch();
        // Re-enter — this also refreshes snapshot + frames. If
        // `enterTrimMode` returns false (no frames — history was
        // cleared between Prepare and Submit) we must surface the
        // oversize error ourselves; otherwise the user just sees
        // the Submit button re-enable with no explanation.
        const entered = enterTrimMode(e);
        if (!entered) {
          setShareError({
            kind: 'other',
            message: e instanceof Error ? e.message : 'Share failed.',
          });
        }
        return;
      }
      if (e instanceof AuthRequiredError) {
        useAppStore.getState().setAuthSignedOut();
        setShareError({ kind: 'auth', message: e.message });
        return;
      }
      if (e instanceof AgeConfirmationRequiredError) {
        setShareError({
          kind: 'age-confirmation',
          message: e.message,
          policyVersion: e.policyVersion,
        });
        return;
      }
      console.error('[trim] publish submit failed:', e);
      setShareError({
        kind: 'other',
        message: e instanceof Error ? e.message : 'Share failed.',
      });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [callbacks, shareMeasuring, shareSubmitting, cancelPrepared, abortSearchSnapshotStale, cancelInFlightTrimSearch, cancelInFlightTrimDragPrepare, enterTrimMode]);

  const handleDownloadCapsuleFromShareFallback = useCallback(async () => {
    if (!callbacks?.onExportHistory) {
      setShareFallbackDownloadError('Download is not available right now.');
      return;
    }
    setDownloadSubmitting(true);
    setShareFallbackDownloadError(null);
    try {
      const result = await callbacks.onExportHistory('capsule');
      if (!mountedRef.current) return;
      if (result === 'saved') {
        closeTransfer();
      } else if (result === 'picker-cancelled') {
        setDownloadSubmitting(false);
      }
    } catch (e) {
      console.error('[TimelineBar] download capsule (trim fallback) failed:', e);
      if (mountedRef.current) {
        // Write to the fallback-dedicated slot so the error surfaces
        // inside the Share trim branch (the Download tab's error slot
        // is not visible when shareTrim.nothingFits is true).
        setShareFallbackDownloadError(e instanceof Error ? e.message : 'Download failed.');
        setDownloadSubmitting(false);
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [callbacks]);

  // ── Trim-mode pointer handling ──

  const trimDragRef = useRef<{
    pointerId: number;
    mode: 'start' | 'end' | 'window';
    /** Only set when mode === 'window'. */
    anchorOffsetPs?: number;
  } | null>(null);

  /** Resolve which trim target a client X coordinate falls on. */
  const resolveTrimHitTarget = useCallback((clientX: number): 'start' | 'end' | 'window' | 'none' => {
    const trim = shareTrimStateRef.current;
    const track = trackRef.current;
    if (!trim.active || !track || !rangePs) return 'none';
    const rect = track.getBoundingClientRect();
    if (rect.width <= 0) return 'none';
    const duration = rangePs.end - rangePs.start;
    if (duration <= 0) return 'none';
    const startPx = rect.left + ((trim.rangeStartPs - rangePs.start) / duration) * rect.width;
    const endPx = rect.left + ((trim.rangeEndPs - rangePs.start) / duration) * rect.width;
    // 16px handle half-width so the 32px hit-area centered on each
    // handle position is respected. Matches CSS width in trim-handle.
    const hitHalf = 16;
    if (Math.abs(clientX - startPx) <= hitHalf) return 'start';
    if (Math.abs(clientX - endPx) <= hitHalf) return 'end';
    // Kept-region body hit: anywhere strictly between the handles.
    if (clientX > startPx + hitHalf && clientX < endPx - hitHalf) return 'window';
    return 'none';
  }, [rangePs]);

  const applyTrimEdgeDrag = useCallback((mode: 'start' | 'end', candidateTimePs: number) => {
    const trim = shareTrimStateRef.current;
    if (!trim.active || trim.frames.length === 0) return;
    const historyStart = trim.frames[0].timePs;
    const historyEnd = trim.frames[trim.frames.length - 1].timePs;
    const maxSpan = trim.maxSelectableSpanPs;
    if (mode === 'start') {
      let nextStart = Math.max(historyStart, Math.min(candidateTimePs, trim.rangeEndPs));
      if (maxSpan > 0 && trim.rangeEndPs - nextStart > maxSpan) {
        nextStart = trim.rangeEndPs - maxSpan;
      }
      // Snap to the nearest dense frame.
      const idx = snapToFrameIndex(trim.frames, nextStart);
      let clampedIdx = Math.min(idx, trim.endFrameIndex);
      // Post-snap span enforcement: for irregular frame spacing the
      // nearest frame may land just outside the allowed span even when
      // the pre-snap candidate was clamped correctly. Walk forward
      // (toward the end handle) until the span fits.
      if (maxSpan > 0) {
        while (
          clampedIdx < trim.endFrameIndex
          && trim.frames[trim.endFrameIndex].timePs - trim.frames[clampedIdx].timePs > maxSpan
        ) {
          clampedIdx++;
        }
      }
      setShareTrimState((prev) => prev.active ? {
        ...prev,
        startFrameIndex: clampedIdx,
        rangeStartPs: prev.frames[clampedIdx].timePs,
        dragMode: 'start',
        previewTarget: 'start',
        previewingOutsideKept: false,
      } : prev);
      previewAtTimePs(trim.frames[clampedIdx].timePs);
    } else {
      let nextEnd = Math.min(historyEnd, Math.max(candidateTimePs, trim.rangeStartPs));
      if (maxSpan > 0 && nextEnd - trim.rangeStartPs > maxSpan) {
        nextEnd = trim.rangeStartPs + maxSpan;
      }
      const idx = snapToFrameIndex(trim.frames, nextEnd);
      let clampedIdx = Math.max(idx, trim.startFrameIndex);
      // Post-snap span enforcement: walk backward (toward the start
      // handle) until the span fits.
      if (maxSpan > 0) {
        while (
          clampedIdx > trim.startFrameIndex
          && trim.frames[clampedIdx].timePs - trim.frames[trim.startFrameIndex].timePs > maxSpan
        ) {
          clampedIdx--;
        }
      }
      setShareTrimState((prev) => prev.active ? {
        ...prev,
        endFrameIndex: clampedIdx,
        rangeEndPs: prev.frames[clampedIdx].timePs,
        dragMode: 'end',
        previewTarget: 'end',
        previewingOutsideKept: false,
      } : prev);
      previewAtTimePs(trim.frames[clampedIdx].timePs);
    }
  }, [previewAtTimePs]);

  const applyTrimWindowDrag = useCallback((candidateTimePs: number, anchorOffsetPs: number) => {
    const trim = shareTrimStateRef.current;
    if (!trim.active || trim.frames.length === 0) return;
    const historyStart = trim.frames[0].timePs;
    const historyEnd = trim.frames[trim.frames.length - 1].timePs;
    const width = trim.rangeEndPs - trim.rangeStartPs;
    let candidateStart = candidateTimePs - anchorOffsetPs;
    let candidateEnd = candidateStart + width;
    if (candidateStart < historyStart) {
      candidateStart = historyStart;
      candidateEnd = historyStart + width;
    }
    if (candidateEnd > historyEnd) {
      candidateEnd = historyEnd;
      candidateStart = historyEnd - width;
    }
    const startIdx = snapToFrameIndex(trim.frames, candidateStart);
    const endIdx = snapToFrameIndex(trim.frames, candidateEnd);
    setShareTrimState((prev) => prev.active ? {
      ...prev,
      startFrameIndex: startIdx,
      endFrameIndex: endIdx,
      rangeStartPs: prev.frames[startIdx].timePs,
      rangeEndPs: prev.frames[endIdx].timePs,
      dragMode: 'window',
      previewTarget: 'end',
      previewingOutsideKept: false,
    } : prev);
    previewAtTimePs(trim.frames[endIdx].timePs);
  }, [previewAtTimePs]);

  const handleTrimHandleKeyDown = useCallback((handle: 'start' | 'end', e: React.KeyboardEvent) => {
    const trim = shareTrimStateRef.current;
    if (!trim.active || trim.frames.length === 0) return;
    const step = e.shiftKey ? 10 : 1;
    let handled = true;
    let nextStart = trim.startFrameIndex;
    let nextEnd = trim.endFrameIndex;
    const n = trim.frames.length;
    if (e.key === 'ArrowLeft') {
      if (handle === 'start') nextStart = Math.max(0, nextStart - step);
      else nextEnd = Math.max(nextStart, nextEnd - step);
    } else if (e.key === 'ArrowRight') {
      if (handle === 'start') nextStart = Math.min(nextEnd, nextStart + step);
      else nextEnd = Math.min(n - 1, nextEnd + step);
    } else if (e.key === 'Home') {
      if (handle === 'start') nextStart = 0;
      else nextEnd = nextStart;
    } else if (e.key === 'End') {
      if (handle === 'start') nextStart = nextEnd;
      else nextEnd = n - 1;
    } else {
      handled = false;
    }
    if (!handled) return;
    e.preventDefault();
    const maxSpan = trim.maxSelectableSpanPs;
    if (maxSpan > 0 && trim.frames[nextEnd].timePs - trim.frames[nextStart].timePs > maxSpan) {
      if (handle === 'start') {
        // Shift end down implicitly — but plan says edge-drags clamp.
        while (nextStart < nextEnd && trim.frames[nextEnd].timePs - trim.frames[nextStart].timePs > maxSpan) nextStart++;
      } else {
        while (nextEnd > nextStart && trim.frames[nextEnd].timePs - trim.frames[nextStart].timePs > maxSpan) nextEnd--;
      }
    }
    setShareTrimState((prev) => prev.active ? {
      ...prev,
      startFrameIndex: nextStart,
      endFrameIndex: nextEnd,
      rangeStartPs: prev.frames[nextStart].timePs,
      rangeEndPs: prev.frames[nextEnd].timePs,
      previewTarget: handle,
      previewingOutsideKept: false,
    } : prev);
    const previewFrame = trim.frames[handle === 'start' ? nextStart : nextEnd];
    previewAtTimePs(previewFrame.timePs);
    // Debounce prepare after the last keystroke.
    const runId = trimRunIdRef.current;
    if (trimDragPrepareCancelRef.current) {
      trimDragPrepareCancelRef.current();
      trimDragPrepareCancelRef.current = null;
    }
    const t = setTimeout(() => {
      debouncedPrepareAfterEdit(runId, { startFrameIndex: nextStart, endFrameIndex: nextEnd });
    }, TRIM_KEYBOARD_PREPARE_DEBOUNCE_MS);
    trimDragPrepareCancelRef.current = () => clearTimeout(t);
  }, [previewAtTimePs, debouncedPrepareAfterEdit]);

  // Wrap the original scrub pointer-down so trim mode intercepts it.
  const handleTrackPointerDown = useCallback((e: React.PointerEvent) => {
    if (!hasRange) return;
    const trim = shareTrimStateRef.current;
    if (trim.active) {
      const target = resolveTrimHitTarget(e.clientX);
      if (target === 'start' || target === 'end') {
        trimDragRef.current = { pointerId: e.pointerId, mode: target };
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
        const track = trackRef.current;
        if (!track || !rangePs) return;
        const tPs = timePsFromClientX(e.clientX, rangePs, track);
        applyTrimEdgeDrag(target, tPs);
        return;
      }
      if (target === 'window') {
        const track = trackRef.current;
        if (!track || !rangePs) return;
        const tPs = timePsFromClientX(e.clientX, rangePs, track);
        const anchorOffsetPs = tPs - trim.rangeStartPs;
        trimDragRef.current = { pointerId: e.pointerId, mode: 'window', anchorOffsetPs };
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
        applyTrimWindowDrag(tPs, anchorOffsetPs);
        return;
      }
      // Outside kept region — scrub-only preview, no selection change.
      const track = trackRef.current;
      if (!track || !rangePs) return;
      const tPs = timePsFromClientX(e.clientX, rangePs, track);
      previewAtTimePs(tPs);
      setShareTrimState((prev) => prev.active
        ? { ...prev, previewingOutsideKept: tPs < prev.rangeStartPs || tPs > prev.rangeEndPs }
        : prev);
      return;
    }
    // Non-trim path: existing scrub behavior. Mark the post-success
    // restore opt-out — if the user is scrubbing while the trim-success
    // dialog is open, they've chosen a different view than the pre-trim
    // state and closeTransfer must NOT snap back.
    markPostSuccessInteraction();
    isDragging.current = true;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    scrubFromEvent(e.clientX);
  }, [hasRange, rangePs, resolveTrimHitTarget, applyTrimEdgeDrag, applyTrimWindowDrag, previewAtTimePs, scrubFromEvent, markPostSuccessInteraction]);

  const handleTrackPointerMove = useCallback((e: React.PointerEvent) => {
    const drag = trimDragRef.current;
    if (drag && drag.pointerId === e.pointerId) {
      const track = trackRef.current;
      if (!track || !rangePs) return;
      const tPs = timePsFromClientX(e.clientX, rangePs, track);
      if (drag.mode === 'start' || drag.mode === 'end') {
        applyTrimEdgeDrag(drag.mode, tPs);
      } else {
        applyTrimWindowDrag(tPs, drag.anchorOffsetPs ?? 0);
      }
      return;
    }
    if (isDragging.current) {
      scrubFromEvent(e.clientX);
    }
  }, [rangePs, applyTrimEdgeDrag, applyTrimWindowDrag, scrubFromEvent]);

  const handleTrackPointerUp = useCallback((e: React.PointerEvent) => {
    const drag = trimDragRef.current;
    if (drag && drag.pointerId === e.pointerId) {
      trimDragRef.current = null;
      // Read the committed selection from the ref (synced by
      // useLayoutEffect so it reflects the final pointermove's setState
      // by this point). Reading inside the setShareTrimState updater
      // would be unreliable — in React 18, updaters aren't guaranteed
      // to fire synchronously within the event callback, so any
      // post-setState variable capture could land before the updater
      // ran.
      const pre = shareTrimStateRef.current;
      if (!pre.active) return;
      const capturedRunId = trimRunIdRef.current;
      const selection = {
        startFrameIndex: pre.startFrameIndex,
        endFrameIndex: pre.endFrameIndex,
      };
      if (pre.preparedArtifact) cancelPrepared(pre.preparedArtifact.prepareId);
      setShareTrimState((prev) => {
        if (!prev.active) return prev;
        // Idempotent cancel in case a stale prepared artifact slipped
        // in between the ref read and this updater.
        if (prev.preparedArtifact) cancelPrepared(prev.preparedArtifact.prepareId);
        return {
          ...prev,
          dragMode: null,
          previewTarget: null,
          preparedArtifact: null,
        };
      });
      queueMicrotask(() => debouncedPrepareAfterEdit(capturedRunId, selection));
      return;
    }
    isDragging.current = false;
  }, [cancelPrepared, debouncedPrepareAfterEdit]);

  const isReview = mode === 'review';

  // Guard: close clear dialog on mode transition
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (!isReview) clear.reset(); }, [isReview]);

  // Guard: close transfer dialog when both download and share are unavailable.
  // Routes through closeTransfer so a trim-active capability-loss close
  // still restores prevReviewState — Acceptance #13 applies to every
  // non-success trim exit, not just the explicit Cancel button.
  useEffect(() => {
    if (!showTransfer) {
      closeTransfer();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showTransfer]);

  // Opportunistic session revalidation.
  //
  // The Lab hydrates `auth.session` once at boot. If the session expires
  // or is revoked during the tab's lifetime, the Share tab would still
  // render the Publish button from stale store state and the user's first
  // click would hit a 401. hydrateAuthSession() never sets `loading: true`,
  // so this refresh is transparent — the UI only changes if the server
  // actually reports signed-out. Defensive .catch keeps a future regression
  // (if hydrate were ever to throw) out of the unhandled-rejection bucket.
  useEffect(() => {
    if (!transferDialog.open || transferDialog.tab !== 'share') return;
    hydrateAuthSession().catch((err) => {
      console.warn('[TimelineBar] opportunistic auth refresh failed:', err);
    });
  }, [transferDialog.open, transferDialog.tab]);

  // No cross-status shareError clear is needed here. Cross-bleed is
  // prevented structurally by the `shareError.kind` discriminator: the
  // dialog's signed-out branch only reads `kind === 'auth'` messages (auth
  // note), and the signed-in branch only reads `kind === 'other'` messages
  // (red error). An earlier conditional `if (authStatus === 'signed-in')`
  // effect lived here — it was replaced by the kind-tagged state, which
  // also covers the 429-into-signed-out bleed that the conditional clear
  // missed.

  // Guard: revalidate selected download kind if capability changes while dialog is open
  useEffect(() => {
    if (!transferDialog.open) return;
    if (downloadKind === 'full' && !exportCaps?.full && exportCaps?.capsule) setDownloadKind('capsule');
    if (downloadKind === 'capsule' && !exportCaps?.capsule && exportCaps?.full) setDownloadKind('full');
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [transferDialog.open, downloadKind, exportCaps]);

  // Guard: if the user opened on a tab that then becomes unavailable, switch tabs.
  // Uses action availability (callback + capability) rather than stored-artifact
  // capability alone, so a callback being torn down mid-session also triggers
  // the switch.
  useEffect(() => {
    if (!transferDialog.open) return;
    if (transferDialog.tab === 'download' && !downloadActionAvailable && shareAvailable) {
      transferDialog.setTab('share');
    } else if (transferDialog.tab === 'share' && !shareAvailable && downloadActionAvailable) {
      transferDialog.setTab('download');
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [transferDialog.open, transferDialog.tab, downloadActionAvailable, shareAvailable]);

  // Width-aware restart anchor clamp + pointer-offset compensation.
  //
  // Two concerns, one pass:
  //
  //   1. The pill must never spill past the overlay-zone edges into the
  //      sibling action zones. We clamp the pill's CENTER to
  //      [halfBtn, trackWidth - halfBtn] so the pill's edges stay inside
  //      the track.
  //
  //   2. When the marker is near an edge, the clamped pill-center no
  //      longer coincides with the true marker position. Without
  //      compensation, the downward pointer (anchored to the pill's
  //      own center via `left: 50%`) would aim at the pill-center
  //      instead of the marker — pointer appears to "freeze" when the
  //      marker passes the clamp band.
  //
  //      Fix: compute `tailOffsetPx = targetPx - clampedPx` and expose
  //      it as a CSS custom property (`--restart-tail-offset`). The
  //      pointer's `left` becomes `calc(50% + var(--restart-tail-offset))`
  //      so it slides along the pill's bottom edge and always points at
  //      the actual marker.
  //
  //      Offset is further clamped to the pill's usable pointer-run —
  //      left/right by (halfBtn - pointerHalfW - edgeSafety) — so the
  //      pointer never slides past the pill's rounded corners. When
  //      the marker moves BEYOND that range (pathological: pill wider
  //      than half the track), the pointer pins to the usable edge —
  //      the only honest signal the geometry can deliver in that case.
  const restartButtonRef = useRef<HTMLButtonElement>(null);
  const [restartClampedLeftPx, setRestartClampedLeftPx] = useState<number | null>(null);
  // Split the pointer geometry into two independent axes:
  //   · baseOffsetPx — horizontal position of the triangle BASE center,
  //                    clamped to the pill's straight-bottom segment so
  //                    the base never straddles a rounded corner.
  //   · skewOffsetPx — horizontal delta between the BASE center and the
  //                    TIP. Zero inside the clamp; non-zero at extremes,
  //                    where it lets the tip keep tracking the marker
  //                    by tilting the triangle asymmetrically.
  const [restartBaseOffsetPx, setRestartBaseOffsetPx] = useState<number>(0);
  const [restartSkewOffsetPx, setRestartSkewOffsetPx] = useState<number>(0);
  // Trim mode uses the timeline as its adjustable range control. A
  // "Restart here" pill sitting on the same track would:
  //   1. visually collide with the end handle / playhead marker, and
  //   2. suggest a destructive simulation action while the user is
  //      choosing a publish range (unrelated intent).
  // Hide it entirely during trim; normal review mode is unchanged.
  const trimActive = shareTrimState.active;
  const showRestart = !trimActive && isReview && canRestart && restartTargetPs !== null;

  useLayoutEffect(() => {
    if (!showRestart) {
      setRestartClampedLeftPx(null);
      setRestartBaseOffsetPx(0);
      setRestartSkewOffsetPx(0);
      return;
    }
    const btn = restartButtonRef.current;
    if (!btn) return;
    const overlay = btn.closest<HTMLElement>('.timeline-overlay-zone');
    if (!overlay) return;

    const compute = () => {
      const trackWidth = overlay.clientWidth;
      const btnWidth = btn.offsetWidth;
      // Height MAY be 0 in test environments (jsdom doesn't perform
      // real layout). That shouldn't block the layout clamp — only the
      // straight-bottom clamp on the pointer base. Guard downstream.
      const btnHeight = btn.offsetHeight;
      if (trackWidth <= 0 || btnWidth <= 0) return;
      const halfBtn = btnWidth / 2;

      // Pathological: pill wider than track — pin pill-center, collapse
      // base + skew to 0 (no usable marker range to track).
      if (btnWidth >= trackWidth) {
        setRestartClampedLeftPx(trackWidth / 2);
        setRestartBaseOffsetPx(0);
        setRestartSkewOffsetPx(0);
        return;
      }

      const targetPx = restartProgress * trackWidth;
      const clampedPx = Math.max(halfBtn, Math.min(trackWidth - halfBtn, targetPx));
      setRestartClampedLeftPx(clampedPx);

      // rawOffset: gap between the true marker and the clamped pill
      // center. This is what the TIP must travel; the BASE may fall
      // short of it if the pill's corner geometry says so.
      const rawOffset = targetPx - clampedPx;

      // ── Base-offset clamp: keep the whole base on the straight
      //    pill-bottom segment so it never sits over a rounded corner.
      //
      // The pill is `border-radius: 999px`, i.e. a full pill — each
      // corner's radius equals half the pill height. The straight-
      // bottom segment is therefore:
      //     straightHalfW = halfBtn − cornerRadius
      //                   = halfBtn − (btnHeight / 2)
      // And the usable base-center band (so the base's OWN half-width
      // stays on the straight section) is
      //     straightHalfW − baseHalfW
      // `baseHalfW` is read from the CSS var `--restart-pointer-base-w`
      // so the source of truth lives in one place and theme swaps or
      // typography changes propagate automatically.
      //
      // When `btnHeight` is 0 (jsdom / headless measurement gap) the
      // straight-segment clamp is unusable; degrade to the "keep the
      // base inside the pill" bound (halfBtn − baseHalfW) which is
      // the same degenerate limit the bridge-less pointer had before
      // this iteration. The tip still tracks the marker via `skew`.
      const cs = getComputedStyle(btn);
      const baseWidthRaw = parseFloat(cs.getPropertyValue('--restart-pointer-base-w'));
      const baseWidth = Number.isFinite(baseWidthRaw) && baseWidthRaw > 0 ? baseWidthRaw : 18;
      const baseHalfW = baseWidth / 2;
      const straightHalfW = btnHeight > 0
        ? Math.max(0, halfBtn - btnHeight / 2)
        : halfBtn; // no corner geometry available → full pill width is usable
      const maxBaseOffset = Math.max(0, straightHalfW - baseHalfW);
      const baseOffset = Math.max(-maxBaseOffset, Math.min(maxBaseOffset, rawOffset));
      setRestartBaseOffsetPx(baseOffset);
      setRestartSkewOffsetPx(rawOffset - baseOffset);
    };

    compute();
    const ro = new ResizeObserver(compute);
    ro.observe(overlay);
    ro.observe(btn);
    return () => ro.disconnect();
  }, [showRestart, restartProgress]);

  // First render falls back to percentage clamp; useLayoutEffect swaps in the
  // pixel-based clamp before the browser paints, so there is no visible flicker.
  const restartAnchorStyle: React.CSSProperties = restartClampedLeftPx !== null
    ? { left: `${restartClampedLeftPx}px` }
    : getRestartAnchorStyle(restartProgress);
  // Inline custom properties consumed by the pointer's `::after` in
  // lab/index.html. `--tail-base-offset` positions the BASE horizontally
  // (clamped to the pill's straight segment). `--tail-skew` shifts the
  // TIP relative to the base so the tip always lands at the marker,
  // even when the base had to be clamped short of it.
  const styleWithVars = restartAnchorStyle as React.CSSProperties & Record<string, string>;
  styleWithVars['--tail-base-offset'] = `${restartBaseOffsetPx}px`;
  styleWithVars['--tail-skew'] = `${restartSkewOffsetPx}px`;

  // Restart CTA — the "Restart here" pill IS the affordance; no
  // wrapping hover tooltip (that was a redundant second hint).
  //
  // Layout split (intentional, fixes the "hover jumps away" bug):
  //   · `.timeline-restart-anchor`  — positioning wrapper. Owns
  //     `left: <marker px>` + `transform: translateX(-50%)` so the
  //     pill's center lands ON the review marker and the downward
  //     pointer at its `::after` hits the marker exactly.
  //   · `.timeline-restart-button`  — interactive pill. Owns hover /
  //     active transforms.
  //
  // Without this split, the two transforms collide on the same
  // element — CSS can't composite two `transform` declarations from
  // different rules, so the more-specific `:hover` rule replaces
  // the centering translate and the button visually escapes the
  // cursor.
  // Overlay-zone content priority:
  //   1. review + can-restart → the Restart here pill. Hidden during
  //      trim (unrelated intent, visually competes with end handle).
  //   2. otherwise (including trim mode) → empty placeholder.
  //
  // An inline "Drag the highlighted range" hint used to live in the
  // overlay zone during trim, but the end-caps extend upward into
  // the same absolutely-positioned region and the two collided.
  // The dialog's description already tells the user what to do — a
  // duplicate caption tucked under the end-caps adds noise without
  // adding information.
  const overlayContent = showRestart ? (
    <span className="timeline-restart-anchor" style={restartAnchorStyle}>
      <button
        ref={restartButtonRef}
        className="timeline-restart-button"
        onClick={handleRestart}
        aria-label={`Restart simulation at ${formatTime(restartTargetPs)}`}
      >
        <svg
          className="timeline-restart-button__icon"
          width="15"
          height="15"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          {/* Circular-arrow / reload glyph — universal "go again"
              affordance. */}
          <path d="M3 12a9 9 0 1 0 3-6.7" />
          <polyline points="3 3 3 8 8 8" />
        </svg>
        <span className="timeline-restart-button__label">Restart here</span>
      </button>
    </span>
  ) : <span />;

  // Derive trim overlay positions in track-relative percent. Uses the
  // current live rangePs as the track's coordinate system so handles
  // land on the same pixels the user sees under the thumb. `trimActive`
  // is declared earlier alongside the `showRestart` gate.
  const trimOverlay = (() => {
    if (!trimActive || !rangePs) return null;
    const duration = rangePs.end - rangePs.start;
    if (duration <= 0) return null;
    const pctOf = (ps: number) => ((ps - rangePs.start) / duration) * 100;
    const startPct = Math.max(0, Math.min(100, pctOf(shareTrimState.rangeStartPs)));
    const endPct = Math.max(0, Math.min(100, pctOf(shareTrimState.rangeEndPs)));
    const rightPct = Math.max(0, 100 - endPct);
    const historyStart = shareTrimState.frames.length > 0 ? shareTrimState.frames[0].timePs : rangePs.start;
    const historyEnd = shareTrimState.frames.length > 0 ? shareTrimState.frames[shareTrimState.frames.length - 1].timePs : rangePs.end;
    return (
      <>
        {startPct > 0 && (
          <div
            className="timeline-track__trimmed-left"
            style={{ left: 0, width: `${startPct}%` }}
            data-testid="timeline-trim-left"
          />
        )}
        <div
          className="timeline-track__kept"
          style={{ left: `${startPct}%`, right: `${rightPct}%` }}
          data-testid="timeline-trim-kept"
        />
        {rightPct > 0 && (
          <div
            className="timeline-track__trimmed-right"
            style={{ right: 0, width: `${rightPct}%` }}
            data-testid="timeline-trim-right"
          />
        )}
        {/*
          Pulse timing is driven from `trim-mode-config.ts`:
            · `--trim-handle-pulse-duration` / `--trim-handle-pulse-count`
              feed the CSS `animation` shorthand so the JS
              `setTimeout(... , ITERATION_MS * COUNT)` and the CSS
              iteration can never drift.
            · If a future contributor tunes the pulse, they edit the
              config and both sides follow.
        */}
        {/*
          Two-handle range slider: each handle's aria-valuemin /
          aria-valuemax reflect the ACTUAL range it can reach, not
          the full history. The start handle cannot move past the
          end handle, and vice versa — screen readers should
          announce the movable bound, not a theoretical one. WAI-ARIA
          1.2 pattern for a paired range slider.
        */}
        <button
          type="button"
          className={`timeline-track__trim-handle timeline-track__trim-handle--start${handlesPulse ? ' timeline-track__trim-handle--pulse' : ''}`}
          style={{
            left: `${startPct}%`,
            '--trim-handle-pulse-duration': `${TRIM_HANDLE_PULSE_ITERATION_MS}ms`,
            '--trim-handle-pulse-count': String(TRIM_HANDLE_PULSE_ITERATION_COUNT),
          } as React.CSSProperties}
          role="slider"
          aria-label="Trim start"
          aria-valuemin={Math.round(historyStart)}
          aria-valuemax={Math.round(shareTrimState.rangeEndPs)}
          aria-valuenow={Math.round(shareTrimState.rangeStartPs)}
          aria-valuetext={`${formatTime(shareTrimState.rangeStartPs)} — start of selection`}
          onKeyDown={(e) => handleTrimHandleKeyDown('start', e)}
          data-testid="timeline-trim-handle-start"
        />
        <button
          type="button"
          className={`timeline-track__trim-handle timeline-track__trim-handle--end${handlesPulse ? ' timeline-track__trim-handle--pulse' : ''}`}
          style={{
            left: `${endPct}%`,
            '--trim-handle-pulse-duration': `${TRIM_HANDLE_PULSE_ITERATION_MS}ms`,
            '--trim-handle-pulse-count': String(TRIM_HANDLE_PULSE_ITERATION_COUNT),
          } as React.CSSProperties}
          role="slider"
          aria-label="Trim end"
          aria-valuemin={Math.round(shareTrimState.rangeStartPs)}
          aria-valuemax={Math.round(historyEnd)}
          aria-valuenow={Math.round(shareTrimState.rangeEndPs)}
          aria-valuetext={`${formatTime(shareTrimState.rangeEndPs)} — end of selection`}
          onKeyDown={(e) => handleTrimHandleKeyDown('end', e)}
          data-testid="timeline-trim-handle-end"
        />
      </>
    );
  })();

  const trackContent = (
    <div
      className={`timeline-track timeline-track--thick${hasRange ? '' : ' timeline-track--disabled'}${trimActive ? ' timeline-track--trim' : ''}`}
      ref={trackRef}
      onPointerDown={handleTrackPointerDown}
      onPointerMove={handleTrackPointerMove}
      onPointerUp={handleTrackPointerUp}
      onPointerCancel={handleTrackPointerUp}
    >
      <div className="timeline-fill" style={{ width: `${progress * 100}%` }} />
      {hasRange && !trimActive && <div className="timeline-thumb" style={{ left: `${progress * 100}%` }} />}
      {trimActive && hasRange && (
        <div className="timeline-track__trim-playhead" style={{ left: `${progress * 100}%` }} />
      )}
      {trimOverlay}
    </div>
  );

  return (
    <>
      <TimelineShell
        modeRail={
          <TimelineModeSwitch
            mode={isReview ? 'review' : 'live'}
            canReturnToLive={canReturnToLive}
            hasRange={hasRange}
            onReturnToLive={handleReturnToLive}
            onEnterReview={handleEnterReview}
          />
        }
        time={formatTime(currentTimePs)}
        overlay={overlayContent}
        track={trackContent}
        action={<TimelineActionZone
          showTransfer={showTransfer}
          onTransfer={openTransfer}
          // Hide Clear during trim: it would wipe the entire recording
          // mid-trim — a destructive action with zero related intent
          // for a user who is actively selecting a publish range.
          // Clear remains available the moment trim exits.
          showClear={!trimActive}
          onClear={openClear}
        />}
      />
      <TimelineClearDialog open={clear.open} onCancel={clear.cancel} onConfirm={clear.confirm} />
      <TimelineTransferDialog
        open={transferDialog.open}
        tab={transferDialog.tab}
        onTabChange={transferDialog.setTab}
        onCancel={closeTransfer}

        downloadTabAvailable={downloadActionAvailable}
        availableKinds={exportCaps ?? { full: false, capsule: false }}
        downloadKind={downloadKind}
        onSelectDownloadKind={setDownloadKind}
        onConfirmDownload={handleDownloadConfirm}
        downloadSubmitting={downloadSubmitting}
        downloadError={downloadError}
        downloadConfirmEnabled={downloadActionAvailable}
        fullEstimate={estimates.full}
        capsuleEstimate={estimates.capsule}

        shareTabAvailable={shareAvailable}
        shareConfirmEnabled={shareAvailable && authStatus === 'signed-in'}
        onConfirmShare={handleShareConfirm}
        guestPublishConfig={guestPublishConfig}
        guestTurnstileControllerRef={guestTurnstileControllerRef}
        onSubmitGuestShare={handleConfirmGuestShare}
        shareResult={shareResult}
        shareSubmitting={shareSubmitting}
        shareError={shareError?.kind === 'other' ? shareError.message : null}
        authNote={shareError?.kind === 'auth' ? shareError.message : null}
        ageConfirmationRequired={shareError?.kind === 'age-confirmation' ? {
          message: shareError.message,
          policyVersion: shareError.policyVersion,
        } : null}
        onAgeConfirmationAck={async () => {
          try {
            const res = await fetch('/api/account/age-confirmation', {
              method: 'POST',
              credentials: 'include',
            });
            if (!res.ok) {
              setShareError({ kind: 'other', message: `Age confirmation failed (${res.status}).` });
              return;
            }
            setShareError(null);
            await handleShareConfirm();
          } catch (err) {
            setShareError({
              kind: 'other',
              message: err instanceof Error ? err.message : String(err),
            });
          }
        }}
        shareUrl={shareResult?.shareUrl ?? null}
        shareCode={shareResult?.shareCode ?? null}
        shareWarnings={shareResult?.warnings ?? null}

        authStatus={authStatus}
        onSignIn={handleAuthSignIn}
        popupBlocked={authPopupBlocked}
        onRetryPopup={handleRetryPopup}
        onSignInSameTab={handleContinueInTab}
        onDismissPopupBlocked={handleDismissPopupBlocked}

        shareTrim={
          shareTrimState.active
            ? (() => {
                // A Reset is a no-op when the selection already matches
                // the cached default suggested by the entry-time
                // search (start index = cachedDefault, end index =
                // last frame). Disabling the button prevents a
                // clickable control whose only effect is invisible.
                const lastFrameIdx = shareTrimState.frames.length - 1;
                const isAtDefault =
                  shareTrimState.cachedDefaultStartFrameIndex !== null
                  && shareTrimState.startFrameIndex === shareTrimState.cachedDefaultStartFrameIndex
                  && shareTrimState.endFrameIndex === lastFrameIdx;
                return {
                  status: shareTrimState.safeStatus,
                  measuringKind: shareTrimState.measuringKind,
                  measuredBytes: shareTrimState.measuredBytes,
                  maxBytes: shareTrimState.maxBytes,
                  maxSource: shareTrimState.maxSource,
                  originalActualBytes: shareTrimState.originalActualBytes,
                  previewingOutsideKept: shareTrimState.previewingOutsideKept,
                  snapshotStale: shareTrimState.snapshotStale,
                  publishDisabled:
                    shareTrimState.safeStatus === 'over-limit' ||
                    shareTrimState.safeStatus === 'measuring' ||
                    shareTrimState.safeStatus === 'unavailable' ||
                    shareTrimState.nothingFits ||
                    shareTrimState.snapshotStale,
                  // Reset is only meaningful when the selection has
                  // drifted from the cached default. When null, Reset
                  // would scroll to the fallback end-anchored window —
                  // still useful, so allow in that case.
                  canReset:
                    shareTrimState.cachedDefaultStartFrameIndex === null
                    || !isAtDefault,
                  nothingFits: shareTrimState.nothingFits,
                  message: 'Capsule too large — trim to publish.',
                };
              })()
            : null
        }
        shareMeasuring={shareMeasuring}
        onResetShareTrim={handleResetShareTrim}
        onConfirmShareTrim={handleConfirmShareTrim}
        onDownloadCapsuleFromShareFallback={handleDownloadCapsuleFromShareFallback}
        shareFallbackDownloadError={shareFallbackDownloadError}
      />
    </>
  );
}
