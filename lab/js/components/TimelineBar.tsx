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
  const [shareError, setShareError] = useState<string | null>(null);
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
    // Default to Download tab, but land on Share if download is not actionable.
    transferDialog.request(downloadActionAvailable ? 'download' : 'share');
  }, [clear, preferredKind, callbacks, transferDialog, downloadActionAvailable]);

  const openClear = useCallback(() => {
    closeTransferSession();
    clear.request();
  }, [clear, closeTransferSession]);

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
      setShareError('Share is not available right now.');
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
      console.error('[TimelineBar] share failed:', e);
      if (mountedRef.current && shareRunIdRef.current === runId) {
        setShareError(e instanceof Error ? e.message : 'Share failed.');
        setShareSubmitting(false);
      }
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
        shareConfirmEnabled={shareAvailable}
        onConfirmShare={handleShareConfirm}
        shareSubmitting={shareSubmitting}
        shareError={shareError}
        shareUrl={shareResult?.shareUrl ?? null}
        shareCode={shareResult?.shareCode ?? null}
        shareWarnings={shareResult?.warnings ?? null}
      />
    </>
  );
}
