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
import { ActionHint } from '../ActionHint';
import type { TimelineExportKind } from './timeline-export-dialog';
import { useAppStore } from '../../store/app-store';
import type { AuthStatus } from '../../store/app-store';
import { hydrateAuthSession } from '../../runtime/auth-runtime';
import { AgeClickwrapNotice } from '../AgeClickwrapNotice';

/** Canonical wording for the Transfer trigger's tooltip.
 *  Considered:
 *    · "Transfer history"   — generic / technical, the previous copy
 *    · "Export"             — narrow, omits the Share path
 *    · "Save or share"      — clear but reads as a choice the user
 *                             must make up-front
 *    · "Share & Save"       — friendlier but obscures that Save
 *                             means a local file
 *    · "Share & Download"   ✓ maps 1:1 to the dialog's two tabs
 *                             (Share / Download) so the user knows
 *                             exactly what the click will offer.
 *                             Colloquial, short, unambiguous.
 */
export const TRANSFER_HINT_COPY = 'Share & Download';

/** Delay between the first atom interaction and the timed cue's
 *  fade-in. Long enough that the cue doesn't step on the user's
 *  ongoing action; short enough that the association is still felt. */
const TRANSFER_HINT_TIMED_CUE_DELAY_MS = 5_000;

/** Total on-screen duration of the timed cue (fade-in + stay + fade-out).
 *  The CSS animation `.timeline-hint--force-visible` uses the same
 *  duration; JS only needs to drop `forceVisible` when it elapses so
 *  the animation's `forwards` fill doesn't pin opacity. */
const TRANSFER_HINT_TIMED_CUE_DURATION_MS = 5_000;

const CLICKWRAP_SHARE_ID = 'age-clickwrap-share';
const CLICKWRAP_PUBLISH_ID = 'age-clickwrap-publish';

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

export function TransferTrigger({ onClick, label = TRANSFER_HINT_COPY }: { onClick: () => void; label?: string }) {
  // Trigger B (timed cue): fade the hint in 5 seconds after the first
  // atom interaction — 1 s fade-in, 3 s stay, 1 s fade-out. The CSS
  // keyframe `.timeline-hint--force-visible` owns the opacity curve so
  // the JS side is trivial: set forceVisible for the animation
  // duration, then clear it. Runs at most once per page load (guarded
  // by `firedRef`) regardless of how many times atoms are touched.
  const hasAtomInteraction = useAppStore((s) => s.hasAtomInteraction);
  const [timedVisible, setTimedVisible] = useState(false);
  // Bump this every time the timed cue opens so ActionHint can
  // re-key the tooltip span and CSS animation restarts from 0%.
  const [animationKey, setAnimationKey] = useState(0);
  const firedRef = useRef(false);
  const delayTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const endTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!hasAtomInteraction) return;
    if (firedRef.current) return;
    firedRef.current = true;

    delayTimerRef.current = setTimeout(() => {
      delayTimerRef.current = null;
      setAnimationKey((k) => k + 1);
      setTimedVisible(true);
      endTimerRef.current = setTimeout(() => {
        endTimerRef.current = null;
        setTimedVisible(false);
      }, TRANSFER_HINT_TIMED_CUE_DURATION_MS);
    }, TRANSFER_HINT_TIMED_CUE_DELAY_MS);

    return () => {
      if (delayTimerRef.current !== null) {
        clearTimeout(delayTimerRef.current);
        delayTimerRef.current = null;
      }
      if (endTimerRef.current !== null) {
        clearTimeout(endTimerRef.current);
        endTimerRef.current = null;
      }
    };
  }, [hasAtomInteraction]);

  return (
    <ActionHint
      text={label}
      forceVisible={timedVisible}
      forceAnimationKey={animationKey}
    >
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

/** Format a future ISO timestamp as a short relative phrase. Uses the
 *  native Intl.RelativeTimeFormat when available (every modern browser)
 *  and falls back to a terse English phrase otherwise.
 *
 *  The chip layer pairs this with the absolute timestamp in a `title`
 *  attribute + a side-labeled `<span class="…__expiry-chip-abs">` so
 *  users who prefer the concrete date are never more than a hover away.
 *
 *  "Just now" is surfaced for the narrow window immediately after
 *  publish where the chip briefly renders before any rounding kicks in.
 *  Negative deltas (clock drift between client + server > server expiry)
 *  render as "moments ago" rather than leaking a nonsensical "-1h". */
function formatRelativeFromNow(iso: string): string {
  const target = new Date(iso).getTime();
  if (!Number.isFinite(target)) return iso;
  const diffMs = target - Date.now();
  const absMs = Math.abs(diffMs);
  if (absMs < 45 * 1000) return diffMs < 0 ? 'moments ago' : 'in moments';

  const rtf =
    typeof Intl !== 'undefined' && typeof Intl.RelativeTimeFormat === 'function'
      ? new Intl.RelativeTimeFormat(undefined, { numeric: 'auto', style: 'long' })
      : null;

  const ranges: Array<{ unit: Intl.RelativeTimeFormatUnit; ms: number }> = [
    { unit: 'day', ms: 86_400_000 },
    { unit: 'hour', ms: 3_600_000 },
    { unit: 'minute', ms: 60_000 },
  ];
  for (const { unit, ms } of ranges) {
    if (absMs >= ms) {
      const value = Math.round(diffMs / ms);
      if (rtf) return rtf.format(value, unit);
      return value >= 0 ? `in ${value} ${unit}${value === 1 ? '' : 's'}` : `${-value} ${unit}${-value === 1 ? '' : 's'} ago`;
    }
  }
  return diffMs < 0 ? 'moments ago' : 'in moments';
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
  /** Invoked when the user clicks one of the auth-prompt buttons. The
   *  host wires this to `authCallbacks.onSignIn(provider, { resumePublish: true })`
   *  — note: NO age-intent argument. The runtime owns the popup-shell-
   *  then-fetch-then-navigate sequence (D120 — supersedes D118), so the
   *  dialog click handler stays synchronous and inside the user gesture.
   *  Awaiting any fetch here would break popup-not-blocked semantics. */
  onSignIn: (provider: 'google' | 'github') => void;
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
   *  Required — the signed-in user has no acceptance row on file.
   *  The Share panel's signed-in branch renders the publish-clickwrap
   *  fallback (D120 — supersedes D118): a single Publish button above
   *  the clickwrap notice. Clicking IS the consent — no checkbox. */
  ageConfirmationRequired: {
    message: string;
    policyVersion: string | null;
  } | null;
  /** Called when the user clicks Publish on the publish-clickwrap
   *  fallback. Host POSTs to `/api/account/age-confirmation` (which
   *  calls the shared `recordAge13PlusAcceptance` helper) then
   *  re-attempts the publish. */
  onAgeConfirmationAck: () => void;

  // ── Trim mode (Capsule Too Large) ──
  /** When non-null, the Share panel renders the trim-mode copy and
   *  action set instead of the plain signed-in Publish branch. */
  shareTrim: TrimDialogState | null;
  /** True while a prepare is in flight at publish-click time. Drives
   *  the "Preparing…" label and the tab-switch disable rule; also
   *  controls which "measuring" copy the status row renders. */
  shareMeasuring: boolean;
  onResetShareTrim: () => void;
  onConfirmShareTrim: () => void;
  /** Dedicated entry for the "Nothing fits" Download Capsule action.
   *  Distinct from onConfirmDownload because that one closes over
   *  downloadKind — a setDownloadKind('capsule')-then-onConfirmDownload
   *  sequence would race React's async batching. */
  onDownloadCapsuleFromShareFallback: () => void;
  /** Error surfaced from the Nothing-Fits Download Capsule action.
   *  Rendered inside the Share trim branch so the user sees actionable
   *  feedback without switching tabs. Null when no error. */
  shareFallbackDownloadError: string | null;

  // ── Guest Quick Share (§Transfer Dialog Changes) ──────────────
  /** Runtime-config descriptor from the session endpoint. Quick Share
   *  renders ONLY when `enabled === true` AND `turnstileSiteKey` is
   *  non-null. */
  guestPublishConfig: {
    enabled: boolean;
    turnstileSiteKey: string | null;
  };
  /** Mutable ref that the dialog populates with a controller once the
   *  Turnstile widget mounts. TimelineBar's submit handler reads the
   *  current token and calls reset() on verification failure. */
  guestTurnstileControllerRef: React.MutableRefObject<
    import('./TimelineBar').GuestTurnstileController | null
  >;
  /** Host invokes the guest share flow (reads the live Turnstile token
   *  from the controller, awaits the store callback, sets shareResult). */
  onSubmitGuestShare: () => void;
  /** Structured share result, including `mode` for UI branching. The
   *  existing `shareUrl`/`shareCode`/`shareWarnings` props are kept as
   *  a compatibility view; `shareResult` is authoritative and carries
   *  `expiresAt` for guest mode. */
  shareResult: import('../../../../src/share/share-result').ShareResult | null;
}

export interface TrimDialogState {
  status: 'measuring' | 'within-target' | 'close-to-limit' | 'over-limit' | 'unavailable';
  /** Differentiates the two sources of `status === 'measuring'`:
   *    'search'  — initial entry-time chunked bisect. Copy:
   *                "Finding the best fit…".
   *    'recheck' — single prepare triggered by Reset (or any future
   *                single-prepare trigger). Copy: "Checking selection…".
   *  Only meaningful when `status === 'measuring'`. */
  measuringKind: 'search' | 'recheck';
  measuredBytes: number | null;
  maxBytes: number | null;
  maxSource: 'server' | 'client-fallback' | 'unknown';
  originalActualBytes: number | null;
  previewingOutsideKept: boolean;
  snapshotStale: boolean;
  publishDisabled: boolean;
  /** True when the current selection differs from the cached default
   *  suggested at trim entry — i.e., Reset would actually change
   *  something. False when start/end indices already match the default
   *  suggestion, so Reset is disabled to avoid a no-op clickable. */
  canReset: boolean;
  /** True when trim mode is in the Nothing-Fits fallback — the action
   *  row replaces Publish Selected Range + Reset with Download Capsule. */
  nothingFits: boolean;
  message: string;
}

function formatMegabytes(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  return `${mb.toFixed(1)} MB`;
}

/** Status pill copy — short, scannable labels. Paired with a small
 *  dot whose color encodes the state (redundant with text for
 *  accessibility; color alone is not sufficient per WCAG). */
const STATUS_PILL_LABEL: Record<'within-target' | 'close-to-limit' | 'over-limit', string> = {
  'within-target': 'Within limit',
  'close-to-limit': 'Close to limit',
  'over-limit': 'Over limit',
};

/** Structured status readout for the trim dialog.
 *
 *  Why JSX instead of the previous single-string helper: the former
 *  composite "Selected range: 19.0 MB / 20.0 MB (estimated against
 *  local limit) — Within limit" crammed four signals onto one line
 *  (current size, limit, trust tier, status verdict). Scanning it
 *  required parsing the full sentence. This component splits the row
 *  into scannable parts: a prominent size with a quiet denominator,
 *  a color-coded status pill with text (never color-only), and an
 *  optional caption for trust/remediation. */
function TrimStatusRow({ trim, shareMeasuring }: { trim: TrimDialogState; shareMeasuring: boolean }) {
  if (trim.status === 'measuring') {
    // Three distinct copies for three intent signals, in priority order:
    //   · shareMeasuring → publish-click Phase-1 prepare in flight.
    //   · measuringKind === 'recheck' → Reset-triggered single prepare.
    //     "Checking selection…" avoids implying a full re-search.
    //   · measuringKind === 'search' → initial entry-time chunked bisect.
    let copy: string;
    if (shareMeasuring) copy = 'Preparing…';
    else if (trim.measuringKind === 'recheck') copy = 'Checking selection…';
    else copy = 'Finding the best fit…';
    return (
      <span className="timeline-transfer-dialog__trim-status-measuring">
        {copy}
      </span>
    );
  }
  if (trim.status === 'unavailable') {
    return (
      <span className="timeline-transfer-dialog__trim-status-unavailable">
        Couldn{'’'}t measure. Drag the handles to adjust.
      </span>
    );
  }

  const bytesForDisplay = trim.measuredBytes ?? trim.originalActualBytes;
  const showDenom = trim.maxBytes !== null && trim.maxSource !== 'unknown';
  const pillLabel = STATUS_PILL_LABEL[trim.status];
  const statusClass = `timeline-transfer-dialog__trim-pill timeline-transfer-dialog__trim-pill--${trim.status}`;

  // Only the actionable remediation caption is rendered. The former
  // client-fallback "Local estimate — the server may enforce a slightly
  // different limit" line was engineering noise — users don't care
  // whether the limit came from the client or a server header; they
  // care that Publish actually publishes. Deploy skew (server enforces
  // a tighter cap) is handled by the 413 fallback, which re-enters
  // trim mode with the server-reported number. If the denominator we
  // show turns out to be slightly wrong, the worst case is one extra
  // trim cycle — not a silent failure.
  const caption: React.ReactNode = trim.status === 'over-limit'
    ? 'Reduce your selection to publish.'
    : null;

  return (
    <>
      <span className="timeline-transfer-dialog__trim-size-row">
        {bytesForDisplay !== null ? (
          <span className="timeline-transfer-dialog__trim-size">
            {formatMegabytes(bytesForDisplay)}
          </span>
        ) : (
          // Neither a measurement nor the originating 413 provided a
          // byte count. Rendering a bare em-dash would be announced as
          // nothing (or literally "—") by assistive tech; an explicit
          // label makes the state audible AND visible without claiming
          // a number we don't have.
          <span
            className="timeline-transfer-dialog__trim-size timeline-transfer-dialog__trim-size--unknown"
            aria-label="Size unknown"
          >
            Size unknown
          </span>
        )}
        {showDenom && (
          <span className="timeline-transfer-dialog__trim-denom">
            of {formatMegabytes(trim.maxBytes!)}
          </span>
        )}
        <span className={statusClass}>
          <span className="timeline-transfer-dialog__trim-pill-dot" aria-hidden="true" />
          {pillLabel}
        </span>
      </span>
      {caption && (
        <span className="timeline-transfer-dialog__trim-caption">{caption}</span>
      )}
    </>
  );
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
    shareTrim, shareMeasuring, onResetShareTrim, onConfirmShareTrim,
    onDownloadCapsuleFromShareFallback, shareFallbackDownloadError,
    guestPublishConfig, guestTurnstileControllerRef, onSubmitGuestShare,
    shareResult,
  } = props;
  const [retryingAuth, setRetryingAuth] = useState(false);
  // Sign-in attempt status surfaced inline below the provider buttons
  // ("Starting sign-in…" / structured failure message + Retry). Owned
  // by the runtime — see lab/js/runtime/auth-runtime.ts.
  const signInAttempt = useAppStore((s) => s.authSignInAttempt);
  const isStartingSignIn = signInAttempt?.status === 'starting';
  const failedSignInMessage = signInAttempt?.status === 'failed' ? signInAttempt.message : null;
  const failedSignInProvider = signInAttempt?.status === 'failed' ? signInAttempt.provider : null;

  const dialogRef = useRef<HTMLDivElement>(null);
  const prevOpen = useRef(false);
  const [copied, setCopied] = useState(false);

  // Dialog-level busy guard — one operation at a time.
  // While busy: close/cancel/tab-switch are disabled (Escape is also ignored)
  // to prevent hiding an in-flight publish/download behind a closed dialog.
  const transferBusy = downloadSubmitting || shareSubmitting;
  // Tab switching is ALSO disabled during the trim-mode prepare phase,
  // but Cancel/Escape/backdrop stay enabled (the user can abort
  // measurement). See §10 tab-switch behavior in the plan.
  const tabSwitchBlocked = transferBusy || shareMeasuring;

  // Trim mode is LOAD-BEARING non-modal. The plan ("use the existing
  // timeline surface, do not create a second trim timeline inside the
  // modal") requires users to reach the trim handles that live on the
  // main TimelineBar — outside this dialog tree. A full-screen
  // backdrop + aria-modal=true + focus trap would silently steal
  // pointer events and keyboard focus from those handles.
  //
  // When shareTrim is active:
  //   · no backdrop is rendered (timeline stays interactable)
  //   · aria-modal is false, role="dialog" remains (a non-modal
  //     accessible dialog is valid per ARIA 1.2)
  //   · focus trap is disabled (Tab flows naturally to the handles)
  //   · the card is repositioned as a floating panel above the
  //     timeline via the --trim-floating class variant
  //
  // All other dialog branches (Download, signed-out auth, success,
  // age-confirmation, unverified, loading) remain modal because they
  // need the user's full attention and do not depend on the timeline.
  const isTrimMode = shareTrim !== null;

  // Compute the vertical translate offset that moves the dialog from
  // the viewport center (its default resting position) to a point
  // JUST ABOVE the Lab's bottom-region (timeline + dock). Driving the
  // position via a `translateY` delta (instead of swapping `top: 50%`
  // for `top: auto; bottom: X`) lets the card glide smoothly between
  // the two states — the CSS `transition: transform` on the card
  // animates between `translate(-50%, -50%)` and
  // `translate(-50%, calc(-50% + Ypx))`.
  //
  // When `isTrimMode` is false (dialog is centered), the offset is 0
  // and the transition naturally animates the card back to center.
  //
  // `dialogHeight` is re-read from the live card so the offset stays
  // correct when content swaps between Share-signed-in, trim, and
  // share-success branches.
  const [dialogTranslateY, setDialogTranslateY] = useState(0);
  const [trimPanelAvailableHeightPx, setTrimPanelAvailableHeightPx] = useState<number | null>(null);
  useEffect(() => {
    if (!open) {
      setDialogTranslateY(0);
      setTrimPanelAvailableHeightPx(null);
      return;
    }
    if (!isTrimMode) {
      // Dialog stays centered: offset 0 triggers the return-to-center
      // transition whenever we leave trim mode with the dialog still
      // open (e.g. publish succeeded and the success branch took over).
      setDialogTranslateY(0);
      setTrimPanelAvailableHeightPx(null);
      return;
    }
    let cancelled = false;
    const GAP_ABOVE_BOTTOM_REGION = 16;
    const VIEWPORT_TOP_SAFETY = 16;
    const measure = () => {
      if (cancelled) return;
      // Prefer `.bottom-region` (the whole bottom wrapper) so the
      // panel clears everything inside it — timeline shell, dock,
      // safe-area padding. Fall back to `.timeline-shell` for hosts
      // that mount TimelineBar outside a bottom-region.
      const anchor =
        document.querySelector('.bottom-region') as HTMLElement | null
        ?? document.querySelector('.timeline-shell') as HTMLElement | null;
      const card = dialogRef.current;
      if (!anchor || !card) return;
      const anchorRect = anchor.getBoundingClientRect();
      const cardRect = card.getBoundingClientRect();
      const viewportH = window.innerHeight;
      // Target center-Y of the card: its bottom edge lands
      // GAP_ABOVE_BOTTOM_REGION above the anchor's top. The target
      // can be ABOVE or BELOW the viewport's vertical midpoint
      // depending on how tall the card is and where the bottom-
      // region sits — we must allow both directions.
      const viewportCenterY = viewportH / 2;
      const targetCenterY = anchorRect.top - GAP_ABOVE_BOTTOM_REGION - cardRect.height / 2;
      const rawOffset = targetCenterY - viewportCenterY;
      // Safety clamp ONLY prevents the card's top edge from going
      // above the viewport top (would be unreachable with a normal
      // scrollbar in a modal context). No artificial sign restriction.
      const cardTopIfApplied = viewportCenterY + rawOffset - cardRect.height / 2;
      const clampedOffset = cardTopIfApplied < VIEWPORT_TOP_SAFETY
        ? VIEWPORT_TOP_SAFETY - (viewportCenterY - cardRect.height / 2)
        : rawOffset;
      setDialogTranslateY(clampedOffset);
      // Also publish the available height so the card's max-height
      // cap respects the usable area between viewport-top and the
      // bottom-region. If the card is naturally shorter this has
      // no effect; if it would overflow, `overflow: auto` kicks in.
      const availableH = Math.max(
        100,
        anchorRect.top - GAP_ABOVE_BOTTOM_REGION - VIEWPORT_TOP_SAFETY,
      );
      setTrimPanelAvailableHeightPx(availableH);
    };
    // Measure synchronously on entry so the first paint in trim mode
    // already has the target offset — the transition then animates
    // from translateY=0 (previous state) to the computed value.
    measure();
    const ro = new ResizeObserver(measure);
    const anchor =
      document.querySelector('.bottom-region')
      ?? document.querySelector('.timeline-shell');
    if (anchor) ro.observe(anchor);
    if (dialogRef.current) ro.observe(dialogRef.current);
    window.addEventListener('resize', measure);
    return () => {
      cancelled = true;
      ro.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [isTrimMode, open]);

  // Cancel only allowed when not busy; wire through a guarded handler.
  const handleCancel = useCallback(() => {
    if (transferBusy) return;
    onCancel();
  }, [transferBusy, onCancel]);

  const handleTabChange = useCallback((next: TransferTab) => {
    if (tabSwitchBlocked) return;
    onTabChange(next);
  }, [tabSwitchBlocked, onTabChange]);

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
  //
  // Tab-trap is suppressed in trim mode because the interactive trim
  // handles live on the main TimelineBar, outside this dialog's
  // subtree. Trapping focus here would make them unreachable via
  // keyboard — a WCAG 2.1.1 (Keyboard) regression. Escape still
  // closes the dialog.
  useEffect(() => {
    if (!open) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        e.preventDefault();
        if (!transferBusy) onCancel();
      }
      if (!isTrimMode && e.key === 'Tab' && dialogRef.current) {
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
  }, [open, onCancel, transferBusy, isTrimMode]);

  const handleCopy = useCallback(async () => {
    if (!shareUrl) return;
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard API unavailable (insecure context, permissions-blocked
      // iframe, some mobile webviews). Fall back to auto-selecting the
      // URL input so the user can Ctrl/Cmd+C manually. Previously this
      // branch was silent — the user would click Copy, see nothing
      // change, and have no path forward (audit H2).
      const input = document.getElementById('transfer-share-url-input') as HTMLInputElement | null;
      if (input) {
        try {
          input.focus();
          input.select();
        } catch { /* best-effort */ }
      }
    }
  }, [shareUrl]);

  if (!open) return null;

  const shareSuccess = shareUrl !== null;
  // Hide the tab bar entirely when only one destination is available —
  // keeps the interface focused instead of showing a dead tab.
  const showTabBar = downloadTabAvailable && shareTabAvailable;
  // Backdrop click only cancels when we are not mid-submission.
  const handleBackdropClick = transferBusy ? undefined : onCancel;

  const TRIM_DESCRIPTION_ID = 'timeline-transfer-dialog-trim-description';

  return createPortal(
    <>
      {/* Backdrop is omitted in trim mode so the user can still reach
          the trim handles on the main timeline surface. */}
      {!isTrimMode && (
        <div className="timeline-dialog-backdrop" onClick={handleBackdropClick} />
      )}
      <div
        className={
          `timeline-modal-card timeline-transfer-dialog${
            isTrimMode ? ' timeline-transfer-dialog--trim-floating' : ''
          }`
        }
        role="dialog"
        aria-modal={isTrimMode ? false : true}
        aria-label={isTrimMode ? 'Capsule trim controls' : 'Transfer history'}
        aria-describedby={isTrimMode ? TRIM_DESCRIPTION_ID : undefined}
        aria-busy={transferBusy}
        // Custom properties drive the transform-based enter/exit
        // animation. `--dialog-translate-y` is 0 when the dialog is
        // centered and a negative pixel offset when docked above the
        // timeline; the CSS transition on `transform` animates the
        // card smoothly between the two resting positions.
        // `--trim-panel-available-height` caps the card's max-height
        // to the usable space above the bottom-region.
        style={{
          ['--dialog-translate-y' as const]: `${dialogTranslateY}px`,
          ...(isTrimMode && trimPanelAvailableHeightPx !== null
            ? { ['--trim-panel-available-height' as const]: `${trimPanelAvailableHeightPx}px` }
            : {}),
        } as React.CSSProperties}
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
              disabled={tabSwitchBlocked && tab !== 'download'}
            >
              Download
            </button>
            <button
              role="tab"
              aria-selected={tab === 'share'}
              className={`timeline-transfer-dialog__tab${tab === 'share' ? ' timeline-transfer-dialog__tab--active' : ''}`}
              onClick={() => handleTabChange('share')}
              disabled={tabSwitchBlocked && tab !== 'share'}
            >
              Share
            </button>
          </div>
        )}

        {/* Download panel — only rendered when tab is download AND download is available */}
        {tab === 'download' && downloadTabAvailable && (
          /* Download panel \u2014 refined 2026-04-23 v5 to share language
           *  with the signed-out Share panel:
           *    - opening lede (one-line orientation)
           *    - radio-cards unchanged in semantics but reused with
           *      the same visual weight as the Quick Share tier card
           *    - primary action = full-width stadium-shape pill,
           *      matching `Continue as Guest` / provider buttons
           *    - dismissal = centered text-link, no border-top bar
           *  The goal is one coherent dialog, not two differently-
           *  styled tabs glued under a shared header. */
          <div role="tabpanel" aria-label="Download">
            <p className="timeline-transfer-dialog__description timeline-transfer-dialog__lede">
              Pick what to save — both replay in Watch.
            </p>
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
            <button
              className="timeline-transfer-dialog__confirm timeline-transfer-dialog__confirm--primary-pill"
              onClick={onConfirmDownload}
              disabled={transferBusy || !downloadConfirmEnabled}
              data-testid="transfer-download-confirm"
            >
              {downloadSubmitting ? 'Downloading\u2026' : 'Download'}
              {!downloadSubmitting && (
                <svg
                  className="timeline-transfer-dialog__confirm-arrow"
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <line x1="12" y1="4" x2="12" y2="17" />
                  <polyline points="6,11 12,17 18,11" />
                </svg>
              )}
            </button>
            <div className="timeline-transfer-dialog__minor-actions">
              {/* Canonical Cancel affordance — byte-for-byte identical
               *  class set, wording, and wrapper as the signed-out
               *  Share panel's Cancel (see below). The `__cancel`
               *  class carries no styling of its own (styling lives
               *  on `__text-dismiss`); it's a back-compat selector
               *  hook for existing lifecycle tests that reach the
               *  dismiss via `document.querySelector('.__cancel')`. */}
              <button
                type="button"
                className="timeline-transfer-dialog__text-dismiss timeline-transfer-dialog__cancel"
                onClick={handleCancel}
                disabled={transferBusy}
              >
                Cancel
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
              /* Success state (redesign 2026-04-23):
               *
               *   ✓ Shared
               *   ┌─────────────────────────────────────┐
               *   │  <domain>/c/<code>                  │
               *   │  [ Copy link ]  ↗ Open in Watch     │
               *   └─────────────────────────────────────┘
               *   ●  EXPIRES · in 2 days                (guest only)
               *   ↗ Manage uploads     [Close]          (account only)
               *
               * Design intent:
               *   - One unified "link card" replaces the three disjoint
               *     rows (url input / watch button / code badge) and
               *     removes the duplicated code that appeared both
               *     inside the URL and as a separate badge.
               *   - `Copy link` is the visual primary action; Open in
               *     Watch is an inline tertiary link. 80 % of share
               *     moments want the clipboard, not a self-preview.
               *   - Guest-success state: expiry chip is the terminal
               *     element. No upsell footer — that was an explicit
               *     product decision (2026-04-23 v3), not an oversight.
               *     The account path was already surfaced in the
               *     pre-publish signed-out panel; re-offering it after
               *     publish was redundant noise.
               *   - Account-success state: Manage uploads inline-link
               *     + Close text link share a one-line footer row; no
               *     bordered bottom action bar. */
              <div className="timeline-transfer-dialog__success">
                <div className="timeline-transfer-dialog__success-header">
                  <span
                    className="timeline-transfer-dialog__success-check"
                    aria-hidden="true"
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="5,12 10,17 19,7" />
                    </svg>
                  </span>
                  <span className="timeline-transfer-dialog__success-label">Shared</span>
                </div>

                <div
                  className="timeline-transfer-dialog__link-card"
                  data-testid="transfer-link-card"
                >
                  <label
                    className="timeline-transfer-dialog__link-card-label"
                    htmlFor="transfer-share-url-input"
                  >
                    Share link
                  </label>
                  {/* Retain a plain <input> so users can still
                   *  Cmd+A / Ctrl+A select-all, but strip the form-chrome
                   *  styling that falsely implied it was editable. */}
                  <input
                    id="transfer-share-url-input"
                    /* `__url-input` is retained as an alias class for
                     *  back-compat with existing test selectors +
                     *  external E2E harnesses. The new
                     *  `__link-card-url` owns the actual styling. */
                    className="timeline-transfer-dialog__link-card-url timeline-transfer-dialog__url-input"
                    type="text"
                    value={shareUrl}
                    readOnly
                    onFocus={(e) => e.target.select()}
                    aria-label="Share link"
                  />

                  <div className="timeline-transfer-dialog__link-card-actions">
                    <button
                      className="timeline-transfer-dialog__copy-primary"
                      onClick={handleCopy}
                      data-copied={copied ? 'true' : undefined}
                      title="Copy link to clipboard"
                    >
                      <span className="timeline-transfer-dialog__copy-icon" aria-hidden="true">
                        {copied ? (
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                            <polyline points="5,12 10,17 19,7" />
                          </svg>
                        ) : (
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                          </svg>
                        )}
                      </span>
                      <span>{copied ? 'Copied to clipboard' : 'Copy link'}</span>
                    </button>

                    {shareCode && (
                      <a
                        className="timeline-transfer-dialog__open-inline"
                        href={`/watch/?c=${shareCode}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        data-testid="transfer-open-in-watch"
                        aria-label="Open in Watch (opens in new tab)"
                      >
                        <span>Open in Watch</span>
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                          <polyline points="8,5 19,5 19,16" />
                          <line x1="5" y1="19" x2="19" y2="5" />
                        </svg>
                      </a>
                    )}
                  </div>
                </div>

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

                {shareResult?.mode === 'guest' ? (
                  /* Guest success: expiry chip is the terminal element.
                   *  No upsell footer, no Close affordance — Esc and
                   *  outside-click dismiss the dialog (both already
                   *  wired). The account path is surfaced in the
                   *  pre-publish signed-out panel, so re-upselling it
                   *  after publish is redundant; see `GuestSuccessFooter`
                   *  docstring for full rationale. */
                  <GuestSuccessFooter expiresAt={shareResult.expiresAt} />
                ) : (
                  /* Account success: Manage uploads is the tertiary
                   *  next action; a Close text link lets the user
                   *  acknowledge-and-exit without needing Esc. */
                  <div className="timeline-transfer-dialog__account-success-footer">
                    <a
                      className="timeline-transfer-dialog__manage-link-inline"
                      href="/account/"
                      target="_blank"
                      rel="noopener noreferrer"
                      data-testid="transfer-manage-uploads"
                      aria-label="Manage uploads (opens in new tab)"
                    >
                      <span>Manage uploads</span>
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <polyline points="8,5 19,5 19,16" />
                        <line x1="5" y1="19" x2="19" y2="5" />
                      </svg>
                    </a>
                    {/* `__cancel` + text "Close" preserved for back-
                     *  compat with existing lifecycle tests that drive
                     *  dismissal through this affordance. */}
                    <button
                      type="button"
                      className="timeline-transfer-dialog__text-dismiss timeline-transfer-dialog__cancel"
                      onClick={handleCancel}
                      disabled={transferBusy}
                    >
                      Close
                    </button>
                  </div>
                )}
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
              /* Signed-out Share panel.
               *
               * Redesign (2026-04-23):
               *   - Primary tier = Quick Share card (tinted, accent-bordered)
               *   - Secondary tier = "Save to account" with OAuth buttons
               *   - Single shared clickwrap at the bottom; every CTA
               *     references it via aria-describedby. Previously this
               *     sentence appeared twice, which tripled the visual
               *     noise of the primary action.
               *   - No bottom-action Cancel bar; an inline link sits
               *     with the primary CTA so the panel feels one-surface
               *     instead of form-footer.
               * Quick Share is omitted when the feature flag is off
               * OR the site key isn't delivered — the legacy auth-only
               * copy fills in via `hasGuestTier === false`. */
              (() => {
                const hasGuestTier = Boolean(
                  guestPublishConfig.enabled
                    && guestPublishConfig.turnstileSiteKey
                    && shareTabAvailable,
                );
                return (
              <div className="timeline-transfer-dialog__auth-prompt" data-testid="transfer-auth-prompt">
                {hasGuestTier ? (
                  <>
                    <p className="timeline-transfer-dialog__description timeline-transfer-dialog__lede">
                      Pick a link type — both open in Watch.
                    </p>
                    <GuestQuickShareBlock
                      turnstileSiteKey={guestPublishConfig.turnstileSiteKey!}
                      controllerRef={guestTurnstileControllerRef}
                      onSubmitGuestShare={onSubmitGuestShare}
                      shareSubmitting={shareSubmitting}
                      shareError={shareError}
                      transferBusy={transferBusy}
                      clickwrapId={CLICKWRAP_SHARE_ID}
                    />
                    <div
                      className="timeline-transfer-dialog__section-rule"
                      role="separator"
                      aria-label="Or sign in to save"
                    >
                      <span>or · sign in to save</span>
                    </div>
                  </>
                ) : (
                  <p className="timeline-transfer-dialog__description">
                    Sign in to publish a share link. Anyone with the link
                    can open it in Watch without signing in.
                  </p>
                )}

                {/* authNote is set ONLY from AuthRequiredError.message —
                 *  other error classes (429, generic publish failure)
                 *  never reach this slot because the host component
                 *  splits shareError by kind before passing it down.
                 *  This prevents the "Publish quota exceeded…" bleed
                 *  that an earlier string-only `shareError` allowed
                 *  when opportunistic hydrate flipped signed-in → out. */}
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

                <section
                  className="timeline-transfer-dialog__account-tier"
                  aria-labelledby={hasGuestTier ? 'transfer-account-heading' : undefined}
                >
                  {hasGuestTier && (
                    /* Single centered subtitle — the "OR · SIGN IN TO
                     *  SAVE" divider above already announces the
                     *  section, so the prior tracked-caps "SAVE TO
                     *  YOUR ACCOUNT" heading was redundant and has
                     *  been removed. The `sr-only` label preserves
                     *  the semantic <section> landmark for screen
                     *  readers without shouting it visually. */
                    <>
                      <h3
                        id="transfer-account-heading"
                        className="timeline-transfer-dialog__sr-only"
                      >
                        Save to your account
                      </h3>
                      <p className="timeline-transfer-dialog__account-subtitle">
                        Permanent links, managed in Account.
                      </p>
                    </>
                  )}

                  {popupBlocked ? (
                    /* Popup-blocked sub-panel — see original comment. */
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
                          disabled={transferBusy || isStartingSignIn}
                          aria-describedby={CLICKWRAP_SHARE_ID}
                          data-testid="transfer-popup-retry"
                        >
                          Retry {providerLabel(popupBlocked.provider)} popup
                        </button>
                        <button
                          className="timeline-transfer-dialog__auth-button"
                          onClick={onSignInSameTab}
                          disabled={transferBusy || isStartingSignIn}
                          aria-describedby={CLICKWRAP_SHARE_ID}
                          data-testid="transfer-popup-same-tab"
                        >
                          Continue in this tab
                        </button>
                        <button
                          className="timeline-transfer-dialog__auth-button timeline-transfer-dialog__auth-button--subtle"
                          onClick={onDismissPopupBlocked}
                          disabled={transferBusy || isStartingSignIn}
                          data-testid="transfer-popup-back"
                        >
                          Back
                        </button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <div className="timeline-transfer-dialog__auth-buttons">
                        <button
                          className="timeline-transfer-dialog__auth-button timeline-transfer-dialog__auth-button--provider"
                          onClick={() => onSignIn('google')}
                          disabled={transferBusy || isStartingSignIn}
                          aria-describedby={CLICKWRAP_SHARE_ID}
                          data-testid="transfer-auth-google"
                        >
                          <ProviderGlyph provider="google" />
                          <span>Continue with Google</span>
                        </button>
                        <button
                          className="timeline-transfer-dialog__auth-button timeline-transfer-dialog__auth-button--provider"
                          onClick={() => onSignIn('github')}
                          disabled={transferBusy || isStartingSignIn}
                          aria-describedby={CLICKWRAP_SHARE_ID}
                          data-testid="transfer-auth-github"
                        >
                          <ProviderGlyph provider="github" />
                          <span>Continue with GitHub</span>
                        </button>
                      </div>
                      {isStartingSignIn ? (
                        <p className="auth-attempt-status" role="status" aria-live="polite">
                          Starting sign-in…
                        </p>
                      ) : null}
                      {failedSignInMessage ? (
                        <p
                          className="auth-attempt-status auth-attempt-status--failed"
                          role="status"
                          aria-live="polite"
                          data-testid="transfer-auth-error"
                        >
                          {failedSignInMessage}
                          {failedSignInProvider ? (
                            <button
                              className="auth-attempt-retry"
                              onClick={() => onSignIn(failedSignInProvider)}
                              data-testid="transfer-auth-retry"
                            >
                              Retry
                            </button>
                          ) : null}
                        </p>
                      ) : null}
                    </>
                  )}
                </section>

                {/* Single shared clickwrap — the legal sentence is
                 *  identical for the guest path and both OAuth paths,
                 *  so rendering it twice (as the original design did)
                 *  was pure visual noise. All CTAs above reference this
                 *  id via aria-describedby. */}
                <AgeClickwrapNotice id={CLICKWRAP_SHARE_ID} action="continue" />

                {/* Canonical Cancel affordance — byte-for-byte
                 *  identical class set, wording, and wrapper as the
                 *  Download panel's Cancel above. Keeping both
                 *  on `__text-dismiss __cancel` means styling lives
                 *  in one rule and existing lifecycle tests that
                 *  reach the dismiss via `.__cancel` keep working. */}
                <div className="timeline-transfer-dialog__minor-actions">
                  <button
                    type="button"
                    className="timeline-transfer-dialog__text-dismiss timeline-transfer-dialog__cancel"
                    onClick={handleCancel}
                    disabled={transferBusy}
                  >
                    Cancel
                  </button>
                </div>
              </div>
                );
              })()
            ) : ageConfirmationRequired ? (
              /* signed-in, but publish returned 428 — clickwrap retry. The
                 server-side acceptance row was never written for this user
                 (legacy/pre-deploy account, see plan §3 backend). One click
                 ack-and-publish in sequence: the host's onAgeConfirmationAck
                 POSTs to /api/account/age-confirmation, then re-runs the
                 publish. No checkbox — clicking Publish IS the consent. */
              <>
                <AgeClickwrapNotice id={CLICKWRAP_PUBLISH_ID} action="publish" />
                <ShareActions onCancel={handleCancel} transferBusy={transferBusy}>
                  <button
                    className="timeline-transfer-dialog__confirm"
                    onClick={onAgeConfirmationAck}
                    disabled={transferBusy}
                    aria-describedby={CLICKWRAP_PUBLISH_ID}
                    data-testid="transfer-retro-ack-confirm"
                  >
                    {shareSubmitting ? 'Publishing\u2026' : 'Publish'}
                  </button>
                </ShareActions>
              </>
            ) : shareTrim ? (
              /* Capsule Too Large \u2014 trim mode. Renders inside the
                 existing signed-in Share branch so the Transfer dialog
                 and Share tab stay the single surface. */
              <div
                className="timeline-transfer-dialog__trim"
                data-testid="transfer-share-trim"
              >
                <p
                  id={TRIM_DESCRIPTION_ID}
                  className="timeline-transfer-dialog__description"
                >
                  Too large to publish. Drag the green selection on the timeline below, or grab either end, to trim it under the limit.
                </p>
                {shareTrim.snapshotStale ? (
                  <p
                    className="timeline-transfer-dialog__error"
                    role="status"
                    aria-live="polite"
                    data-testid="transfer-share-trim-stale"
                  >
                    The recording changed. Close this dialog and try again.
                  </p>
                ) : (
                  <div
                    className="timeline-transfer-dialog__trim-status"
                    role="status"
                    aria-live="polite"
                    data-testid="transfer-share-trim-status"
                  >
                    <TrimStatusRow trim={shareTrim} shareMeasuring={shareMeasuring} />
                  </div>
                )}
                {shareTrim.previewingOutsideKept && !shareTrim.snapshotStale && (
                  <p
                    className="timeline-transfer-dialog__preview-note"
                    role="status"
                    aria-live="polite"
                    data-testid="transfer-share-trim-preview-note"
                  >
                    You{'\u2019'}re previewing a frame outside your selection. It won{'\u2019'}t be shared.
                  </p>
                )}
                {shareTrim.nothingFits && (
                  <p
                    className="timeline-transfer-dialog__help"
                    data-testid="transfer-share-trim-nothing-fits"
                  >
                    Even a single frame is over the limit. Simplify the scene or record a shorter clip \u2014 or download this capsule locally.
                  </p>
                )}
                {shareError && <p className="timeline-transfer-dialog__error">{shareError}</p>}
                {shareTrim.nothingFits && shareFallbackDownloadError && (
                  <p
                    className="timeline-transfer-dialog__error"
                    role="status"
                    aria-live="polite"
                    data-testid="transfer-share-trim-fallback-error"
                  >
                    {shareFallbackDownloadError}
                  </p>
                )}
                {shareTrim.nothingFits ? (
                  <ShareActions onCancel={handleCancel} transferBusy={transferBusy}>
                    <button
                      className="timeline-transfer-dialog__confirm"
                      onClick={onDownloadCapsuleFromShareFallback}
                      disabled={transferBusy || downloadSubmitting}
                      data-testid="transfer-share-trim-download"
                    >
                      {downloadSubmitting ? 'Saving\u2026' : 'Download capsule'}
                    </button>
                  </ShareActions>
                ) : (
                  <ShareActions
                    onCancel={handleCancel}
                    transferBusy={transferBusy}
                    leadingLink={
                      <button
                        type="button"
                        className="timeline-transfer-dialog__reset-link"
                        onClick={onResetShareTrim}
                        disabled={transferBusy || shareMeasuring || !shareTrim.canReset}
                        aria-label={
                          shareTrim.canReset
                            ? 'Reset to the suggested trim (newest history that fits the publish limit)'
                            : 'Already using the suggested selection'
                        }
                        data-testid="transfer-share-trim-reset"
                      >
                        Reset selection
                      </button>
                    }
                  >
                    <button
                      className="timeline-transfer-dialog__confirm timeline-transfer-dialog__confirm--publish-trim"
                      onClick={onConfirmShareTrim}
                      disabled={
                        transferBusy ||
                        shareMeasuring ||
                        shareTrim.publishDisabled ||
                        shareTrim.snapshotStale
                      }
                      data-testid="transfer-share-trim-publish"
                    >
                      {(() => {
                        // Priority: active POST > Phase-1 prepare > idle.
                        if (shareSubmitting) return 'Publishing\u2026';
                        if (shareMeasuring) return 'Preparing\u2026';
                        return 'Publish';
                      })()}
                    </button>
                  </ShareActions>
                )}
              </div>
            ) : (
              /* signed-in \u2014 redesigned 2026-04-23 v5.
               *
               * Adds lightweight identity + stats context without
               * burying the primary action. Three strata:
               *
               *   1. Identity chip (avatar monogram \u00b7 display name \u00b7
               *      manage-profile link) \u2014 tells the user who's
               *      signing this publish and gives a one-click path
               *      to account management.
               *   2. Capsule-count stat \u2014 "this will be your 4th
               *      capsule" framing. Fetched once per dialog open
               *      from /api/account/capsules/count; falls back to
               *      omission on fetch failure so a backend blip
               *      can't block publishing.
               *   3. Primary stadium Publish pill + centered Cancel
               *      text-link, matching Download and the signed-out
               *      Share panel so the three dialog surfaces feel
               *      like one family.
               *
               * The SignedInPublishPanel component owns the fetch +
               * render; keeping it local to this file means the
               * fetch lifecycle is tied to the signed-in render
               * branch (no fetch while signed-out, no stale count
               * when the dialog re-opens). */
              <SignedInPublishPanel
                onConfirmShare={onConfirmShare}
                shareConfirmEnabled={shareConfirmEnabled}
                shareSubmitting={shareSubmitting}
                shareError={shareError}
                transferBusy={transferBusy}
                handleCancel={handleCancel}
              />
            )}
          </div>
        )}
      </div>
    </>,
    document.body,
  );
}

// ── Guest Quick Share helpers ────────────────────────────────────────

interface GuestQuickShareBlockProps {
  turnstileSiteKey: string;
  controllerRef: React.MutableRefObject<
    import('./TimelineBar').GuestTurnstileController | null
  >;
  onSubmitGuestShare: () => void;
  shareSubmitting: boolean;
  shareError: string | null;
  transferBusy: boolean;
  /** Id of the single shared clickwrap paragraph. Wired via
   *  aria-describedby so screen readers associate the 13+ consent
   *  with the CTA; the actual paragraph is rendered once at the
   *  bottom of the signed-out panel (not inside this block). */
  clickwrapId: string;
}

/** Signed-in Publish panel — identity chip + capsule-count stat +
 *  primary Publish pill + centered Cancel link. See the call-site
 *  comment in the signed-in render branch for the design intent.
 *
 *  Count fetch: single GET /api/account/capsules/count on mount.
 *  The fetch runs once per panel-open because mounting is tied to
 *  `authStatus === 'signed-in' && tab === 'share' && !shareSuccess`
 *  — re-opening the dialog or re-entering the Share tab remounts
 *  the component and re-fetches. A useRef sentinel prevents a
 *  React-strict-mode double-invoke from firing two requests.
 *
 *  Failure posture: on fetch error the count chip is hidden
 *  (`count === null`), the rest of the panel is unaffected, and
 *  the user can still publish. No retry button — a count
 *  hiccup shouldn't nag the user. */
interface SignedInPublishPanelProps {
  onConfirmShare: () => void;
  shareConfirmEnabled: boolean;
  shareSubmitting: boolean;
  shareError: string | null;
  transferBusy: boolean;
  handleCancel: () => void;
}

function SignedInPublishPanel({
  onConfirmShare,
  shareConfirmEnabled,
  shareSubmitting,
  shareError,
  transferBusy,
  handleCancel,
}: SignedInPublishPanelProps) {
  const session = useAppStore((s) => s.auth.session);
  const displayName = session?.displayName ?? null;
  const userId = session?.userId ?? '';

  const [capsuleCount, setCapsuleCount] = useState<number | null>(null);

  useEffect(() => {
    // Count fetch — rewritten after a React-18 StrictMode audit
    // (2026-04-23 v5). The previous pattern used a `useRef` sentinel
    // to avoid double-fetch under StrictMode, but the sentinel
    // combined with the AbortController created a silent failure:
    // effect#1 set the sentinel + started fetch, cleanup#1 aborted
    // the fetch, effect#2 saw the sentinel and skipped — so the only
    // in-flight request was the aborted one and the count never
    // populated in dev mode.
    //
    // New pattern: no sentinel. Both StrictMode passes fire; each
    // owns its own AbortController; only the second (surviving)
    // one's resolve commits state. `ac.signal.aborted` guards the
    // commit so a late resolve from a cancelled fetch cannot
    // overwrite state from the live fetch. Cheap: an extra request
    // under StrictMode dev only; production sees one fetch.
    const ac = new AbortController();
    void (async () => {
      try {
        const res = await fetch('/api/account/capsules/count', {
          method: 'GET',
          credentials: 'same-origin',
          cache: 'no-store',
          signal: ac.signal,
        });
        if (ac.signal.aborted) return;
        // 401 here is not just "no count" — it's authoritative
        // proof that the session cookie was invalidated between
        // the initial hydrate (when we rendered the signed-in
        // panel) and this fetch. Flip the store to 'signed-out'
        // so the parent re-renders the correct auth state and the
        // user sees the real reason the panel doesn't work,
        // instead of clicking Publish only to hit a 401 there too.
        if (res.status === 401) {
          void hydrateAuthSession();
          return;
        }
        if (!res.ok) return;
        const body = await res.json() as { count?: unknown };
        if (ac.signal.aborted) return;
        if (typeof body.count === 'number' && Number.isFinite(body.count)) {
          setCapsuleCount(body.count);
        }
      } catch {
        /* Silent — a count hiccup shouldn't interrupt publishing. */
      }
    })();
    return () => ac.abort();
  }, []);

  // Monogram: first letter of display name, else first letter of the
  // user id (stable fallback for GitHub users who never set a public
  // display name). Upper-cased for visual parity.
  const monogramSource = (displayName ?? userId ?? '?').trim() || '?';
  const monogram = monogramSource.charAt(0).toUpperCase();

  const countLabel = (() => {
    if (capsuleCount === null) return null;
    if (capsuleCount === 0) return 'First capsule';
    if (capsuleCount === 1) return '1 capsule published';
    return `${capsuleCount.toLocaleString()} capsules published`;
  })();

  return (
    <>
      <div
        className="timeline-transfer-dialog__identity"
        data-testid="transfer-signed-in-identity"
      >
        <span
          className="timeline-transfer-dialog__avatar"
          aria-hidden="true"
          title={displayName ?? userId}
        >
          {monogram}
        </span>
        <div className="timeline-transfer-dialog__identity-body">
          <span className="timeline-transfer-dialog__identity-name">
            {displayName ?? 'Your account'}
          </span>
          {countLabel && (
            <span
              className="timeline-transfer-dialog__identity-stat"
              data-testid="transfer-capsule-count"
            >
              {countLabel}
            </span>
          )}
        </div>
        <a
          className="timeline-transfer-dialog__identity-link"
          href="/account/"
          target="_blank"
          rel="noopener noreferrer"
          data-testid="transfer-identity-profile-link"
          aria-label="Open account page (opens in new tab)"
        >
          <span>Profile</span>
          <svg
            width="11"
            height="11"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <polyline points="8,5 19,5 19,16" />
            <line x1="5" y1="19" x2="19" y2="5" />
          </svg>
        </a>
      </div>

      <p className="timeline-transfer-dialog__description timeline-transfer-dialog__lede">
        Publish to get a permanent share link — opens in Watch for anyone with it.
      </p>

      {shareError && <p className="timeline-transfer-dialog__error">{shareError}</p>}

      <button
        className="timeline-transfer-dialog__confirm timeline-transfer-dialog__confirm--primary-pill"
        onClick={onConfirmShare}
        disabled={transferBusy || !shareConfirmEnabled}
        data-testid="transfer-publish-confirm"
      >
        {shareSubmitting ? 'Publishing…' : 'Publish'}
        {!shareSubmitting && (
          <svg
            className="timeline-transfer-dialog__confirm-arrow"
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <line x1="5" y1="12" x2="19" y2="12" />
            <polyline points="13,6 19,12 13,18" />
          </svg>
        )}
      </button>

      <div className="timeline-transfer-dialog__minor-actions">
        <button
          type="button"
          className="timeline-transfer-dialog__text-dismiss timeline-transfer-dialog__cancel"
          onClick={handleCancel}
          disabled={transferBusy}
        >
          Cancel
        </button>
      </div>
    </>
  );
}

/** Brand glyphs (Google 4-color G / GitHub monochrome Octocat). See
 *  comment before the component for the palette + theme rules.
 *  GitHub: single-path Octocat mark rendered in `currentColor` so it
 *  inherits the button's ink color — black on light theme, near-white
 *  on dark theme. Matches GitHub's own monochrome-on-button pattern
 *  and avoids the low-contrast "black glyph on dark button" trap a
 *  hard-coded fill would create. */
function ProviderGlyph({ provider }: { provider: 'google' | 'github' }) {
  if (provider === 'google') {
    return (
      <svg
        width="18"
        height="18"
        viewBox="0 0 18 18"
        aria-hidden="true"
        className="timeline-transfer-dialog__provider-glyph"
      >
        <path
          fill="#4285F4"
          d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844a4.14 4.14 0 0 1-1.796 2.716v2.259h2.908c1.702-1.567 2.684-3.875 2.684-6.615z"
        />
        <path
          fill="#34A853"
          d="M9 18c2.43 0 4.467-.806 5.956-2.18l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 0 0 9 18z"
        />
        <path
          fill="#FBBC05"
          d="M3.964 10.71A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.71V4.958H.957A8.996 8.996 0 0 0 0 9c0 1.452.348 2.827.957 4.042l3.007-2.332z"
        />
        <path
          fill="#EA4335"
          d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.958L3.964 7.29C4.672 5.163 6.656 3.58 9 3.58z"
        />
      </svg>
    );
  }
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      aria-hidden="true"
      className="timeline-transfer-dialog__provider-glyph"
    >
      <path
        fill="currentColor"
        d="M12 .5C5.37.5 0 5.87 0 12.5c0 5.3 3.438 9.8 8.205 11.387.6.113.82-.258.82-.578 0-.286-.01-1.04-.015-2.04-3.338.725-4.042-1.61-4.042-1.61-.546-1.387-1.333-1.756-1.333-1.756-1.09-.744.082-.729.082-.729 1.205.085 1.838 1.237 1.838 1.237 1.07 1.835 2.807 1.305 3.492.998.108-.776.42-1.306.763-1.607-2.665-.303-5.467-1.332-5.467-5.93 0-1.31.468-2.38 1.235-3.22-.124-.303-.535-1.523.117-3.176 0 0 1.008-.323 3.3 1.23a11.49 11.49 0 0 1 3.003-.404c1.02.005 2.047.138 3.006.404 2.29-1.553 3.297-1.23 3.297-1.23.653 1.653.243 2.873.12 3.176.77.84 1.233 1.91 1.233 3.22 0 4.61-2.807 5.624-5.48 5.921.43.372.815 1.103.815 2.222 0 1.606-.015 2.9-.015 3.293 0 .323.217.697.825.578C20.565 22.297 24 17.797 24 12.5 24 5.87 18.627.5 12 .5z"
      />
    </svg>
  );
}

/** Signed-out Share panel PRIMARY tier. Tinted accent card containing:
 *   - pill badges surfacing the two defining props (72 h · no account)
 *   - display heading + micro-copy
 *   - reserved Turnstile slot (prevents layout jump at widget-load time)
 *   - primary CTA ("Continue as Guest") disabled until a live token
 *
 * Consent is handled by the single shared clickwrap rendered OUTSIDE
 * this block at the bottom of the signed-out panel; this block only
 * wires `aria-describedby` onto the CTA via `clickwrapId`. */
function GuestQuickShareBlock({
  turnstileSiteKey,
  controllerRef,
  onSubmitGuestShare,
  shareSubmitting,
  shareError,
  transferBusy,
  clickwrapId,
}: GuestQuickShareBlockProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [token, setToken] = useState<string | null>(null);
  const [widgetReady, setWidgetReady] = useState(false);
  /** Script-load-failure / render-timeout sentinel. When set, the
   *  CTA switches to a dead state with a visible explanation so the
   *  user is never stuck staring at "Preparing…" forever. Common
   *  causes: content blockers, strict corporate proxies, CSP
   *  misconfig on a surface Turnstile is embedded into, captive
   *  Wi-Fi intercepts. Audit 2026-04-23 silent-failure C1. */
  const [widgetLoadFailed, setWidgetLoadFailed] = useState(false);
  /** Inline error from Turnstile's own `error-callback` (widget
   *  mounted but a subsequent challenge errored — distinct from
   *  load-failure). Surfaced so the user knows why the CTA just
   *  became disabled instead of watching it silently gray out. */
  const [widgetChallengeError, setWidgetChallengeError] = useState(false);
  const widgetIdRef = useRef<string | null>(null);
  const solvedAtRef = useRef<number | null>(null);

  // Token is the single source of truth. Controller `reset()` clears
  // it (and the widget) so a resubmit after a 400 turnstile_failed is
  // forced through a fresh solve rather than reusing the stale token.
  //
  // The controller object is stable for the block's lifetime (not
  // recreated on every token change) so a concurrent submit click
  // cannot observe a null controllerRef during the effect-cleanup /
  // effect-setup microtask gap. `getToken` reads the latest `token`
  // state through a ref mirror.
  //
  // Reviewer follow-up (2026-04-23): the controller is assigned
  // during RENDER (not inside an effect) so React-18 StrictMode's
  // unmount-then-remount sequence — which would otherwise transiently
  // null the ref between cleanup and the next effect — can never
  // surface a null controller to a concurrent submit click. The
  // controller object reads mutable state through refs, so rebuilding
  // it every render is free (no state capture). Cleanup is handled
  // in the widget-install effect below, which removes the iframe —
  // the controller itself has no resources to release.
  const tokenRef = useRef<string | null>(null);
  tokenRef.current = token;
  const resetController = useCallback(() => {
    setToken(null);
    solvedAtRef.current = null;
    const api = (window as unknown as { turnstile?: { reset: (id?: string) => void } }).turnstile;
    if (api && widgetIdRef.current) {
      try { api.reset(widgetIdRef.current); } catch { /* ignore */ }
    }
  }, []);
  controllerRef.current = {
    getToken: () => tokenRef.current,
    reset: resetController,
  };

  // Proactive refresh — the Turnstile token expires 5 minutes after
  // solve. When the user sits on a solved widget for >4 minutes before
  // clicking Continue as Guest, re-execute so we don't submit a stale
  // token and eat a 400 round-trip.
  useEffect(() => {
    if (!token) return;
    const handle = window.setInterval(() => {
      const solvedAt = solvedAtRef.current;
      if (!solvedAt) return;
      if (Date.now() - solvedAt < 4 * 60 * 1000) return;
      const api = (window as unknown as { turnstile?: { execute: (id?: string) => void } }).turnstile;
      if (api && widgetIdRef.current) {
        try { api.execute(widgetIdRef.current); } catch { /* ignore */ }
      }
    }, 30 * 1000);
    return () => window.clearInterval(handle);
  }, [token]);

  useEffect(() => {
    // Inject the Turnstile script once per document and mount the
    // widget explicitly. Hardened 2026-04-23 per audit C1 against the
    // "widget never loads → CTA stuck in Preparing… forever" failure
    // mode, which previously had no path to recovery when the script
    // was blocked (ad blockers, strict proxies, CSP misconfig,
    // captive Wi-Fi). Now surfaces a visible widgetLoadFailed state
    // with a fallback-to-sign-in message; CTA fully disables.
    const existing = document.querySelector(
      'script[data-atomdojo-turnstile]',
    ) as HTMLScriptElement | null;

    let script = existing;
    if (!script) {
      script = document.createElement('script');
      script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
      script.async = true;
      script.defer = true;
      script.dataset.atomdojoTurnstile = '1';
      document.head.appendChild(script);
    }

    let cancelled = false;
    // 10 s end-to-end budget from effect start to widget-ready.
    // Covers slow 3G and script-load stall; any legitimate mount
    // resolves in well under 2 s. Over this threshold we give the
    // user an actionable message instead of silently pending.
    const LOAD_TIMEOUT_MS = 10_000;
    const loadTimer = window.setTimeout(() => {
      if (cancelled || widgetIdRef.current) return;
      console.warn(
        '[turnstile] widget failed to load within timeout — entering widget-load-failed state',
      );
      setWidgetLoadFailed(true);
    }, LOAD_TIMEOUT_MS);

    const handleScriptError = () => {
      if (cancelled) return;
      console.warn('[turnstile] script element fired error — widget unavailable');
      setWidgetLoadFailed(true);
    };
    script.addEventListener('error', handleScriptError);

    const attemptRender = () => {
      if (cancelled) return;
      const api = (window as unknown as {
        turnstile?: {
          render: (el: HTMLElement, opts: Record<string, unknown>) => string;
          remove: (id: string) => void;
        };
      }).turnstile;
      if (!api) {
        window.setTimeout(attemptRender, 100);
        return;
      }
      const container = containerRef.current;
      if (!container) return;
      const id = api.render(container, {
        sitekey: turnstileSiteKey,
        theme: document.documentElement.dataset.theme === 'light' ? 'light' : 'dark',
        appearance: 'interaction-only',
        callback: (tok: string) => {
          if (cancelled) return;
          solvedAtRef.current = Date.now();
          setWidgetChallengeError(false);
          setToken(tok);
        },
        'error-callback': () => {
          if (cancelled) return;
          // Surface inline feedback — previously this was silent and
          // the user saw the CTA gray out for no apparent reason
          // (audit M5). Token reset lets the widget re-solve on the
          // next interaction.
          setToken(null);
          setWidgetChallengeError(true);
        },
        'expired-callback': () => {
          if (cancelled) return;
          setToken(null);
        },
      });
      widgetIdRef.current = id;
      window.clearTimeout(loadTimer);
      setWidgetReady(true);
    };

    if ((window as unknown as { turnstile?: unknown }).turnstile) {
      attemptRender();
    } else {
      script.addEventListener('load', attemptRender, { once: true });
    }

    return () => {
      cancelled = true;
      window.clearTimeout(loadTimer);
      if (script) script.removeEventListener('error', handleScriptError);
      const api = (window as unknown as { turnstile?: { remove: (id: string) => void } }).turnstile;
      if (api && widgetIdRef.current) {
        try { api.remove(widgetIdRef.current); } catch { /* ignore */ }
      }
      widgetIdRef.current = null;
    };
  }, [turnstileSiteKey]);

  const ctaDisabled = transferBusy || shareSubmitting || widgetLoadFailed || !widgetReady || !token;

  // The CTA label narrates the security handshake so the user always
  // knows what's happening — replacing the prior dashed "Verifying
  // you're human…" slot. Five states, in order:
  //   1. widget failed to load                    → "Verification unavailable"
  //      (permanent until reload; fallback message below points to OAuth)
  //   2. script + widget still mounting           → "Preparing…"
  //   3. widget ready, silent solve in flight     → "Continue as Guest"
  //      (disabled, no implication that anything is pending on the user)
  //   4. token acquired                           → "Continue as Guest →"
  //      (enabled)
  //   5. submit in flight                         → "Publishing…"
  const ctaLabel = shareSubmitting
    ? 'Publishing…'
    : widgetLoadFailed
      ? 'Verification unavailable'
      : !widgetReady
        ? 'Preparing…'
        : 'Continue as Guest';

  return (
    <section
      className="timeline-transfer-dialog__quick-share"
      data-testid="transfer-guest-block"
      aria-labelledby="transfer-guest-heading"
    >
      {/* Header row — the heading owns the visual weight; the two
       *  differentiators sit to the right as a tiny hairline meta
       *  string. Merging the old two-pill badge bar into one inline
       *  meta line reclaims ~20 px of vertical rhythm and keeps the
       *  first thing the user reads as a clean product name. */}
      <header className="timeline-transfer-dialog__qs-header">
        <h3
          id="transfer-guest-heading"
          className="timeline-transfer-dialog__tier-heading"
        >
          Quick Share
        </h3>
        <span className="timeline-transfer-dialog__qs-meta" aria-hidden="true">
          72-hour link · no account
        </span>
      </header>
      <p className="timeline-transfer-dialog__helper">
        One-tap temporary link. No sign-in required.
      </p>

      {/* Turnstile in `interaction-only` mode is an invisible captcha
       *  by design — Cloudflare only raises a visible challenge for
       *  suspicious traffic. We therefore REFUSE to reserve a
       *  permanent visible slot (the previous dashed placeholder
       *  confused users into thinking something was missing). The
       *  container stays empty and zero-height until Cloudflare
       *  chooses to render; in that rare case its challenge UI pushes
       *  the CTA down naturally — acceptable reflow for a rare event,
       *  better than a permanent empty box for every user. */}
      <div
        ref={containerRef}
        className="timeline-transfer-dialog__turnstile"
        data-testid="transfer-guest-turnstile"
      />

      {widgetLoadFailed && (
        <p
          className="timeline-transfer-dialog__error"
          role="status"
          aria-live="polite"
          data-testid="transfer-guest-widget-unavailable"
        >
          Couldn't load verification. Disable ad blockers and reload, or use a
          sign-in option below.
        </p>
      )}
      {!widgetLoadFailed && widgetChallengeError && (
        <p
          className="timeline-transfer-dialog__error"
          role="status"
          aria-live="polite"
          data-testid="transfer-guest-widget-challenge-error"
        >
          Verification was reset — please try again.
        </p>
      )}
      {shareError && (
        <p className="timeline-transfer-dialog__error" role="status" aria-live="polite">
          {shareError}
        </p>
      )}

      <button
        className="timeline-transfer-dialog__confirm timeline-transfer-dialog__confirm--guest"
        onClick={onSubmitGuestShare}
        disabled={ctaDisabled}
        aria-describedby={clickwrapId}
        data-testid="transfer-guest-continue"
      >
        {ctaLabel}
        {!shareSubmitting && widgetReady && !widgetLoadFailed && (
          <svg
            className="timeline-transfer-dialog__confirm-arrow"
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <line x1="5" y1="12" x2="19" y2="12" />
            <polyline points="13,6 19,12 13,18" />
          </svg>
        )}
      </button>

      {/* Trust attribution — tiny legend replaces the prior dashed
       *  placeholder. Tells the user that verification exists (so
       *  they're not surprised if Cloudflare does surface a challenge)
       *  without claiming anything is pending on them. Rendered only
       *  once the widget has actually loaded, so a connectivity /
       *  script-blocker failure doesn't pretend to protection that
       *  isn't there. */}
      {widgetReady && (
        <p className="timeline-transfer-dialog__attribution" aria-hidden="true">
          <svg
            width="10"
            height="10"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M12 2l8 3v6c0 5-3.5 9-8 11-4.5-2-8-6-8-11V5l8-3z" />
          </svg>
          <span>Protected by Cloudflare</span>
        </p>
      )}
    </section>
  );
}

/** Guest success footer — expiry chip only.
 *
 *  The prior rhetorical question ("Need permanent share links and
 *  account management?") was deleted in the 2026-04-23 v3 pass: a
 *  dead-end rhetorical question violates conversational-UX norms
 *  (users expect an answer or action after a "?"), and the expiry
 *  chip already communicates "this link is temporary." The account
 *  path is already exposed in the signed-out pre-publish panel, so
 *  re-upselling here was redundant noise.
 *
 *  Rendered
 *  alongside the shared success URL block when `shareResult.mode ===
 *  'guest'`. The `title={iso}` attribute preserves the raw timestamp
 *  so hover reveals UTC. */
function GuestSuccessFooter({ expiresAt }: { expiresAt: string }) {
  // Render BOTH the relative phrase ("in 2 days") and an absolute
  // fallback. Relative is the primary read — users don't want to do
  // date math against a 72-hour window — and absolute lives in the
  // element's `title` attribute for hover/longpress + screen-reader
  // context, matching the pattern recommended by the W3C for
  // time-sensitive UI.
  const formattedAbs = (() => {
    try {
      return new Intl.DateTimeFormat(undefined, {
        dateStyle: 'medium',
        timeStyle: 'short',
      }).format(new Date(expiresAt));
    } catch {
      return expiresAt;
    }
  })();
  const relative = formatRelativeFromNow(expiresAt);
  return (
    <div
      className="timeline-transfer-dialog__expiry-chip"
      title={`${formattedAbs} · ${expiresAt}`}
      data-testid="transfer-guest-expiry"
    >
      {/* The `transfer-guest-success` test-id used to live on an outer
       *  wrapper div that carried no CSS and only one child; the
       *  wrapper was flattened 2026-04-23 v5. The same id rides on
       *  the expiry chip now so existing tests that query the
       *  signal keep working. */}
      <span
        className="timeline-transfer-dialog__expiry-chip-dot"
        aria-hidden="true"
        data-testid="transfer-guest-success"
      />
      <span className="timeline-transfer-dialog__expiry-chip-label">Expires</span>
      <span className="timeline-transfer-dialog__expiry-chip-when">{relative}</span>
      <span className="timeline-transfer-dialog__expiry-chip-abs" aria-hidden="true">
        {formattedAbs}
      </span>
    </div>
  );
}
