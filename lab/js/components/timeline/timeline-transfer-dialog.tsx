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
                <div className="timeline-transfer-dialog__url-row">
                  <input
                    className="timeline-transfer-dialog__url-input"
                    type="text"
                    value={shareUrl}
                    readOnly
                    onFocus={(e) => e.target.select()}
                    aria-label="Share link"
                  />
                  <button
                    className="timeline-transfer-dialog__copy"
                    onClick={handleCopy}
                    title="Copy link to clipboard"
                  >
                    {/* Clipboard icon */}
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                    </svg>
                    <span>{copied ? 'Copied' : 'Copy'}</span>
                  </button>
                </div>
                {shareCode && (
                  <div className="timeline-transfer-dialog__share-actions-row">
                    <a
                      className="timeline-transfer-dialog__watch-link"
                      href={`/watch/?c=${shareCode}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      data-testid="transfer-open-in-watch"
                      aria-label="Open in Watch (opens in new tab)"
                    >
                      {/* Play-circle icon */}
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <circle cx="12" cy="12" r="10" />
                        <polygon points="10,8 16,12 10,16" fill="currentColor" stroke="none" />
                      </svg>
                      <span>Open in Watch</span>
                    </a>
                    <span className="timeline-transfer-dialog__code-badge">
                      {shareCode}
                    </span>
                  </div>
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
                      {/* External link icon */}
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{verticalAlign: '-1px', marginRight: '4px'}}>
                        <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                        <polyline points="15,3 21,3 21,9" />
                        <line x1="10" y1="14" x2="21" y2="3" />
                      </svg>
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
                      {/* Disable while a sign-in attempt is in flight so a
                       *  rapid Retry/Continue click can't open a second
                       *  popup shell or fire a parallel intent fetch
                       *  (matches the AccountControl gating). */}
                      <button
                        className="timeline-transfer-dialog__auth-button"
                        onClick={onRetryPopup}
                        disabled={transferBusy || isStartingSignIn}
                        data-testid="transfer-popup-retry"
                      >
                        Retry {providerLabel(popupBlocked.provider)} popup
                      </button>
                      <button
                        className="timeline-transfer-dialog__auth-button"
                        onClick={onSignInSameTab}
                        disabled={transferBusy || isStartingSignIn}
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
                    <AgeClickwrapNotice id={CLICKWRAP_SHARE_ID} action="continue" />
                    <div className="timeline-transfer-dialog__auth-buttons">
                      <button
                        className="timeline-transfer-dialog__auth-button"
                        onClick={() => onSignIn('google')}
                        disabled={transferBusy || isStartingSignIn}
                        aria-describedby={CLICKWRAP_SHARE_ID}
                        data-testid="transfer-auth-google"
                      >
                        Continue with Google
                      </button>
                      <button
                        className="timeline-transfer-dialog__auth-button"
                        onClick={() => onSignIn('github')}
                        disabled={transferBusy || isStartingSignIn}
                        aria-describedby={CLICKWRAP_SHARE_ID}
                        data-testid="transfer-auth-github"
                      >
                        Continue with GitHub
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
                <ShareActions onCancel={handleCancel} transferBusy={transferBusy} />
              </div>
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
