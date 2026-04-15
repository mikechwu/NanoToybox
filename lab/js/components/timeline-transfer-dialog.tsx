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
import type { AuthStatus } from '../store/app-store';
import { hydrateAuthSession } from '../runtime/auth-runtime';
import { AgeGateCheckbox, AGE_INTENT_STALE_AFTER_MS } from './AgeGateCheckbox';

// ── Trigger hook + icon ──

export function useTransferDialog() {
  // Default tab is Share — when both destinations are available the dialog
  // opens on Share (the higher-value, cross-session path). `request()` still
  // accepts an explicit tab, so callers with download-only ranges pass
  // 'download' directly.
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<TransferTab>('share');
  const request = useCallback((initial: TransferTab = 'share') => {
    setTab(initial);
    setOpen(true);
  }, []);
  const cancel = useCallback(() => { setOpen(false); }, []);
  const reset = useCallback(() => { setOpen(false); setTab('share'); }, []);
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
  /** Red in-branch error rendered only in the signed-in panel (above the
   *  Publish button). For 429 rate-limit, generic publish failures, etc. —
   *  NEVER for AuthRequiredError messages (those flow through `authNote`
   *  into the signed-out panel instead). */
  shareError: string | null;
  /** Contextual sign-in note rendered only in the signed-out auth-prompt
   *  panel, alongside the OAuth buttons. Explains why sign-in is being
   *  asked for (e.g. "Your session expired…"). Sourced only from
   *  AuthRequiredError — other error classes MUST NOT reach this slot,
   *  as doing so would misattribute the reason for the prompt. */
  authNote: string | null;
  shareUrl: string | null;
  shareCode: string | null;
  /** Non-fatal server warnings for a real successful publish (e.g.
   *  'quota_accounting_failed'). Rendered as a subtle note alongside
   *  the share URL — never blocks or hides the URL. Keep null when none. */
  shareWarnings: string[] | null;

  // ── Auth UX (Phase 6) ──
  /** Discriminator for the Share panel's four auth-facing states:
   *    loading    → neutral "Checking sign-in…" row
   *    signed-in  → Publish button
   *    signed-out → auth prompt (Continue with Google/GitHub)
   *    unverified → neutral "Can't verify sign-in" row with a Retry button;
   *                 the OAuth prompt is deliberately withheld here so a
   *                 transport blip can't push a signed-in user into an
   *                 unnecessary round-trip. */
  authStatus: AuthStatus;
  /** Invoked when the user clicks one of the auth-prompt buttons. The host
   *  wires this to the store's `authCallbacks.onSignIn(provider, { resumePublish: true, ageIntent, ageIntentMintedAt })`
   *  so we round-trip back into this dialog after OAuth. The dialog owns
   *  the age-gate checkbox state; only a fresh, server-issued `ageIntent`
   *  + its mint time are passed through (mintedAt is required so the
   *  popup-blocked retry path can later detect a stale snapshot). */
  onSignIn: (provider: 'google' | 'github', ageIntent: string, ageIntentMintedAt: number) => void;
  /** Non-null when the most recent sign-in attempt's popup was blocked.
   *  The signed-out branch replaces the provider buttons with a
   *  Retry / Continue-in-tab prompt. */
  popupBlocked: { provider: 'google' | 'github'; resumePublish: boolean } | null;
  /** Called by the popup-blocked prompt's "Retry popup" button. Host
   *  re-invokes onSignIn with the pending provider + resumePublish. */
  onRetryPopup: () => void;
  /** Called by the popup-blocked prompt's "Continue in this tab" button —
   *  the user has consented to the destructive redirect. */
  onSignInSameTab: () => void;
  /** Called by the popup-blocked prompt's Back button — clears the
   *  pending descriptor so the user can pick a different provider. */
  onDismissPopupBlocked: () => void;

  /** When non-null, the publish endpoint returned 428 Precondition
   *  Required — the signed-in user has not yet confirmed age_13_plus.
   *  The Share panel's signed-in branch renders an inline retro-ack
   *  checkbox + "Agree & Retry" button instead of the publish button. */
  ageConfirmationRequired: {
    message: string;
    policyVersion: string | null;
  } | null;
  /** Called when the user accepts the retro-ack. Host POSTs to
   *  `/api/account/age-confirmation` then re-attempts the publish. */
  onAgeConfirmationAck: () => void;
}

/** Human-readable provider label used by the popup-blocked sub-panel
 *  copy ("Google popup was blocked…"). Kept as a tiny helper so the
 *  mapping lives in one place if provider IDs diverge from labels. */
function providerLabel(provider: 'google' | 'github'): string {
  return provider === 'google' ? 'Google' : 'GitHub';
}

/** Cancel-row pattern shared by 4 of the 5 Share-panel branches. The
 *  signed-in branch adds a Publish button as a child; the unverified branch
 *  adds a Retry button; success/loading/signed-out have no extra child.
 *  Keeping the wrapper inline (not in its own file) preserves locality and
 *  the per-branch class/disabled semantics. */
function ShareActions({
  onCancel, transferBusy, cancelLabel = 'Cancel', children, leadingLink,
}: {
  onCancel: () => void;
  transferBusy: boolean;
  cancelLabel?: string;
  children?: React.ReactNode;
  /** Optional left-aligned secondary action (typically a navigation
   *  link). Floats to the row's leading edge via `margin-right: auto`
   *  so the cancel/confirm buttons stay anchored to the right. Used by
   *  the share-success branch to host "Manage uploads" without
   *  cramping the success copy above the divider. */
  leadingLink?: React.ReactNode;
}) {
  return (
    <div className="timeline-transfer-dialog__actions">
      {leadingLink}
      <button
        className="timeline-transfer-dialog__cancel"
        onClick={onCancel}
        disabled={transferBusy}
      >
        {cancelLabel}
      </button>
      {children}
    </div>
  );
}

export function TimelineTransferDialog(props: TimelineTransferDialogProps) {
  const {
    open, tab, onTabChange, onCancel,
    downloadTabAvailable, availableKinds, downloadKind, onSelectDownloadKind, onConfirmDownload,
    downloadSubmitting, downloadError, downloadConfirmEnabled, fullEstimate, capsuleEstimate,
    shareTabAvailable, shareConfirmEnabled, onConfirmShare,
    shareSubmitting, shareError, authNote, shareUrl, shareCode, shareWarnings,
    authStatus, onSignIn, popupBlocked, onRetryPopup, onSignInSameTab, onDismissPopupBlocked,
    ageConfirmationRequired, onAgeConfirmationAck,
  } = props;
  const [retryingAuth, setRetryingAuth] = useState(false);
  const [ageConfirmed, setAgeConfirmed] = useState(false);
  const [ageIntent, setAgeIntent] = useState<string | null>(null);
  const [ageMintedAt, setAgeMintedAt] = useState<number | null>(null);
  const [ageStaleNote, setAgeStaleNote] = useState<string | null>(null);
  const [ageRefreshNonce, setAgeRefreshNonce] = useState(0);
  const [ageFetching, setAgeFetching] = useState(false);
  const handleAgeIntent = useCallback((token: string | null, mintedAt: number | null) => {
    setAgeIntent(token);
    setAgeMintedAt(mintedAt);
    if (token) setAgeStaleNote(null);
  }, []);
  const handleAgeSignIn = useCallback(
    (provider: 'google' | 'github') => {
      if (!ageIntent || ageMintedAt === null) return;
      // Click-time freshness check — see AccountControl for the
      // popup-blocker rationale (we cannot await the fetch here). On
      // stale token we drop it AND bump the refresh nonce so the
      // AgeGateCheckbox effect actually re-fires; the periodic timer
      // alone would leave us idle for up to 4 min.
      if (Date.now() - ageMintedAt > AGE_INTENT_STALE_AFTER_MS) {
        setAgeStaleNote('Refreshing sign-in… click again in a moment.');
        setAgeIntent(null);
        setAgeMintedAt(null);
        setAgeRefreshNonce((n) => n + 1);
        return;
      }
      onSignIn(provider, ageIntent, ageMintedAt);
    },
    [ageIntent, ageMintedAt, onSignIn],
  );
  const [retroAckChecked, setRetroAckChecked] = useState(false);

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
        {/* No visible heading — the Download / Share tab row is
         *  itself the dialog's header, and the dialog's accessible
         *  name is carried by `aria-label` on the outer `role="dialog"`
         *  above. Saves a row of vertical chrome on mobile. */}

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

        {/* Share panel — only rendered when tab is share AND share is available.
         *  Five distinct states, picked in priority order:
         *    1. shareSuccess    → we already published; show link + copy
         *    2. loading         → neutral "Checking sign-in…" row
         *    3. unverified      → "Can't verify" with Retry (no OAuth prompt)
         *    4. signed-out      → auth prompt (Continue with Google/GitHub)
         *    5. signed-in       → description + Publish button
         *  States (2), (3), (4) render their own Cancel-only action row.
         *  State (5) shows Cancel + Publish; state (1) shows Close. */}
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
                {/* No shareError render here — handleShareConfirm clears
                 *  shareError before setting shareResult, and the auth-status
                 *  effect in TimelineBar clears it on any status transition
                 *  that could repaint this branch.
                 *
                 *  "Manage uploads" lives in the action row as a leading
                 *  link, NOT as a floating paragraph between the code line
                 *  and the divider — that earlier placement crowded the
                 *  separator and read as an unfinished thought. As an
                 *  action-row peer it's clearly a secondary navigation
                 *  alongside Close, with the divider doing its proper job. */}
                <ShareActions
                  onCancel={handleCancel}
                  transferBusy={transferBusy}
                  cancelLabel="Close"
                  leadingLink={
                    <a
                      className="timeline-transfer-dialog__manage-link"
                      href="/account/"
                      target="_blank"
                      rel="noopener noreferrer"
                      data-testid="transfer-manage-uploads"
                      aria-label="Manage uploads (opens in new tab)"
                    >
                      Manage uploads
                    </a>
                  }
                />
              </div>
            ) : authStatus === 'loading' ? (
              <div className="timeline-transfer-dialog__auth-checking" aria-live="polite">
                <p className="timeline-transfer-dialog__description">Checking sign-in…</p>
                <ShareActions onCancel={handleCancel} transferBusy={transferBusy} />
              </div>
            ) : authStatus === 'unverified' ? (
              <div className="timeline-transfer-dialog__auth-unverified" data-testid="transfer-auth-unverified">
                <p className="timeline-transfer-dialog__description">
                  Can't verify sign-in right now. Retry or continue later.
                </p>
                <ShareActions onCancel={handleCancel} transferBusy={transferBusy}>
                  <button
                    className="timeline-transfer-dialog__confirm"
                    onClick={async () => {
                      setRetryingAuth(true);
                      try { await hydrateAuthSession(); }
                      finally { setRetryingAuth(false); }
                    }}
                    disabled={transferBusy || retryingAuth}
                    data-testid="transfer-auth-retry"
                  >
                    {retryingAuth ? 'Checking\u2026' : 'Retry'}
                  </button>
                </ShareActions>
              </div>
            ) : authStatus === 'signed-out' ? (
              <div className="timeline-transfer-dialog__auth-prompt" data-testid="transfer-auth-prompt">
                <p className="timeline-transfer-dialog__description">
                  Sign in to publish a share link. Anyone with the link can open it
                  in Watch without signing in.
                </p>
                {/* authNote is set ONLY from AuthRequiredError.message — other
                 *  error classes (429, generic publish failure) never reach
                 *  this slot because the host component splits shareError
                 *  by kind before passing it down. This prevents the
                 *  "Publish quota exceeded…" bleed that an earlier
                 *  string-only `shareError` allowed when opportunistic
                 *  hydrate flipped signed-in → signed-out. */}
                {authNote && (
                  <p
                    className="timeline-transfer-dialog__auth-note"
                    role="status"
                    aria-live="polite"
                    data-testid="transfer-auth-note"
                  >
                    {authNote}
                  </p>
                )}
                {popupBlocked ? (
                  /* Popup-blocked sub-panel — replaces the provider buttons
                   *  with an explicit Retry / Continue-in-tab / Back choice
                   *  so we never silently destroy in-memory Lab state on a
                   *  same-tab redirect the user didn't ask for, and the
                   *  user can back out to pick a different provider. */
                  <div className="timeline-transfer-dialog__popup-blocked" data-testid="transfer-popup-blocked">
                    <p className="timeline-transfer-dialog__auth-note" role="status" aria-live="polite">
                      {providerLabel(popupBlocked.provider)} popup was blocked. Retry, continue in this tab,
                      or go back to choose another sign-in method —
                      unsaved Lab state may be lost on same-tab sign-in.
                    </p>
                    <div className="timeline-transfer-dialog__auth-buttons">
                      <button
                        className="timeline-transfer-dialog__auth-button"
                        onClick={onRetryPopup}
                        disabled={transferBusy}
                        data-testid="transfer-popup-retry"
                      >
                        Retry {providerLabel(popupBlocked.provider)} popup
                      </button>
                      <button
                        className="timeline-transfer-dialog__auth-button"
                        onClick={onSignInSameTab}
                        disabled={transferBusy}
                        data-testid="transfer-popup-same-tab"
                      >
                        Continue in this tab
                      </button>
                      <button
                        className="timeline-transfer-dialog__auth-button timeline-transfer-dialog__auth-button--subtle"
                        onClick={onDismissPopupBlocked}
                        disabled={transferBusy}
                        data-testid="transfer-popup-back"
                      >
                        Back
                      </button>
                    </div>
                  </div>
                ) : (
                  <>
                    <AgeGateCheckbox
                      checked={ageConfirmed}
                      onCheckedChange={setAgeConfirmed}
                      onAgeIntent={handleAgeIntent}
                      onFetchingChange={setAgeFetching}
                      refreshNonce={ageRefreshNonce}
                      idSuffix="transfer"
                    />
                    {ageStaleNote && !ageIntent ? (
                      <p className="age-gate__note" role="status" aria-live="polite">
                        {ageFetching ? 'Refreshing sign-in…' : ageStaleNote}
                      </p>
                    ) : null}
                    <div className="timeline-transfer-dialog__auth-buttons">
                      <button
                        className="timeline-transfer-dialog__auth-button"
                        onClick={() => handleAgeSignIn('google')}
                        disabled={transferBusy || !ageConfirmed || !ageIntent}
                        data-testid="transfer-auth-google"
                      >
                        Continue with Google
                      </button>
                      <button
                        className="timeline-transfer-dialog__auth-button"
                        onClick={() => handleAgeSignIn('github')}
                        disabled={transferBusy || !ageConfirmed || !ageIntent}
                        data-testid="transfer-auth-github"
                      >
                        Continue with GitHub
                      </button>
                    </div>
                  </>
                )}
                <ShareActions onCancel={handleCancel} transferBusy={transferBusy} />
              </div>
            ) : ageConfirmationRequired ? (
              /* signed-in, but publish returned 428 — retro-ack needed. */
              <>
                <p className="timeline-transfer-dialog__description">
                  Before publishing, please confirm you are at least 13 and have
                  read our updated <a href="/privacy/" target="_blank" rel="noopener noreferrer">Privacy Policy</a>
                  {' '}and <a href="/terms/" target="_blank" rel="noopener noreferrer">Terms</a>.
                </p>
                <label className="age-gate__label">
                  <input
                    type="checkbox"
                    checked={retroAckChecked}
                    onChange={(e) => setRetroAckChecked(e.target.checked)}
                    data-testid="transfer-retro-ack"
                  />
                  <span>I confirm that I am at least 13 years old.</span>
                </label>
                <ShareActions onCancel={handleCancel} transferBusy={transferBusy}>
                  <button
                    className="timeline-transfer-dialog__confirm"
                    onClick={onAgeConfirmationAck}
                    disabled={transferBusy || !retroAckChecked}
                    data-testid="transfer-retro-ack-confirm"
                  >
                    Agree &amp; publish
                  </button>
                </ShareActions>
              </>
            ) : (
              /* signed-in */
              <>
                <p className="timeline-transfer-dialog__description">
                  Publish this capsule to get a share link that anyone can open in Watch.
                </p>
                {shareError && <p className="timeline-transfer-dialog__error">{shareError}</p>}
                <ShareActions onCancel={handleCancel} transferBusy={transferBusy}>
                  <button
                    className="timeline-transfer-dialog__confirm"
                    onClick={onConfirmShare}
                    disabled={transferBusy || !shareConfirmEnabled}
                  >
                    {shareSubmitting ? 'Publishing\u2026' : 'Publish'}
                  </button>
                </ShareActions>
              </>
            )}
          </div>
        )}
      </div>
    </>,
    document.body,
  );
}
