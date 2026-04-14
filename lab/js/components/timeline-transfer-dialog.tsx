/**
 * Timeline transfer dialog — unified download + share surface.
 *
 * One entry point (cloud up/down icon) opens a single dialog with two tabs:
 *   - Download: local file save (capsule or full) — delegates to onExportHistory
 *   - Share:    publish to cloud + get share link — delegates to onPublishCapsule
 *
 * This replaces the previous stacked PublishTrigger + ExportTrigger pair so the
 * action lane has one compact, discoverable control instead of two tiny ones.
 *
 * Accessibility: mirrors the export dialog contract (focus trap, Escape,
 * backdrop, role="dialog", aria-modal).
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ActionHint } from './ActionHint';
import type { TimelineExportKind } from './timeline-export-dialog';

// ── Trigger hook + icon ──

export function useTransferDialog() {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<TransferTab>('download');
  const request = useCallback((initial: TransferTab = 'download') => {
    setTab(initial);
    setOpen(true);
  }, []);
  const cancel = useCallback(() => { setOpen(false); }, []);
  const reset = useCallback(() => { setOpen(false); setTab('download'); }, []);
  return { open, tab, request, cancel, reset, setTab };
}

export type TransferTab = 'download' | 'share';

function TransferIcon() {
  // Two parallel arrows (up + down) — the shared "transfer" glyph.
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M17 20V8m0 12l-3.5-3.5M17 20l3.5-3.5M7 17V4m0 0L3.5 7.5M7 4l3.5 3.5" />
    </svg>
  );
}

export function TransferTrigger({ onClick, label = 'Transfer history' }: { onClick: () => void; label?: string }) {
  return (
    <ActionHint text={label}>
      <button
        className="timeline-transfer-trigger"
        onClick={onClick}
        aria-label={label}
      >
        <TransferIcon />
      </button>
    </ActionHint>
  );
}

// ── Dialog ──

type EstimateValue = string | null | undefined;

/**
 * Map server warning codes to a subtle human-readable note.
 *
 * The note is shown alongside the share URL (never replacing it) so
 * operators / support debugging a user-reported issue can see the
 * reconciliation signal without confusing normal users. Keep text
 * neutral — the share IS valid, accounting just needs review.
 */
function formatShareWarning(codes: readonly string[]): string {
  if (codes.includes('quota_accounting_failed')) {
    return 'Share created. Background accounting needs operator review.';
  }
  // Unknown warning — surface it literally but don't alarm.
  return `Share created. Note: ${codes.join(', ')}`;
}

function EstimateSlot({ value }: { value: EstimateValue }) {
  if (value === undefined) {
    return <span className="timeline-transfer-dialog__estimate timeline-transfer-dialog__estimate--muted" aria-live="polite">Estimating…</span>;
  }
  if (value === null) {
    return <span className="timeline-transfer-dialog__estimate timeline-transfer-dialog__estimate--muted" aria-live="polite">Unavailable</span>;
  }
  return <span className="timeline-transfer-dialog__estimate" aria-live="polite">{value}</span>;
}

interface TimelineTransferDialogProps {
  open: boolean;
  tab: TransferTab;
  onTabChange: (tab: TransferTab) => void;
  onCancel: () => void;

  // ── Download (export) ──
  /** Whether the Download tab is selectable/useable at all. */
  downloadTabAvailable: boolean;
  /** Per-kind availability within Download (only used when downloadTabAvailable). */
  availableKinds: { full: boolean; capsule: boolean };
  downloadKind: TimelineExportKind;
  onSelectDownloadKind: (kind: TimelineExportKind) => void;
  onConfirmDownload: () => void;
  downloadSubmitting: boolean;
  downloadError: string | null;
  /** Confirm-button enablement (callback wired + per-kind ok). */
  downloadConfirmEnabled: boolean;
  fullEstimate?: EstimateValue;
  capsuleEstimate?: EstimateValue;

  // ── Share (publish) ──
  /** Whether the Share tab is selectable/useable at all. */
  shareTabAvailable: boolean;
  /** Confirm-button enablement for Share (callback wired + range present). */
  shareConfirmEnabled: boolean;
  onConfirmShare: () => void;
  shareSubmitting: boolean;
  shareError: string | null;
  shareUrl: string | null;
  shareCode: string | null;
  /** Non-fatal server warnings for a real successful publish (e.g.
   *  'quota_accounting_failed'). Rendered as a subtle note alongside
   *  the share URL — never blocks or hides the URL. Keep null when none. */
  shareWarnings: string[] | null;
}

export function TimelineTransferDialog(props: TimelineTransferDialogProps) {
  const {
    open, tab, onTabChange, onCancel,
    downloadTabAvailable, availableKinds, downloadKind, onSelectDownloadKind, onConfirmDownload,
    downloadSubmitting, downloadError, downloadConfirmEnabled, fullEstimate, capsuleEstimate,
    shareTabAvailable, shareConfirmEnabled, onConfirmShare,
    shareSubmitting, shareError, shareUrl, shareCode, shareWarnings,
  } = props;

  const dialogRef = useRef<HTMLDivElement>(null);
  const prevOpen = useRef(false);
  const [copied, setCopied] = useState(false);

  // Dialog-level busy guard — one operation at a time.
  // While busy: close/cancel/tab-switch are disabled (Escape is also ignored)
  // to prevent hiding an in-flight publish/download behind a closed dialog.
  const transferBusy = downloadSubmitting || shareSubmitting;

  // Cancel only allowed when not busy; wire through a guarded handler.
  const handleCancel = useCallback(() => {
    if (transferBusy) return;
    onCancel();
  }, [transferBusy, onCancel]);

  const handleTabChange = useCallback((next: TransferTab) => {
    if (transferBusy) return;
    onTabChange(next);
  }, [transferBusy, onTabChange]);

  // Focus management on open transition
  useEffect(() => {
    if (open && !prevOpen.current) {
      requestAnimationFrame(() => {
        const first = dialogRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)');
        first?.focus();
      });
    }
    prevOpen.current = open;
  }, [open]);

  // Reset copy indicator on close
  useEffect(() => { if (!open) setCopied(false); }, [open]);

  // Escape + focus trap. Escape is suppressed while busy so an in-flight
  // submission cannot be hidden by a stray keystroke.
  useEffect(() => {
    if (!open) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        e.preventDefault();
        if (!transferBusy) onCancel();
      }
      if (e.key === 'Tab' && dialogRef.current) {
        const focusable = dialogRef.current.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), [tabindex="0"]');
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault(); last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault(); first.focus();
        }
      }
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [open, onCancel, transferBusy]);

  const handleCopy = useCallback(async () => {
    if (!shareUrl) return;
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard may be unavailable (permissions, insecure context) — ignore.
    }
  }, [shareUrl]);

  if (!open) return null;

  const shareSuccess = shareUrl !== null;
  // Hide the tab bar entirely when only one destination is available —
  // keeps the interface focused instead of showing a dead tab.
  const showTabBar = downloadTabAvailable && shareTabAvailable;
  // Backdrop click only cancels when we are not mid-submission.
  const handleBackdropClick = transferBusy ? undefined : onCancel;

  return createPortal(
    <>
      <div className="timeline-dialog-backdrop" onClick={handleBackdropClick} />
      <div
        className="timeline-modal-card timeline-transfer-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Transfer history"
        aria-busy={transferBusy}
        ref={dialogRef}
      >
        <p className="timeline-transfer-dialog__title">Transfer History</p>

        {/* Tab bar (omitted when only one destination is available) */}
        {showTabBar && (
          <div className="timeline-transfer-dialog__tabs" role="tablist" aria-label="Transfer destination">
            <button
              role="tab"
              aria-selected={tab === 'download'}
              className={`timeline-transfer-dialog__tab${tab === 'download' ? ' timeline-transfer-dialog__tab--active' : ''}`}
              onClick={() => handleTabChange('download')}
              disabled={transferBusy && tab !== 'download'}
            >
              Download
            </button>
            <button
              role="tab"
              aria-selected={tab === 'share'}
              className={`timeline-transfer-dialog__tab${tab === 'share' ? ' timeline-transfer-dialog__tab--active' : ''}`}
              onClick={() => handleTabChange('share')}
              disabled={transferBusy && tab !== 'share'}
            >
              Share
            </button>
          </div>
        )}

        {/* Download panel — only rendered when tab is download AND download is available */}
        {tab === 'download' && downloadTabAvailable && (
          <div role="tabpanel" aria-label="Download">
            <div className="timeline-transfer-dialog__options" role="radiogroup" aria-label="Download format">
              <label className={`timeline-transfer-dialog__option${!availableKinds.capsule ? ' timeline-transfer-dialog__option--disabled' : ''}`}>
                <input
                  className="timeline-transfer-dialog__radio-native"
                  type="radio"
                  name="download-kind"
                  value="capsule"
                  checked={downloadKind === 'capsule'}
                  disabled={!availableKinds.capsule || transferBusy}
                  onChange={() => onSelectDownloadKind('capsule')}
                />
                <span className="timeline-transfer-dialog__radio-ui" aria-hidden="true" />
                <span className="timeline-transfer-dialog__option-text">
                  <strong>Capsule</strong>
                  <span>Compact playback</span>
                  {availableKinds.capsule && <EstimateSlot value={capsuleEstimate} />}
                </span>
              </label>
              <label className={`timeline-transfer-dialog__option${!availableKinds.full ? ' timeline-transfer-dialog__option--disabled' : ''}`}>
                <input
                  className="timeline-transfer-dialog__radio-native"
                  type="radio"
                  name="download-kind"
                  value="full"
                  checked={downloadKind === 'full'}
                  disabled={!availableKinds.full || transferBusy}
                  onChange={() => onSelectDownloadKind('full')}
                />
                <span className="timeline-transfer-dialog__radio-ui" aria-hidden="true" />
                <span className="timeline-transfer-dialog__option-text">
                  <strong>Full</strong>
                  <span>Review-complete playback</span>
                  {availableKinds.full && <EstimateSlot value={fullEstimate} />}
                </span>
              </label>
            </div>
            {downloadError && <p className="timeline-transfer-dialog__error">{downloadError}</p>}
            <div className="timeline-transfer-dialog__actions">
              <button
                className="timeline-transfer-dialog__cancel"
                onClick={handleCancel}
                disabled={transferBusy}
              >
                Cancel
              </button>
              <button
                className="timeline-transfer-dialog__confirm"
                onClick={onConfirmDownload}
                disabled={transferBusy || !downloadConfirmEnabled}
              >
                {downloadSubmitting ? 'Downloading\u2026' : 'Download'}
              </button>
            </div>
          </div>
        )}

        {/* Share panel — only rendered when tab is share AND share is available */}
        {tab === 'share' && shareTabAvailable && (
          <div role="tabpanel" aria-label="Share">
            {shareSuccess ? (
              <div className="timeline-transfer-dialog__success">
                <p className="timeline-transfer-dialog__url-label">Share link:</p>
                <div className="timeline-transfer-dialog__url-row">
                  <input
                    className="timeline-transfer-dialog__url-input"
                    type="text"
                    value={shareUrl}
                    readOnly
                    onFocus={(e) => e.target.select()}
                  />
                  <button className="timeline-transfer-dialog__copy" onClick={handleCopy}>
                    {copied ? 'Copied' : 'Copy'}
                  </button>
                </div>
                {shareCode && (
                  <p className="timeline-transfer-dialog__code">
                    Code: <code>{shareCode}</code>
                  </p>
                )}
                {shareWarnings && shareWarnings.length > 0 && (
                  <p
                    className="timeline-transfer-dialog__warning"
                    role="status"
                    aria-live="polite"
                    data-testid="transfer-dialog-warning"
                  >
                    {formatShareWarning(shareWarnings)}
                  </p>
                )}
              </div>
            ) : (
              <p className="timeline-transfer-dialog__description">
                Publish this capsule to get a share link that anyone can open in Watch.
              </p>
            )}
            {shareError && <p className="timeline-transfer-dialog__error">{shareError}</p>}
            <div className="timeline-transfer-dialog__actions">
              <button
                className="timeline-transfer-dialog__cancel"
                onClick={handleCancel}
                disabled={transferBusy}
              >
                {shareSuccess ? 'Close' : 'Cancel'}
              </button>
              {!shareSuccess && (
                <button
                  className="timeline-transfer-dialog__confirm"
                  onClick={onConfirmShare}
                  disabled={transferBusy || !shareConfirmEnabled}
                >
                  {shareSubmitting ? 'Publishing\u2026' : 'Publish'}
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </>,
    document.body,
  );
}
