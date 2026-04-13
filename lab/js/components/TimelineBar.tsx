/**
 * TimelineBar — composition layer for the timeline UI.
 *
 * Layout contract (CSS variables defined on .timeline-bar):
 *   --tl-rail-width   Mode rail width (96px desktop, 84px mobile)
 *   --tl-time-width   Time column width (56px desktop, 48px mobile)
 *   --tl-action-width Action column width (64px, two-slot: export + clear)
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
 *   timeline-export-dialog.tsx — TimelineExportDialog, useExportDialog, ExportTrigger
 */

import React, { useCallback, useRef, useState, useEffect } from 'react';
import { useAppStore } from '../store/app-store';
import { formatTime, getTimelineProgress, getRestartAnchorStyle } from './timeline-format';
import { TimelineModeSwitch } from './timeline-mode-switch';
import { TimelineClearDialog, useClearConfirm, ClearTrigger } from './timeline-clear-dialog';
import { TimelineExportDialog, useExportDialog, ExportTrigger } from './timeline-export-dialog';
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

// ── Action zone (two-slot: export + clear) ──

/** Renders triggers only. Dialogs are siblings rendered by the parent.
 *  Always produces two slot wrappers for invariant 64px layout.
 *  Callers must pair showExport/showClear=true with their corresponding handler. */
function TimelineActionZone({ showExport, onExport, showClear, onClear }: {
  showExport: boolean;
  onExport?: () => void;
  showClear: boolean;
  onClear?: () => void;
}) {
  return (
    <>
      <span className="timeline-action-slot timeline-action-slot--export">
        {showExport && onExport ? (
          <ExportTrigger onClick={onExport} />
        ) : (
          <span className="timeline-action-spacer" aria-hidden="true" />
        )}
      </span>
      <span className="timeline-action-slot timeline-action-slot--clear">
        {showClear && onClear ? (
          <ClearTrigger onClick={onClear} />
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
      action={<TimelineActionZone showExport={false} showClear={false} />}
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
        action={<TimelineActionZone showExport={false} showClear onClear={clear.request} />}
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

  // Export visibility — sole render gate (store capability, not callback presence)
  const exportAvailable = !!(exportCaps?.full || exportCaps?.capsule);
  const showExport = hasRange && exportAvailable;

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

  // Export dialog
  const exportDialog = useExportDialog();
  const [exportSubmitting, setExportSubmitting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  // Preferred default kind — computed at open time, not hook init
  const preferredKind = exportCaps?.capsule ? 'capsule' as const : 'full' as const;

  // Dialog mutual exclusion
  const openExport = useCallback(() => {
    clear.reset();
    setExportSubmitting(false);
    setExportError(null);
    exportDialog.setKind(preferredKind);
    exportDialog.request();
  }, [clear, exportDialog, preferredKind]);

  const openClear = useCallback(() => {
    exportDialog.reset();
    setExportSubmitting(false);
    setExportError(null);
    clear.request();
  }, [clear, exportDialog]);

  // Export action guard — defend against impossible state
  const exportActionAvailable = !!callbacks?.onExportHistory && exportAvailable;

  // Mounted ref for safe async state updates after dialog close or unmount
  const mountedRef = useRef(true);
  useEffect(() => () => { mountedRef.current = false; }, []);

  const handleExportConfirm = useCallback(async () => {
    if (!callbacks?.onExportHistory) {
      setExportError('Export is not available right now.');
      return;
    }
    setExportSubmitting(true);
    setExportError(null);
    try {
      await callbacks.onExportHistory(exportDialog.kind);
      if (mountedRef.current) exportDialog.reset();
    } catch (e) {
      if (mountedRef.current) {
        setExportError(e instanceof Error ? e.message : 'Export failed.');
      }
    } finally {
      if (mountedRef.current) setExportSubmitting(false);
    }
  }, [callbacks, exportDialog]);

  const isReview = mode === 'review';

  // Guard: close clear dialog on mode transition
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (!isReview) clear.reset(); }, [isReview]);

  // Guard: close export dialog when showExport becomes false
  useEffect(() => {
    if (!showExport) {
      exportDialog.reset();
      setExportSubmitting(false);
      setExportError(null);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showExport]);

  // Guard: revalidate selected kind if capability changes while dialog is open
  useEffect(() => {
    if (!exportDialog.open) return;
    if (exportDialog.kind === 'full' && !exportCaps?.full && exportCaps?.capsule) exportDialog.setKind('capsule');
    if (exportDialog.kind === 'capsule' && !exportCaps?.capsule && exportCaps?.full) exportDialog.setKind('full');
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [exportDialog.open, exportDialog.kind, exportCaps]);

  const overlayContent = isReview && canRestart && restartTargetPs !== null ? (
    <ActionHint
      text={TIMELINE_HINTS.restartFromHere}
      anchorClassName="timeline-restart-anchor"
      anchorStyle={getRestartAnchorStyle(restartProgress)}
    >
      <button
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
        action={<TimelineActionZone showExport={showExport} onExport={openExport} showClear onClear={openClear} />}
      />
      <TimelineClearDialog open={clear.open} onCancel={clear.cancel} onConfirm={clear.confirm} />
      <TimelineExportDialog
        open={exportDialog.open}
        availableKinds={exportCaps ?? { full: false, capsule: false }}
        kind={exportDialog.kind}
        submitting={exportSubmitting}
        confirmEnabled={exportActionAvailable && !exportSubmitting}
        error={exportError}
        onSelectKind={exportDialog.setKind}
        onCancel={exportDialog.cancel}
        onConfirm={handleExportConfirm}
      />
    </>
  );
}
