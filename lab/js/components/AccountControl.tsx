/**
 * AccountControl — compact account chip in the Lab top bar (Phase 6 Auth UX).
 *
 * Four states, keyed by `auth.status`:
 *   - loading     → render nothing (tiny reserved slot feels worse than
 *                   empty; session arrives within ~100ms on warm paths).
 *   - signed-in   → pill chip with avatar glyph + display name. Click
 *                   opens a popover with identity summary + Sign out.
 *   - signed-out  → subtle "Sign in" text action that expands a popover
 *                   offering Continue with Google / Continue with GitHub.
 *   - unverified  → muted "Sign-in unknown" action whose popover is a
 *                   single "Retry" button. We deliberately do NOT show
 *                   the OAuth providers here — pretending the user is
 *                   signed-out on a transport blip would push them into
 *                   an unnecessary OAuth round-trip.
 *
 * Accessibility: this is a plain disclosure (toggle button + revealed
 * panel of native buttons), NOT an ARIA `menu` widget. ARIA menus require
 * arrow-key navigation, typeahead, and initial focus management; a plain
 * disclosure with native `<button>` children is reachable via Tab and is
 * the right pattern for a 1–3 item account popover.
 *
 * The control is a secondary auth entry — the Transfer dialog's Share tab
 * remains the primary publish gateway. When signed out, clicking a provider
 * button does NOT stash the resume-publish intent (the user hasn't asked to
 * publish; they just want to sign in for later).
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useAppStore } from '../store/app-store';
import { hydrateAuthSession } from '../runtime/auth-runtime';
import { AgeGateCheckbox, AGE_INTENT_STALE_AFTER_MS } from './AgeGateCheckbox';

function useOnClickOutside(ref: React.RefObject<HTMLElement | null>, onOutside: () => void, active: boolean) {
  useEffect(() => {
    if (!active) return;
    const handle = (e: PointerEvent) => {
      const el = ref.current;
      if (!el) return;
      if (e.target instanceof Node && !el.contains(e.target)) onOutside();
    };
    // Use pointerdown so we react before a click that may land on another
    // button (matters for menus that should close when any other control
    // is pressed).
    document.addEventListener('pointerdown', handle);
    return () => document.removeEventListener('pointerdown', handle);
  }, [ref, onOutside, active]);
}

function useEscapeToClose(onClose: () => void, active: boolean) {
  useEffect(() => {
    if (!active) return;
    const handle = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('keydown', handle);
    return () => document.removeEventListener('keydown', handle);
  }, [onClose, active]);
}

export function AccountControl() {
  const status = useAppStore((s) => s.auth.status);
  const session = useAppStore((s) => s.auth.session);
  const callbacks = useAppStore((s) => s.authCallbacks);
  const popupBlocked = useAppStore((s) => s.authPopupBlocked);

  const [open, setOpen] = useState(false);
  const [retrying, setRetrying] = useState(false);
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
  const rootRef = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);

  useOnClickOutside(rootRef, close, open);
  useEscapeToClose(close, open);

  // Close the menu if the session changes (e.g. sign-out completes or the
  // session is revoked elsewhere) — prevents a stale menu from lingering.
  useEffect(() => { setOpen(false); }, [session]);

  if (status === 'loading') {
    // Reserve no space — the chip replaces nothing else in the grid.
    return null;
  }

  const handleSignIn = (provider: 'google' | 'github') => {
    if (!ageConfirmed || !ageIntent || ageMintedAt === null) return;
    // Click-time freshness check: if the prefetched token is older
    // than the staleness threshold (background-throttle, sleep/resume,
    // or a missed periodic refresh), refuse the click and show an
    // inline note. The AgeGateCheckbox effect will re-mint within a
    // few hundred ms; the user clicks again on the second tap. Doing
    // an awaited fetch here would break popup-not-blocked semantics
    // (window.open requires a synchronous user gesture).
    if (Date.now() - ageMintedAt > AGE_INTENT_STALE_AFTER_MS) {
      setAgeStaleNote('Refreshing sign-in… click again in a moment.');
      // Drop the stale token AND increment the refresh nonce so the
      // checkbox effect actually re-runs. Without the nonce bump the
      // component would stay idle until the next 4-min tick or
      // visibilitychange — leaving the user looking at a disabled
      // button and a misleading "click again" note.
      setAgeIntent(null);
      setAgeMintedAt(null);
      setAgeRefreshNonce((n) => n + 1);
      return;
    }
    // Secondary entry — user hasn't asked to publish, so no resume intent.
    callbacks?.onSignIn(provider, { ageIntent, ageIntentMintedAt: ageMintedAt });
  };

  /** True when the popup-blocked descriptor's snapshot of the age
   *  intent is older than the staleness threshold. The descriptor's
   *  token would still arrive at /auth/{provider}/start as fresh from
   *  the server's perspective until 5 minutes have elapsed, but
   *  refusing reuse at the 4-minute mark mirrors the click-time guard
   *  on the live AgeGateCheckbox so the user never hits a raw 400. */
  const popupBlockedTokenIsStale = (): boolean => {
    if (!popupBlocked?.ageIntent || popupBlocked.ageIntentMintedAt == null) return false;
    return Date.now() - popupBlocked.ageIntentMintedAt > AGE_INTENT_STALE_AFTER_MS;
  };

  /** Stale-token recovery for popup-blocked retry / same-tab paths.
   *  Clears the blocked descriptor (returning the user to the provider
   *  picker), surfaces an inline note, AND bumps the AgeGateCheckbox
   *  refresh nonce so a fresh intent is minted immediately rather than
   *  waiting for the next 4-min interval. */
  const recoverStalePopupBlocked = () => {
    useAppStore.getState().setAuthPopupBlocked(null);
    setAgeStaleNote('Refreshing sign-in… choose your provider again.');
    setAgeIntent(null);
    setAgeMintedAt(null);
    setAgeRefreshNonce((n) => n + 1);
  };

  const handleSignOut = async () => {
    await callbacks?.onSignOut();
    setOpen(false);
  };

  const handleRetry = async () => {
    setRetrying(true);
    try { await hydrateAuthSession(); } finally { setRetrying(false); setOpen(false); }
  };

  const handleRetryPopup = () => {
    if (!popupBlocked || !callbacks) return;
    // Stale token? Reroute to the picker so a fresh nonce is minted.
    // Reusing an expired token would land at /auth/{provider}/start
    // and immediately 400 the user.
    if (popupBlockedTokenIsStale()) {
      recoverStalePopupBlocked();
      return;
    }
    // Carry the original ageIntent + mintedAt through the retry —
    // without ageIntent the second attempt would land at
    // /auth/{provider}/start with no nonce and immediately 400.
    // Mirrors TimelineBar.handleRetryPopup.
    callbacks.onSignIn(popupBlocked.provider, {
      resumePublish: popupBlocked.resumePublish,
      ageIntent: popupBlocked.ageIntent ?? null,
      ageIntentMintedAt: popupBlocked.ageIntentMintedAt ?? null,
    });
  };

  const handleContinueInTab = () => {
    // Same staleness guard as the popup retry — the same-tab redirect
    // would otherwise reuse an expired snapshot and 400 the user
    // mid-navigation.
    if (popupBlockedTokenIsStale()) {
      recoverStalePopupBlocked();
      return;
    }
    callbacks?.onSignInSameTab();
  };

  /** Dismiss the popup-blocked sub-menu so the provider picker re-renders
   *  — lets the user switch providers without first committing to either
   *  Retry or the destructive same-tab path. Delegates to the runtime so
   *  the resume-publish sentinel is cleared for abandoned publish flows. */
  const handleDismissPopupBlocked = () => {
    callbacks?.onDismissPopupBlocked();
  };

  const providerLabel = (p: 'google' | 'github') => (p === 'google' ? 'Google' : 'GitHub');

  if (status === 'signed-in' && session) {
    const label = session.displayName?.trim() || shortenUserId(session.userId);
    return (
      <div className="account-control" ref={rootRef} data-testid="account-control" data-auth-status={status}>
        <button
          className="account-control__trigger account-control__trigger--chip"
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          data-testid="account-chip"
        >
          <span className="account-control__avatar" aria-hidden="true">{label.charAt(0).toUpperCase()}</span>
          <span className="account-control__label">{label}</span>
        </button>
        {open && (
          <div className="account-control__menu" aria-label="Account">
            <p className="account-control__identity" aria-label="Signed in as">
              {session.displayName ?? shortenUserId(session.userId)}
            </p>
            {/* Task-oriented label — the destination is the page that
              * lists the user's published share links and exposes the
              * delete controls. Rendered as a real <a> so middle-click
              * / cmd-click open in a new tab work as expected. */}
            <a
              className="account-control__menu-item"
              href="/account/"
              onClick={close}
              data-testid="account-manage-uploads"
            >
              Manage uploads
            </a>
            <button
              className="account-control__menu-item account-control__menu-item--destructive"
              onClick={handleSignOut}
              data-testid="account-signout"
            >
              Sign out
            </button>
          </div>
        )}
      </div>
    );
  }

  if (status === 'unverified') {
    return (
      <div className="account-control" ref={rootRef} data-testid="account-control" data-auth-status={status}>
        <button
          className="account-control__trigger account-control__trigger--unverified"
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          data-testid="account-unverified"
        >
          <span className="account-control__label">Sign-in unknown</span>
        </button>
        {open && (
          <div className="account-control__menu" aria-label="Sign-in status">
            <p className="account-control__hint">
              We couldn't verify your sign-in state. Check your connection and retry.
            </p>
            <button
              className="account-control__menu-item"
              onClick={handleRetry}
              disabled={retrying}
              data-testid="account-retry"
            >
              {retrying ? 'Checking…' : 'Retry'}
            </button>
          </div>
        )}
      </div>
    );
  }

  // signed-out
  return (
    <div className="account-control" ref={rootRef} data-testid="account-control" data-auth-status={status}>
      <button
        className="account-control__trigger"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        data-testid="account-signin"
      >
        <span className="account-control__label">Sign in</span>
      </button>
      {open && (
        <div className="account-control__menu" aria-label="Sign in">
          {popupBlocked ? (
            /* Popup-blocked sub-menu — Retry / Continue-in-tab / Back.
             *  The Back option lets the user switch providers without
             *  committing to either of the other paths. */
            <div data-testid="account-popup-blocked">
              <p className="account-control__hint">
                {providerLabel(popupBlocked.provider)} popup was blocked. Retry, continue in this tab,
                or go back to pick another sign-in method. Unsaved Lab state may be lost on same-tab sign-in.
              </p>
              <button
                className="account-control__menu-item"
                onClick={handleRetryPopup}
                data-testid="account-popup-retry"
              >
                Retry {providerLabel(popupBlocked.provider)} popup
              </button>
              <button
                className="account-control__menu-item"
                onClick={handleContinueInTab}
                data-testid="account-popup-same-tab"
              >
                Continue in this tab
              </button>
              <button
                className="account-control__menu-item"
                onClick={handleDismissPopupBlocked}
                data-testid="account-popup-back"
              >
                Back
              </button>
            </div>
          ) : (
            <>
              <p className="account-control__hint">
                Sign in to publish share links. Reading and downloading stay public.
              </p>
              <AgeGateCheckbox
                checked={ageConfirmed}
                onCheckedChange={setAgeConfirmed}
                onAgeIntent={handleAgeIntent}
                onFetchingChange={setAgeFetching}
                refreshNonce={ageRefreshNonce}
                idSuffix="accountcontrol"
                compact
              />
              {ageStaleNote && !ageIntent ? (
                <p className="age-gate__note" role="status" aria-live="polite">
                  {ageFetching ? 'Refreshing sign-in…' : ageStaleNote}
                </p>
              ) : null}
              <button
                className="account-control__menu-item"
                onClick={() => handleSignIn('google')}
                disabled={!ageConfirmed || !ageIntent}
                data-testid="account-signin-google"
              >
                Continue with Google
              </button>
              <button
                className="account-control__menu-item"
                onClick={() => handleSignIn('github')}
                disabled={!ageConfirmed || !ageIntent}
                data-testid="account-signin-github"
              >
                Continue with GitHub
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

/** Display fallback when the identity provider did not return a name — the
 *  raw user id (a ULID/UUID) is too long for the chip. Keep first 8 chars. */
function shortenUserId(userId: string): string {
  return userId.length <= 10 ? userId : `${userId.slice(0, 8)}…`;
}
