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
import { useAppStore } from '../store/app-store';
import { formatTime, getTimelineProgress, getRestartAnchorStyle } from './timeline-format';
import { TimelineModeSwitch } from './timeline-mode-switch';
import { TimelineClearDialog, useClearConfirm, ClearTrigger } from './timeline-clear-dialog';
import type { TimelineExportKind } from './timeline-export-dialog';
import {
  TimelineTransferDialog,
  useTransferDialog,
  TransferTrigger,
} from './timeline-transfer-dialog';
import { hydrateAuthSession, AuthRequiredError } from '../runtime/auth-runtime';
import { ActionHint } from './ActionHint';
import { TIMELINE_HINTS } from './timeline-hints';

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

  const handleReturnToLive = useCallback(() => { callbacks?.onReturnToLive(); }, [callbacks]);
  const handleEnterReview = useCallback(() => { callbacks?.onEnterReview(); }, [callbacks]);
  const handleRestart = useCallback(() => { callbacks?.onRestartFromHere(); }, [callbacks]);
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
  const [shareError, setShareError] = useState<{ kind: 'auth' | 'other'; message: string } | null>(null);
  const [shareResult, setShareResult] = useState<{
    shareCode: string;
    shareUrl: string;
    warnings?: string[];
  } | null>(null);
  const transferDidPause = useRef(false);

  // Latest callbacks ref — keeps unmount cleanup current even when callbacks
  // are installed after mount or reinstalled by the subsystem.
  const latestCallbacksRef = useRef(callbacks);
  useEffect(() => { latestCallbacksRef.current = callbacks; }, [callbacks]);

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
  }, [callbacks, transferDialog]);

  const openTransfer = useCallback(() => {
    clear.reset();
    setDownloadKind(preferredKind);
    setDownloadSubmitting(false);
    setDownloadError(null);
    setEstimates({});
    setShareSubmitting(false);
    setShareError(null);
    setShareResult(null);
    transferDidPause.current = callbacks?.onPauseForExport?.() ?? false;
    // Default to Share tab (Phase 6 Auth UX contract) — the cross-session,
    // higher-value path. Fall back to Download only when Share is not
    // actionable (no publishCapsule callback or no recorded range).
    transferDialog.request(shareAvailable ? 'share' : 'download');
  }, [clear, preferredKind, callbacks, transferDialog, shareAvailable]);

  const openClear = useCallback(() => {
    closeTransferSession();
    clear.request();
  }, [clear, closeTransferSession]);

  // Sign-in handler for the Share tab's auth prompt. Always sets the
  // resume-publish intent so the user lands back on the Share tab after the
  // OAuth round-trip — the store's requestShareTabOpen() will then flip the
  // flag and the effect below will re-open this dialog.
  const handleAuthSignIn = useCallback((provider: 'google' | 'github') => {
    authCallbacks?.onSignIn(provider, { resumePublish: true });
  }, [authCallbacks]);

  // Popup-blocked Retry button: re-issues the same sign-in call that was
  // blocked. The runtime clears the popup-blocked flag at the start of
  // each onSignIn attempt, so the UI hides the prompt and tries fresh.
  const handleRetryPopup = useCallback(() => {
    const pending = authPopupBlocked;
    if (!pending) return;
    authCallbacks?.onSignIn(pending.provider, { resumePublish: pending.resumePublish });
  }, [authPopupBlocked, authCallbacks]);

  // Popup-blocked Continue-in-tab button: explicit user consent to the
  // destructive same-tab redirect. Wired to the runtime's dedicated
  // commit callback rather than re-invoking onSignIn.
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
    transferDidPause.current = callbacks?.onPauseForExport?.() ?? false;
    transferDialog.request('share');
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shareTabOpenRequested, shareAvailable]);

  // Async estimate computation — only runs when the Download tab can
  // actually be used. Share-only flows skip the artifact build + stringify
  // cost entirely. If download becomes actionable mid-session (e.g. the
  // user switches tabs and Download becomes available), the effect re-runs
  // because downloadActionAvailable is in the dep list.
  useEffect(() => {
    if (!transferDialog.open || !downloadActionAvailable) return;
    let cancelled = false;
    Promise.resolve()
      .then(() => {
        if (cancelled) return;
        const result = callbacks?.getExportEstimates?.() ?? { capsule: null, full: null };
        if (!cancelled) setEstimates(result);
      })
      .catch((err) => {
        console.warn('[TimelineBar] estimate computation failed:', err);
        if (!cancelled) setEstimates({ capsule: null, full: null });
      });
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [transferDialog.open, downloadActionAvailable]);

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
        closeTransferSession();
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
  }, [callbacks, downloadKind, closeTransferSession]);

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
      console.error('[TimelineBar] share failed:', e);
      setShareError({
        kind: 'other',
        message: e instanceof Error ? e.message : 'Share failed.',
      });
      setShareSubmitting(false);
    }
  }, [callbacks]);

  const isReview = mode === 'review';

  // Guard: close clear dialog on mode transition
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (!isReview) clear.reset(); }, [isReview]);

  // Guard: close transfer dialog when both download and share are unavailable
  useEffect(() => {
    if (!showTransfer) {
      closeTransferSession();
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

  // Width-aware restart anchor clamp.
  //
  // Problem: the percentage-based clamp (5%..95%) in getRestartAnchorStyle()
  // only clamps the button *center*, not its edges. Near the right of the
  // track, the button extends past the track-zone boundary and overlaps the
  // sibling action-zone. Wider copy or larger text size makes this worse.
  //
  // Fix: after render, measure the button width and the overlay-zone width,
  // and clamp `left` in pixels to [halfBtn, trackWidth - halfBtn]. This keeps
  // the button's edges strictly inside the track-zone regardless of copy,
  // font, or viewport.
  const restartButtonRef = useRef<HTMLButtonElement>(null);
  const [restartClampedLeftPx, setRestartClampedLeftPx] = useState<number | null>(null);
  const showRestart = isReview && canRestart && restartTargetPs !== null;

  useLayoutEffect(() => {
    if (!showRestart) {
      setRestartClampedLeftPx(null);
      return;
    }
    const btn = restartButtonRef.current;
    if (!btn) return;
    const overlay = btn.closest<HTMLElement>('.timeline-overlay-zone');
    if (!overlay) return;

    const compute = () => {
      const trackWidth = overlay.clientWidth;
      const btnWidth = btn.offsetWidth;
      if (trackWidth <= 0 || btnWidth <= 0) return;
      const halfBtn = btnWidth / 2;
      // If the button is wider than the track (pathological), pin to center.
      if (btnWidth >= trackWidth) {
        setRestartClampedLeftPx(trackWidth / 2);
        return;
      }
      const targetPx = restartProgress * trackWidth;
      const clampedPx = Math.max(halfBtn, Math.min(trackWidth - halfBtn, targetPx));
      setRestartClampedLeftPx(clampedPx);
    };

    compute();
    const ro = new ResizeObserver(compute);
    ro.observe(overlay);
    ro.observe(btn);
    return () => ro.disconnect();
  }, [showRestart, restartProgress]);

  // First render falls back to percentage clamp; useLayoutEffect swaps in the
  // pixel-based clamp before the browser paints, so there is no visible flicker.
  const restartAnchorStyle = restartClampedLeftPx !== null
    ? { left: `${restartClampedLeftPx}px` }
    : getRestartAnchorStyle(restartProgress);

  const overlayContent = showRestart ? (
    <ActionHint
      text={TIMELINE_HINTS.restartFromHere}
      anchorClassName="timeline-restart-anchor"
      anchorStyle={restartAnchorStyle}
    >
      <button
        ref={restartButtonRef}
        className="timeline-restart-button"
        onClick={handleRestart}
        aria-label={`Restart simulation at ${formatTime(restartTargetPs)}`}
      >
        Restart here
      </button>
    </ActionHint>
  ) : <span />;

  const trackContent = (
    <div
      className={`timeline-track timeline-track--thick${hasRange ? '' : ' timeline-track--disabled'}`}
      ref={trackRef}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
    >
      <div className="timeline-fill" style={{ width: `${progress * 100}%` }} />
      {hasRange && <div className="timeline-thumb" style={{ left: `${progress * 100}%` }} />}
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
        action={<TimelineActionZone showTransfer={showTransfer} onTransfer={openTransfer} showClear onClear={openClear} />}
      />
      <TimelineClearDialog open={clear.open} onCancel={clear.cancel} onConfirm={clear.confirm} />
      <TimelineTransferDialog
        open={transferDialog.open}
        tab={transferDialog.tab}
        onTabChange={transferDialog.setTab}
        onCancel={closeTransferSession}

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
        shareSubmitting={shareSubmitting}
        shareError={shareError?.kind === 'other' ? shareError.message : null}
        authNote={shareError?.kind === 'auth' ? shareError.message : null}
        shareUrl={shareResult?.shareUrl ?? null}
        shareCode={shareResult?.shareCode ?? null}
        shareWarnings={shareResult?.warnings ?? null}

        authStatus={authStatus}
        onSignIn={handleAuthSignIn}
        popupBlocked={authPopupBlocked}
        onRetryPopup={handleRetryPopup}
        onSignInSameTab={handleContinueInTab}
        onDismissPopupBlocked={handleDismissPopupBlocked}
      />
    </>
  );
}
