/**
 * AccountControl — compact account chip in the Lab top bar.
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
 * Age clickwrap (D120 — supersedes D118): the signed-out menu shows a
 * single short clickwrap sentence above the provider buttons. No
 * checkbox, no local age-intent state. The runtime owns the
 * popup-shell-then-fetch-then-navigate sequence — the click handler
 * is synchronous and passes only `{ resumePublish }` to `onSignIn`.
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
import { AgeClickwrapNotice } from './AgeClickwrapNotice';

const CLICKWRAP_ID = 'age-clickwrap-account';

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
  const signInAttempt = useAppStore((s) => s.authSignInAttempt);

  const [open, setOpen] = useState(false);
  const [retrying, setRetrying] = useState(false);
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

  // Secondary entry — user hasn't asked to publish, so resumePublish=false.
  // Click handler MUST stay synchronous (no awaits) so the runtime can
  // open the popup shell inside the live user gesture.
  const handleSignIn = (provider: 'google' | 'github') => {
    callbacks?.onSignIn(provider, { resumePublish: false });
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
    // Re-issue the original click; the runtime fetches a fresh age
    // intent JIT, so there is no stale-token recovery to perform here.
    callbacks.onSignIn(popupBlocked.provider, { resumePublish: popupBlocked.resumePublish });
  };

  const handleContinueInTab = () => {
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
              * delete controls. Opens in a new tab so the user keeps
              * their current Lab session intact (mirrors the same link
              * in the Transfer dialog's Share-success state). */}
            <a
              className="account-control__menu-item"
              href="/account/"
              target="_blank"
              rel="noopener noreferrer"
              onClick={close}
              data-testid="account-manage-uploads"
              aria-label="Manage uploads (opens in new tab)"
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
  // Provider buttons are disabled while a sign-in attempt is in flight
  // (status==='starting') so the user can't kick off a parallel attempt
  // while the popup shell is still navigating.
  const isStarting = signInAttempt?.status === 'starting';
  const failedMessage = signInAttempt?.status === 'failed' ? signInAttempt.message : null;
  const failedProvider = signInAttempt?.status === 'failed' ? signInAttempt.provider : null;

  return (
    <div className="account-control" ref={rootRef} data-testid="account-control" data-auth-status={status}>
      <button
        className="account-control__trigger account-control__trigger--signin"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        data-testid="account-signin"
      >
        <span className="account-control__label">Sign in</span>
      </button>
      {open && (
        // The `--signin` CTA-frame modifier is applied ONLY when the
        // signed-out provider-picker branch renders — not when the
        // popup-blocked recovery branch takes over. Keeps the
        // popup-blocked sub-menu on the default 4 px list-frame so its
        // `.account-control__menu-item` rows match the signed-in /
        // unverified surfaces. Switches back to the CTA frame if the
        // user clicks Back (popup-blocked → provider-picker).
        <div
          className={`account-control__menu${popupBlocked ? '' : ' account-control__menu--signin'}`}
          aria-label="Sign in"
        >
          {popupBlocked ? (
            /* Popup-blocked sub-menu — Retry / Continue-in-tab / Back.
             *  Keeps the list-style `.account-control__menu-item` shape
             *  because these are recovery actions, not primary CTAs. */
            <div data-testid="account-popup-blocked">
              <p className="account-control__hint">
                {providerLabel(popupBlocked.provider)} popup was blocked. Retry, continue in this tab,
                or go back to pick another sign-in method. Unsaved Lab state may be lost on same-tab sign-in.
              </p>
              <button
                className="account-control__menu-item"
                onClick={handleRetryPopup}
                disabled={isStarting}
                data-testid="account-popup-retry"
              >
                Retry {providerLabel(popupBlocked.provider)} popup
              </button>
              <button
                className="account-control__menu-item"
                onClick={handleContinueInTab}
                disabled={isStarting}
                data-testid="account-popup-same-tab"
              >
                Continue in this tab
              </button>
              <button
                className="account-control__menu-item"
                onClick={handleDismissPopupBlocked}
                disabled={isStarting}
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
              <AgeClickwrapNotice id={CLICKWRAP_ID} action="continue" />
              <div className="account-control__auth-buttons">
                <button
                  className="account-control__auth-button"
                  onClick={() => handleSignIn('google')}
                  disabled={isStarting}
                  aria-describedby={CLICKWRAP_ID}
                  data-testid="account-signin-google"
                >
                  Continue with Google
                </button>
                <button
                  className="account-control__auth-button"
                  onClick={() => handleSignIn('github')}
                  disabled={isStarting}
                  aria-describedby={CLICKWRAP_ID}
                  data-testid="account-signin-github"
                >
                  Continue with GitHub
                </button>
              </div>
            </>
          )}
          {isStarting ? (
            <p className="auth-attempt-status" role="status" aria-live="polite">
              Starting sign-in…
            </p>
          ) : null}
          {failedMessage ? (
            <p className="auth-attempt-status auth-attempt-status--failed" role="status" aria-live="polite">
              {failedMessage}
              {failedProvider ? (
                <button
                  className="auth-attempt-retry"
                  onClick={() => handleSignIn(failedProvider)}
                  data-testid="account-signin-retry"
                >
                  Retry
                </button>
              ) : null}
            </p>
          ) : null}
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
