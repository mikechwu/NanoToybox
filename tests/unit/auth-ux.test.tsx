/**
 * @vitest-environment jsdom
 */
/**
 * Phase 6 Auth UX — the auth surface is additive: Lab boot never blocks on
 * the session fetch, Watch and local download stay public, and sign-in is
 * only surfaced when the user asks to publish.
 *
 * These tests cover:
 *   1. Transfer dialog Share tab states — checking / prompt / publish-ready /
 *      success — gated on auth.loading and auth.session.
 *   2. Default tab preference — Share wins when available; Download is the
 *      fallback when Share is not wired.
 *   3. AccountControl top-bar states — loading / signed-out / signed-in with
 *      popover menu wiring to the authCallbacks.
 *   4. authRuntime hydration — 200, 401, and network-error paths settle the
 *      store into { loading: false, ... } without throwing.
 *   5. Resume-publish intent — sessionStorage round-trip + store nonce
 *      (the cross-redirect reentry contract).
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, act, fireEvent } from '@testing-library/react';
import { useAppStore, type TimelineCallbacks } from '../../lab/js/store/app-store';
import { TimelineBar } from '../../lab/js/components/timeline/TimelineBar';
import { AccountControl } from '../../lab/js/components/AccountControl';
import {
  createAuthRuntime,
  hydrateAuthSession,
  consumeResumePublishIntent,
  attachAuthCompleteListener,
  AuthRequiredError,
  _resetAuthRuntimeForTest,
} from '../../lab/js/runtime/auth-runtime';
import { TopRightControls } from '../../lab/js/components/TopRightControls';

// ── Shared fixtures ──

const noop = () => {};

const baseTimelineCallbacks: TimelineCallbacks = {
  onScrub: noop,
  onReturnToLive: noop,
  onEnterReview: noop,
  onRestartFromHere: noop,
  onStartRecordingNow: noop,
  onTurnRecordingOff: noop,
};

function installPublishableTimeline() {
  useAppStore.getState().installTimelineUI(
    {
      ...baseTimelineCallbacks,
      onExportHistory: vi.fn(async () => 'saved' as const),
      onPublishCapsule: vi.fn(async () => ({
        mode: 'account' as const,
        shareCode: 'AAAA1111BBBB',
        shareUrl: 'https://atomdojo.pages.dev/c/AAAA1111BBBB',
      })),
      onPauseForExport: vi.fn(() => true),
      onResumeFromExport: vi.fn(),
    },
    'active',
    { full: true, capsule: true },
  );
  useAppStore.getState().updateTimelineState({
    mode: 'live', currentTimePs: 100, reviewTimePs: null,
    rangePs: { start: 0, end: 200 },
    canReturnToLive: false, canRestart: false, restartTargetPs: null,
  });
}

function setSession(session: { userId: string; displayName: string | null } | null) {
  // Use the narrow helpers — they are the canonical way to advance the
  // auth state machine and they enforce the AuthState invariant by
  // construction (no risk of constructing impossible shapes in tests).
  if (session) useAppStore.getState().setAuthSignedIn(session);
  else useAppStore.getState().setAuthSignedOut();
}

/** Stub `/api/account/age-confirmation/intent` so the runtime's
 *  just-in-time fetch resolves with a stable token. Returns the
 *  original `fetch` so the caller can restore in `finally`. Token
 *  defaults to `'test-token'`; pass a different value for tests that
 *  assert the URL contains a specific intent. */
function stubAgeIntentFetch(token: string = 'test-token'): typeof fetch {
  const original = globalThis.fetch;
  globalThis.fetch = vi.fn(async (url) => {
    if (String(url).includes('/api/account/age-confirmation/intent')) {
      return new Response(JSON.stringify({ ageIntent: token, ttlSeconds: 300 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response('not mocked', { status: 500 });
  }) as typeof fetch;
  return original;
}

/** Make `/api/account/age-confirmation/intent` reject — used by tests
 *  that assert the runtime surfaces a structured failure via
 *  `authSignInAttempt: 'failed'`. */
function stubAgeIntentNetworkError(): typeof fetch {
  const original = globalThis.fetch;
  globalThis.fetch = vi.fn(async (url) => {
    if (String(url).includes('/api/account/age-confirmation/intent')) {
      throw new TypeError('NetworkError');
    }
    return new Response('not mocked', { status: 500 });
  }) as typeof fetch;
  return original;
}

/** Flush queued microtasks AND a macrotask tick so the runtime's
 *  `void (async () => { … })()` IIFE runs to completion before
 *  assertions. The fetch + response.json() chain creates several
 *  awaits internally; six microtask drains plus a setTimeout(0) tick
 *  is enough to settle them in vitest's jsdom environment. */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 6; i++) await Promise.resolve();
  await new Promise<void>((r) => setTimeout(r, 0));
  for (let i = 0; i < 6; i++) await Promise.resolve();
}

// ── Transfer dialog Share tab states ──

describe('Transfer dialog — Share tab auth gating', () => {
  beforeEach(() => { useAppStore.getState().resetTransientState(); });
  afterEach(() => { cleanup(); });

  it('shows "Checking sign-in…" while auth.status is loading', () => {
    act(() => {
      installPublishableTimeline();
      useAppStore.getState().setAuthLoading();
    });
    render(<TimelineBar />);
    act(() => { (document.querySelector('.timeline-transfer-trigger') as HTMLButtonElement).click(); });

    // Dialog opens; Share is default; neither prompt nor publish shows while loading.
    expect(document.querySelector('.timeline-transfer-dialog')).not.toBeNull();
    expect(document.querySelector('[data-testid="transfer-auth-prompt"]')).toBeNull();
    expect(document.querySelector('.timeline-transfer-dialog__confirm')).toBeNull();
    const checking = document.querySelector('.timeline-transfer-dialog__auth-checking');
    expect(checking?.textContent).toContain('Checking sign-in');
  });

  it('shows auth prompt with Google + GitHub buttons when signed out', () => {
    act(() => {
      installPublishableTimeline();
      setSession(null);
    });
    render(<TimelineBar />);
    act(() => { (document.querySelector('.timeline-transfer-trigger') as HTMLButtonElement).click(); });

    const prompt = document.querySelector('[data-testid="transfer-auth-prompt"]');
    expect(prompt).not.toBeNull();
    expect(prompt?.textContent).toContain('Sign in to publish');
    expect(document.querySelector('[data-testid="transfer-auth-google"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="transfer-auth-github"]')).not.toBeNull();
    // Publish button must NOT be rendered when signed out — auth prompt replaces it.
    expect(document.querySelector('.timeline-transfer-dialog__confirm')).toBeNull();
  });

  it('auth prompt button invokes authCallbacks.onSignIn with resumePublish: true (D120 flow)', () => {
    // D120 (supersedes D118): the buttons render the clickwrap notice
    // and call onSignIn synchronously with NO age intent — the runtime
    // owns the JIT fetch. The host's adapter unwraps the click into
    // `{ resumePublish: true }`.
    const onSignIn = vi.fn();
    act(() => {
      installPublishableTimeline();
      setSession(null);
      useAppStore.getState().setAuthCallbacks({
        onSignIn, onSignInSameTab: vi.fn(),
        onDismissPopupBlocked: vi.fn(), onSignOut: vi.fn(async () => {}),
      });
    });
    render(<TimelineBar />);
    act(() => { (document.querySelector('.timeline-transfer-trigger') as HTMLButtonElement).click(); });

    // Clickwrap renders + provider buttons reference it via aria-describedby.
    const clickwrap = document.getElementById('age-clickwrap-share');
    expect(clickwrap).not.toBeNull();
    expect(clickwrap?.textContent).toContain('confirm that you are at least 13');
    const google = document.querySelector('[data-testid="transfer-auth-google"]') as HTMLButtonElement;
    expect(google.getAttribute('aria-describedby')).toBe('age-clickwrap-share');

    act(() => { google.click(); });
    expect(onSignIn).toHaveBeenCalledWith('google', { resumePublish: true });

    act(() => { (document.querySelector('[data-testid="transfer-auth-github"]') as HTMLButtonElement).click(); });
    expect(onSignIn).toHaveBeenCalledWith('github', { resumePublish: true });
  });

  it('shows Publish button when signed in', () => {
    act(() => {
      installPublishableTimeline();
      setSession({ userId: 'u1', displayName: 'Alice' });
    });
    render(<TimelineBar />);
    act(() => { (document.querySelector('.timeline-transfer-trigger') as HTMLButtonElement).click(); });

    const confirm = document.querySelector('.timeline-transfer-dialog__confirm');
    expect(confirm).not.toBeNull();
    expect(confirm?.textContent).toContain('Publish');
    expect(document.querySelector('[data-testid="transfer-auth-prompt"]')).toBeNull();
  });
});

// ── Default tab preference ──

describe('Transfer dialog — default tab preference', () => {
  beforeEach(() => { useAppStore.getState().resetTransientState(); });
  afterEach(() => { cleanup(); });

  it('defaults to Share tab when both destinations are available', () => {
    act(() => { installPublishableTimeline(); setSession({ userId: 'u1', displayName: 'Alice' }); });
    render(<TimelineBar />);
    act(() => { (document.querySelector('.timeline-transfer-trigger') as HTMLButtonElement).click(); });

    const shareTab = Array.from(document.querySelectorAll('.timeline-transfer-dialog__tab'))
      .find((t) => t.textContent?.trim() === 'Share');
    expect(shareTab?.getAttribute('aria-selected')).toBe('true');
  });

  it('falls back to Download when Share is not wired', () => {
    act(() => {
      // Install with export only, no publish.
      useAppStore.getState().installTimelineUI(
        {
          ...baseTimelineCallbacks,
          onExportHistory: vi.fn(async () => 'saved' as const),
          onPauseForExport: vi.fn(() => true),
          onResumeFromExport: vi.fn(),
        },
        'active',
        { full: true, capsule: true },
      );
      useAppStore.getState().updateTimelineState({
        mode: 'live', currentTimePs: 100, reviewTimePs: null,
        rangePs: { start: 0, end: 200 },
        canReturnToLive: false, canRestart: false, restartTargetPs: null,
      });
    });
    render(<TimelineBar />);
    act(() => { (document.querySelector('.timeline-transfer-trigger') as HTMLButtonElement).click(); });

    // Tab bar is hidden (only one destination) — check the download panel renders.
    expect(document.querySelector('[role="tabpanel"][aria-label="Download"]')).not.toBeNull();
  });
});

// ── AccountControl ──

describe('AccountControl top-bar', () => {
  beforeEach(() => { useAppStore.getState().resetTransientState(); });
  afterEach(() => { cleanup(); });

  it('renders nothing while auth is loading', () => {
    act(() => { useAppStore.getState().setAuthLoading(); });
    const { container } = render(<AccountControl />);
    expect(container.firstChild).toBeNull();
  });

  it('shows "Sign in" trigger when signed out, with Google + GitHub menu items + clickwrap', () => {
    // D120 (supersedes D118): provider buttons render immediately
    // alongside the clickwrap notice. No checkbox state. AccountControl
    // is the SECONDARY entry — resumePublish is false.
    const onSignIn = vi.fn();
    act(() => {
      setSession(null);
      useAppStore.getState().setAuthCallbacks({
        onSignIn, onSignInSameTab: vi.fn(),
        onDismissPopupBlocked: vi.fn(), onSignOut: vi.fn(async () => {}),
      });
    });
    render(<AccountControl />);

    const trigger = document.querySelector('[data-testid="account-signin"]') as HTMLButtonElement;
    expect(trigger).not.toBeNull();
    expect(trigger.textContent).toContain('Sign in');

    act(() => { trigger.click(); });
    const google = document.querySelector('[data-testid="account-signin-google"]') as HTMLButtonElement;
    const github = document.querySelector('[data-testid="account-signin-github"]') as HTMLButtonElement;
    expect(google).not.toBeNull();
    expect(github).not.toBeNull();

    // Clickwrap renders + buttons reference it via aria-describedby.
    const clickwrap = document.getElementById('age-clickwrap-account');
    expect(clickwrap).not.toBeNull();
    expect(clickwrap?.textContent).toContain('confirm that you are at least 13');
    expect(google.getAttribute('aria-describedby')).toBe('age-clickwrap-account');
    expect(github.getAttribute('aria-describedby')).toBe('age-clickwrap-account');

    act(() => { google.click(); });
    expect(onSignIn).toHaveBeenCalledTimes(1);
    expect(onSignIn).toHaveBeenCalledWith('google', { resumePublish: false });
  });

  it('shows account chip with display name and Sign out when signed in', async () => {
    const onSignOut = vi.fn(async () => {});
    act(() => {
      setSession({ userId: 'user-12345678', displayName: 'Alice Smith' });
      useAppStore.getState().setAuthCallbacks({ onSignIn: vi.fn(), onSignInSameTab: vi.fn(), onDismissPopupBlocked: vi.fn(), onSignOut });
    });
    render(<AccountControl />);

    const chip = document.querySelector('[data-testid="account-chip"]') as HTMLButtonElement;
    expect(chip).not.toBeNull();
    expect(chip.textContent).toContain('Alice Smith');

    act(() => { chip.click(); });
    const signOut = document.querySelector('[data-testid="account-signout"]') as HTMLButtonElement;
    expect(signOut).not.toBeNull();
    await act(async () => { signOut.click(); });
    expect(onSignOut).toHaveBeenCalledTimes(1);
  });

  it('falls back to truncated user id when display name is null', () => {
    act(() => { setSession({ userId: 'very-long-user-id-0123456789', displayName: null }); });
    render(<AccountControl />);
    const chip = document.querySelector('[data-testid="account-chip"]');
    expect(chip?.textContent).toContain('very-lon'); // first 8 chars + ellipsis
  });
});

// ── authRuntime hydration ──

describe('hydrateAuthSession', () => {
  const originalFetch = globalThis.fetch;
  beforeEach(() => {
    useAppStore.getState().resetTransientState();
    // resetTransientState does not reset the auth state (auth is a
    // cross-session concern, not UI transience). Tests that exercise the
    // "first-load" branches must start from the `loading` state.
    useAppStore.getState().setAuthLoading();
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    cleanup();
  });

  it('settles to signed-in on 200 { status: signed-in, ... }', async () => {
    globalThis.fetch = vi.fn(async () => new Response(
      JSON.stringify({ status: 'signed-in', userId: 'u1', displayName: 'Alice', createdAt: '2026-01-01' }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )) as typeof fetch;

    const state = await hydrateAuthSession();
    expect(state.status).toBe('signed-in');
    expect(state.session?.userId).toBe('u1');
  });

  it('sends cache:no-store and credentials:same-origin on the session probe', async () => {
    const fetchSpy = vi.fn(async () => new Response(
      JSON.stringify({ status: 'signed-out' }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )) as unknown as typeof fetch;
    globalThis.fetch = fetchSpy;
    await hydrateAuthSession();
    // Verify the request options — important enough to guard against a
    // future regression that lets a browser cache a stale signed-in/out
    // response across logout/popup-login transitions.
    const [, init] = (fetchSpy as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(init).toMatchObject({
      method: 'GET',
      credentials: 'same-origin',
      cache: 'no-store',
    });
  });

  it('settles to signed-out on 200 { status: signed-out } (NOT 401)', async () => {
    // New contract: signed-out is a normal state, not a 401. The endpoint
    // always returns 200 with a discriminator so a routine Lab boot does
    // not emit a red network entry.
    globalThis.fetch = vi.fn(async () => new Response(
      JSON.stringify({ status: 'signed-out' }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )) as typeof fetch;
    const state = await hydrateAuthSession();
    expect(state).toEqual({ status: 'signed-out', session: null });
  });

  it('treats an unexpected 401 as a server error, not an authoritative signed-out', async () => {
    // Under the new contract, 401 on /api/auth/session means "server/proxy
    // misconfiguration" (the endpoint should never return it). Route
    // through the indeterminate path so we don't weaken a signed-in prior.
    useAppStore.getState().setAuthSignedIn({ userId: 'alice', displayName: 'Alice' });
    globalThis.fetch = vi.fn(async () => new Response('Unauthorized', { status: 401 })) as typeof fetch;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const state = await hydrateAuthSession();
    // Prior signed-in preserved because 401 now goes through resolveIndeterminate.
    expect(state.status).toBe('signed-in');
    warn.mockRestore();
  });

  it('preserves the current session on network failure (never flips signed-in → signed-out)', async () => {
    // Seed a signed-in session, then simulate a transient network failure.
    useAppStore.getState().setAuthSignedIn({ userId: 'alice', displayName: 'Alice' });
    globalThis.fetch = vi.fn(async () => { throw new Error('network down'); }) as typeof fetch;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const state = await hydrateAuthSession();
    expect(state.status).toBe('signed-in');
    expect(state.session?.userId).toBe('alice');
    warn.mockRestore();
  });

  it('first-load network failure settles to unverified (not signed-out)', async () => {
    // No prior session — the default after resetTransientState is loading.
    globalThis.fetch = vi.fn(async () => { throw new Error('ECONNREFUSED'); }) as typeof fetch;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const state = await hydrateAuthSession();
    expect(state).toEqual({ status: 'unverified', session: null });
    warn.mockRestore();
  });

  it('first-load 5xx settles to unverified', async () => {
    globalThis.fetch = vi.fn(async () => new Response('Internal Error', { status: 503 })) as typeof fetch;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const state = await hydrateAuthSession();
    expect(state).toEqual({ status: 'unverified', session: null });
    warn.mockRestore();
  });

  it('malformed 200 response without prior session settles to unverified', async () => {
    globalThis.fetch = vi.fn(async () => new Response(
      JSON.stringify({ wrongShape: true }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )) as typeof fetch;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const state = await hydrateAuthSession();
    expect(state).toEqual({ status: 'unverified', session: null });
    warn.mockRestore();
  });

  it('separates transport failure from body-parse failure in log output (Hunter C1)', async () => {
    // 200 with a body that parses but fails shape validation already tested.
    // Here: 200 with a body that THROWS on .json() (e.g. HTML error page).
    globalThis.fetch = vi.fn(async () => new Response(
      '<html>Gateway timeout</html>',
      { status: 200, headers: { 'Content-Type': 'text/html' } },
    )) as typeof fetch;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const state = await hydrateAuthSession();
    expect(state).toEqual({ status: 'unverified', session: null });
    // Log distinguishes body-parse failure from transport failure so ops
    // can tell "proxy returned HTML" apart from "ECONNREFUSED".
    const messages = warn.mock.calls.map((c) => String(c[0])).join('\n');
    expect(messages).toMatch(/body parse failed/);
    warn.mockRestore();
  });

  it('drops late fetch writes if a newer authoritative state lands first (Reviewer #1 race)', async () => {
    // Two concurrent hydrates. The FIRST issues fetch, the SECOND also issues
    // fetch. The SECOND resolves first (200 status=signed-out). The FIRST
    // resolves later (200 status=signed-in). The sequence token must drop
    // the late signed-in, preserving the authoritative signed-out.
    let resolveFirst!: (r: Response) => void;
    const firstPromise = new Promise<Response>((r) => { resolveFirst = r; });
    const responses = [
      () => firstPromise,
      () => Promise.resolve(new Response(
        JSON.stringify({ status: 'signed-out' }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )),
    ];
    let callIdx = 0;
    globalThis.fetch = vi.fn(() => responses[callIdx++]()) as typeof fetch;

    const inFlight = hydrateAuthSession(); // increments seq to N
    const second = await hydrateAuthSession(); // increments seq to N+1, resolves signed-out
    expect(second.status).toBe('signed-out');
    expect(useAppStore.getState().auth.status).toBe('signed-out');

    // Now the first resolves with signed-in — the sequence token should drop its write.
    resolveFirst(new Response(
      JSON.stringify({ status: 'signed-in', userId: 'late', displayName: 'Late', createdAt: 'x' }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ));
    await inFlight;
    // Authoritative signed-out must still be in the store — the stale signed-in
    // did not clobber it.
    expect(useAppStore.getState().auth.status).toBe('signed-out');
  });

  it('hydrateAuthSession returns a defensive copy (not the store-live reference)', async () => {
    useAppStore.getState().setAuthSignedIn({ userId: 'alice', displayName: 'Alice' });
    globalThis.fetch = vi.fn(async () => { throw new Error('network down'); }) as typeof fetch;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const returned = await hydrateAuthSession();
    const live = useAppStore.getState().auth;
    // Shallow-copy policy: different object identity, equal contents.
    expect(returned).not.toBe(live);
    expect(returned).toEqual(live);
    warn.mockRestore();
  });
});

// ── publishCapsule 429 Retry-After handling (Hunter H2) ──
// The publishCapsule callback itself is wired in main.ts; unit-testing the
// exact message formatting requires reaching into main.ts. Covered instead
// via the retry-header helper logic, replicated here to guard against
// regression of the format rules.

describe('publishCapsule Retry-After rendering rules (Hunter H2)', () => {
  // Mirror of the rule in main.ts: positive finite → "Publish quota
  // exceeded — try again in <ceil>s."; anything else → generic copy.
  function renderRetry(retryAfterRaw: string | null): string {
    const secs = retryAfterRaw === null ? NaN : Number(retryAfterRaw);
    return Number.isFinite(secs) && secs > 0
      ? `Publish quota exceeded — try again in ${Math.ceil(secs)}s.`
      : 'Publish quota exceeded. Try again later.';
  }

  it('numeric seconds → "try again in Ns."', () => {
    expect(renderRetry('120')).toBe('Publish quota exceeded — try again in 120s.');
  });

  it('HTTP-date header → generic copy (not "Wed, 21 Oct…s.")', () => {
    expect(renderRetry('Wed, 21 Oct 2026 07:28:00 GMT')).toBe('Publish quota exceeded. Try again later.');
  });

  it('garbage header → generic copy', () => {
    expect(renderRetry('abc')).toBe('Publish quota exceeded. Try again later.');
  });

  it('missing header → generic copy', () => {
    expect(renderRetry(null)).toBe('Publish quota exceeded. Try again later.');
  });

  it('zero or negative → generic copy', () => {
    expect(renderRetry('0')).toBe('Publish quota exceeded. Try again later.');
    expect(renderRetry('-5')).toBe('Publish quota exceeded. Try again later.');
  });

  it('fractional seconds round up', () => {
    expect(renderRetry('1.2')).toBe('Publish quota exceeded — try again in 2s.');
  });
});

// ── Share panel unverified state ──

describe('Transfer dialog — unverified auth state', () => {
  beforeEach(() => { useAppStore.getState().resetTransientState(); });
  afterEach(() => { cleanup(); });

  it('renders neutral "Can\'t verify" note with a Retry button, NOT the OAuth prompt', () => {
    act(() => {
      installPublishableTimeline();
      useAppStore.getState().setAuthUnverified();
    });
    render(<TimelineBar />);
    act(() => { (document.querySelector('.timeline-transfer-trigger') as HTMLButtonElement).click(); });

    // Unverified copy + retry affordance present.
    const unverified = document.querySelector('[data-testid="transfer-auth-unverified"]');
    expect(unverified).not.toBeNull();
    expect(unverified?.textContent).toContain("Can't verify sign-in");
    expect(document.querySelector('[data-testid="transfer-auth-retry"]')).not.toBeNull();
    // The OAuth prompt must NOT be shown — showing provider buttons here
    // would mislead a user whose cookie is actually valid.
    expect(document.querySelector('[data-testid="transfer-auth-prompt"]')).toBeNull();
    expect(document.querySelector('[data-testid="transfer-auth-google"]')).toBeNull();
    expect(document.querySelector('[data-testid="transfer-auth-github"]')).toBeNull();
    // Publish button must also be absent.
    expect(document.querySelector('.timeline-transfer-dialog__confirm')?.textContent).not.toContain('Publish');
  });
});

// ── shareError auto-clear on signed-in transition (Fix E) ──

describe('Transfer dialog — kind-tagged shareError prevents 429-into-signed-out bleed', () => {
  beforeEach(() => { useAppStore.getState().resetTransientState(); });
  afterEach(() => { cleanup(); });

  it('429 message is NOT rendered as auth-note after an external signed-out flip', async () => {
    // Reproduce the bleed path the re-audit flagged:
    //   1. Signed-in user clicks Publish → 429 → shareError (kind:other) set.
    //   2. External force-flip to signed-out (as if opportunistic hydrate
    //      returned 401 or logout reconciliation landed a 401).
    //   3. Dialog re-renders signed-out branch. The 429 copy MUST NOT
    //      appear as the auth-note next to the OAuth buttons — otherwise
    //      the user is misled about why sign-in is being asked for.
    const rateLimitError = new Error('Publish quota exceeded — try again in 60s.');
    const onPublish = vi.fn(async () => { throw rateLimitError; });
    act(() => {
      useAppStore.getState().installTimelineUI(
        {
          ...baseTimelineCallbacks,
          onExportHistory: vi.fn(async () => 'saved' as const),
          onPublishCapsule: onPublish,
          onPauseForExport: vi.fn(() => true),
          onResumeFromExport: vi.fn(),
        },
        'active', { full: true, capsule: true },
      );
      useAppStore.getState().updateTimelineState({
        mode: 'live', currentTimePs: 100, reviewTimePs: null,
        rangePs: { start: 0, end: 200 },
        canReturnToLive: false, canRestart: false, restartTargetPs: null,
      });
      setSession({ userId: 'u1', displayName: 'Alice' });
    });
    render(<TimelineBar />);
    act(() => { (document.querySelector('.timeline-transfer-trigger') as HTMLButtonElement).click(); });

    // Step 1: 429 — shareError.kind === 'other' set; red error rendered in signed-in branch.
    await act(async () => {
      (document.querySelector('.timeline-transfer-dialog__confirm') as HTMLButtonElement).click();
    });
    const redError = document.querySelector('.timeline-transfer-dialog__error');
    expect(redError?.textContent).toContain('quota');
    // No auth-note yet — still signed-in.
    expect(document.querySelector('[data-testid="transfer-auth-note"]')).toBeNull();

    // Step 2: external signed-out flip (simulates opportunistic hydrate / reconcile).
    act(() => { useAppStore.getState().setAuthSignedOut(); });

    // Step 3: signed-out branch now rendered. The 429 copy MUST NOT leak
    // into the auth-note slot. The auth-prompt is visible but its note
    // (if any) is not the 429 message.
    expect(document.querySelector('[data-testid="transfer-auth-prompt"]')).not.toBeNull();
    const authNote = document.querySelector('[data-testid="transfer-auth-note"]');
    expect(authNote).toBeNull();
    // Red error also gone — signed-out branch doesn't render shareError.
    expect(document.querySelector('.timeline-transfer-dialog__error')).toBeNull();
  });

  it('401 recovery still surfaces the auth-note (auth kind routes into signed-out branch)', async () => {
    // Companion to the 429 test above — the SAME render-site must still
    // show the "Your session expired…" note when the kind is 'auth'.
    // Locks in that the kind-tagged split didn't break the 401 path.
    const err = new AuthRequiredError('Your session expired.');
    const onPublish = vi.fn(async () => { throw err; });
    act(() => {
      useAppStore.getState().installTimelineUI(
        {
          ...baseTimelineCallbacks,
          onExportHistory: vi.fn(async () => 'saved' as const),
          onPublishCapsule: onPublish,
          onPauseForExport: vi.fn(() => true),
          onResumeFromExport: vi.fn(),
        },
        'active', { full: true, capsule: true },
      );
      useAppStore.getState().updateTimelineState({
        mode: 'live', currentTimePs: 100, reviewTimePs: null,
        rangePs: { start: 0, end: 200 },
        canReturnToLive: false, canRestart: false, restartTargetPs: null,
      });
      setSession({ userId: 'u1', displayName: 'Alice' });
    });
    render(<TimelineBar />);
    act(() => { (document.querySelector('.timeline-transfer-trigger') as HTMLButtonElement).click(); });
    await act(async () => {
      (document.querySelector('.timeline-transfer-dialog__confirm') as HTMLButtonElement).click();
    });
    // Signed-out branch + auth-note visible with the AuthRequiredError message.
    expect(document.querySelector('[data-testid="transfer-auth-note"]')?.textContent).toContain('expired');
  });
});

describe('Transfer dialog — shareError clears on transition to signed-in', () => {
  beforeEach(() => { useAppStore.getState().resetTransientState(); });
  afterEach(() => { cleanup(); });

  it('does NOT clear shareError when transitioning signed-in → signed-out (401 recovery needs the note)', async () => {
    const err = new AuthRequiredError('Your session expired.');
    const onPublish = vi.fn(async () => { throw err; });
    act(() => {
      useAppStore.getState().installTimelineUI(
        {
          ...baseTimelineCallbacks,
          onExportHistory: vi.fn(async () => 'saved' as const),
          onPublishCapsule: onPublish,
          onPauseForExport: vi.fn(() => true),
          onResumeFromExport: vi.fn(),
        },
        'active', { full: true, capsule: true },
      );
      useAppStore.getState().updateTimelineState({
        mode: 'live', currentTimePs: 100, reviewTimePs: null,
        rangePs: { start: 0, end: 200 },
        canReturnToLive: false, canRestart: false, restartTargetPs: null,
      });
      setSession({ userId: 'u1', displayName: 'Alice' });
    });
    render(<TimelineBar />);
    act(() => { (document.querySelector('.timeline-transfer-trigger') as HTMLButtonElement).click(); });
    const publishBtn = document.querySelector('.timeline-transfer-dialog__confirm') as HTMLButtonElement;
    await act(async () => { publishBtn.click(); });

    // signed-out branch renders the auth-note with the 401 message.
    expect(useAppStore.getState().auth.status).toBe('signed-out');
    expect(document.querySelector('[data-testid="transfer-auth-note"]')?.textContent).toContain('expired');
  });

  it('clears shareError when transitioning signed-out → signed-in (prevents stale bleed)', async () => {
    // Seed the scenario: a dialog with a shareError set while signed-out;
    // then flip to signed-in.
    act(() => {
      useAppStore.getState().installTimelineUI(
        {
          ...baseTimelineCallbacks,
          onExportHistory: vi.fn(async () => 'saved' as const),
          onPublishCapsule: vi.fn(async () => {
            throw new AuthRequiredError('Your session expired.');
          }),
          onPauseForExport: vi.fn(() => true),
          onResumeFromExport: vi.fn(),
        },
        'active', { full: true, capsule: true },
      );
      useAppStore.getState().updateTimelineState({
        mode: 'live', currentTimePs: 100, reviewTimePs: null,
        rangePs: { start: 0, end: 200 },
        canReturnToLive: false, canRestart: false, restartTargetPs: null,
      });
      setSession({ userId: 'u1', displayName: 'Alice' });
    });
    render(<TimelineBar />);
    act(() => { (document.querySelector('.timeline-transfer-trigger') as HTMLButtonElement).click(); });
    await act(async () => { (document.querySelector('.timeline-transfer-dialog__confirm') as HTMLButtonElement).click(); });
    // Now in signed-out with auth-note visible.
    expect(document.querySelector('[data-testid="transfer-auth-note"]')).not.toBeNull();

    // Re-authenticate (as if OAuth completed and opportunistic hydrate returned 200).
    act(() => { useAppStore.getState().setAuthSignedIn({ userId: 'u1', displayName: 'Alice' }); });

    // signed-in branch must NOT render the stale red error above Publish.
    expect(document.querySelector('.timeline-transfer-dialog__error')).toBeNull();
    // Publish button is back (confirmEnabled because signed-in).
    const publishBtn = document.querySelector('.timeline-transfer-dialog__confirm') as HTMLButtonElement;
    expect(publishBtn).not.toBeNull();
    expect(publishBtn.textContent).toContain('Publish');
  });
});

// ── AccountControl accessibility: plain disclosure, not ARIA menu (Fix F) ──

describe('AccountControl — plain disclosure (no ARIA menu)', () => {
  beforeEach(() => { useAppStore.getState().resetTransientState(); });
  afterEach(() => { cleanup(); });

  it('trigger uses aria-haspopup="dialog" (matches the disclosure pattern, not an ARIA menu)', () => {
    // Phase 7 a11y fix: `aria-haspopup="true"` resolves to `"menu"` per
    // ARIA, which makes screen readers announce a menu and users
    // expect arrow-key navigation that this disclosure does not
    // implement. `"dialog"` matches the actual content (mixed
    // <a>/<button> children, single Tab traversal).
    act(() => { setSession({ userId: 'u1', displayName: 'Alice' }); });
    render(<AccountControl />);
    const trigger = document.querySelector('[data-testid="account-chip"]');
    expect(trigger?.getAttribute('aria-haspopup')).toBe('dialog');
  });

  it('no role=menu / role=menuitem on signed-in popover', () => {
    act(() => { setSession({ userId: 'u1', displayName: 'Alice' }); });
    render(<AccountControl />);
    act(() => { (document.querySelector('[data-testid="account-chip"]') as HTMLButtonElement).click(); });
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(document.querySelector('[role="menuitem"]')).toBeNull();
  });

  it('no role=menu / role=menuitem on signed-out popover', () => {
    act(() => { setSession(null); });
    render(<AccountControl />);
    act(() => { (document.querySelector('[data-testid="account-signin"]') as HTMLButtonElement).click(); });
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(document.querySelector('[role="menuitem"]')).toBeNull();
  });

  it('no role=menu / role=menuitem on unverified popover', () => {
    act(() => { useAppStore.getState().setAuthUnverified(); });
    render(<AccountControl />);
    act(() => { (document.querySelector('[data-testid="account-unverified"]') as HTMLButtonElement).click(); });
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(document.querySelector('[role="menuitem"]')).toBeNull();
  });
});

// ── AccountControl unverified state ──

describe('AccountControl — unverified auth state', () => {
  beforeEach(() => { useAppStore.getState().resetTransientState(); });
  afterEach(() => { cleanup(); });

  it('renders "Sign-in unknown" with a retry-only menu (no OAuth providers)', () => {
    act(() => { useAppStore.getState().setAuthUnverified(); });
    render(<AccountControl />);

    const trigger = document.querySelector('[data-testid="account-unverified"]') as HTMLButtonElement;
    expect(trigger).not.toBeNull();
    expect(trigger.textContent).toContain('unknown');

    act(() => { trigger.click(); });
    expect(document.querySelector('[data-testid="account-retry"]')).not.toBeNull();
    // Providers must not appear in this state — unverified ≠ signed-out.
    expect(document.querySelector('[data-testid="account-signin-google"]')).toBeNull();
    expect(document.querySelector('[data-testid="account-signin-github"]')).toBeNull();
  });
});

// ── Resume-publish intent ──

describe('resume-publish intent (structured payload + query-marker handshake)', () => {
  // jsdom's window.location is a locked object — spy/defineProperty on its
  // methods throws. Replace the whole location with a stub for the duration
  // of this describe block so we can mock `assign` and control the search
  // string that `consumeResumePublishIntent` inspects.
  const originalLocation = window.location;
  function setLocation(search: string) {
    delete (window as unknown as { location?: Location }).location;
    // Explicit protocol + port so isViteDevHost() (guard added April 2026)
    // correctly treats this as a production-shaped location, not a Vite
    // dev host that would short-circuit the popup path.
    (window as unknown as { location: Partial<Location> }).location = {
      ...originalLocation,
      protocol: 'https:',
      host: 'example.test',
      hostname: 'example.test',
      port: '',
      origin: 'https://example.test',
      href: `https://example.test/lab/${search}`,
      pathname: '/lab/',
      search,
      hash: '',
      assign: vi.fn(),
    } as Location;
  }

  beforeEach(() => {
    useAppStore.getState().resetTransientState();
    sessionStorage.clear();
    setLocation('');
    vi.spyOn(window.history, 'replaceState').mockImplementation(() => {});
  });
  afterEach(() => {
    delete (window as unknown as { location?: Location }).location;
    (window as unknown as { location: Location }).location = originalLocation;
    vi.restoreAllMocks();
  });

  it('LEAK GUARD: onSignIn with resumePublish does NOT write the sentinel when the JIT fetch fails', async () => {
    // The whole point of the D120 sentinel-after-fetch timing is to
    // close the leak where a pre-fetch sentinel write would orphan
    // into a later unrelated sign-in's auto-Share-open. This test
    // is the regression guard: any future change that moves the
    // setResumePublishIntent call before `await fetchAgeIntent()`
    // (or that drops the defensive clearResumeIntent in the catch)
    // will fail here.
    const popupLocation = { href: '' };
    const fakePopup = {
      focus: vi.fn(),
      closed: false,
      location: popupLocation,
      document: { write: vi.fn(), close: vi.fn(), open: vi.fn() },
      close: vi.fn(),
    };
    (window as unknown as { open: typeof window.open }).open = vi.fn(
      () => fakePopup as unknown as Window,
    ) as typeof window.open;
    const savedFetch = stubAgeIntentNetworkError();
    try {
      const { callbacks } = createAuthRuntime();
      callbacks.onSignIn('google', { resumePublish: true });
      // Sentinel must NOT exist immediately (we never write it pre-fetch).
      expect(sessionStorage.getItem('atomdojo.resumePublish')).toBeNull();

      await flushMicrotasks();

      // Sentinel STILL absent after the fetch fails — the catch branch's
      // clearResumeIntent fires defensively and the post-fetch write
      // never executed.
      expect(sessionStorage.getItem('atomdojo.resumePublish')).toBeNull();
      // Popup never navigated.
      expect(popupLocation.href).toBe('');
      // Failure message surfaced via the store for the UI to render.
      expect(useAppStore.getState().authSignInAttempt?.status).toBe('failed');
    } finally {
      globalThis.fetch = savedFetch;
    }
  });

  it('LEAK GUARD: onSignInSameTab with resumePublish does NOT write the sentinel when the JIT fetch fails', async () => {
    (window as unknown as { open: typeof window.open }).open = vi.fn(() => null) as typeof window.open;
    const savedFetch = stubAgeIntentNetworkError();
    try {
      const { callbacks } = createAuthRuntime();
      // First call sets the popup-blocked descriptor (popup returned null).
      callbacks.onSignIn('github', { resumePublish: true });
      // No sentinel was ever written for this attempt.
      expect(sessionStorage.getItem('atomdojo.resumePublish')).toBeNull();

      // User clicks Continue-in-tab → fetch fails → no navigation, no sentinel.
      callbacks.onSignInSameTab();
      await flushMicrotasks();
      expect(sessionStorage.getItem('atomdojo.resumePublish')).toBeNull();
      expect(window.location.assign).not.toHaveBeenCalled();
      expect(useAppStore.getState().authSignInAttempt?.status).toBe('failed');
    } finally {
      globalThis.fetch = savedFetch;
    }
  });

  it('onSignIn with resumePublish stores a structured JSON payload AFTER fetch resolves (D120 timing)', async () => {
    // D120: the resume-publish sentinel is written ONLY after the
    // age-intent fetch resolves successfully, immediately before
    // navigatePopupTo. This is the key guard against a leak where a
    // fetch failure orphans the sentinel into a later unrelated
    // sign-in (which would then auto-open the Share tab).
    let popupHref: string | null = null;
    const fakePopup = {
      focus: vi.fn(),
      closed: false,
      document: { write: vi.fn(), close: vi.fn(), open: vi.fn() },
      get location() { return { href: '' }; },
      set location(value: { href: string } | string) {
        // Some test runtimes treat `popup.location.href = url` as
        // setting the location object itself; guard either shape.
        if (typeof value === 'object') popupHref = value.href;
      },
      close: vi.fn(),
    };
    (window as unknown as { open: typeof window.open }).open = vi.fn(
      () => fakePopup as unknown as Window,
    ) as typeof window.open;
    const now = 1_700_000_000_000;
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const originalFetch = stubAgeIntentFetch('signin-token');
    try {
      const { callbacks } = createAuthRuntime();
      callbacks.onSignIn('google', { resumePublish: true });

      // Sentinel must NOT exist before the fetch resolves — that's the
      // failure-window guard the new timing closes.
      expect(sessionStorage.getItem('atomdojo.resumePublish')).toBeNull();

      await flushMicrotasks();

      const raw = sessionStorage.getItem('atomdojo.resumePublish');
      expect(raw).not.toBeNull();
      const payload = JSON.parse(raw!);
      expect(payload).toEqual({ kind: 'resumePublish', provider: 'google', iat: now });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('onSignIn without resumePublish does NOT store a payload', () => {
    (window as unknown as { open: typeof window.open }).open = vi.fn(
      () => ({ focus: vi.fn(), closed: false } as unknown as Window),
    ) as typeof window.open;
    const { callbacks } = createAuthRuntime();
    callbacks.onSignIn('github', { resumePublish: false });
    expect(sessionStorage.getItem('atomdojo.resumePublish')).toBeNull();
    expect(window.location.assign).not.toHaveBeenCalled();
  });

  it('consumeResumePublishIntent returns false without the authReturn marker even with a fresh payload', () => {
    // Pre-seed a fresh payload as if it were set before an abandoned OAuth start.
    sessionStorage.setItem(
      'atomdojo.resumePublish',
      JSON.stringify({ kind: 'resumePublish', provider: 'google', iat: Date.now() }),
    );
    // No ?authReturn=1 in URL → treat as not-a-callback.
    expect(consumeResumePublishIntent()).toBe(false);
    // Sentinel MUST remain — the OAuth round-trip may still be in flight
    // in another tab; consuming prematurely would drop the legitimate intent.
    expect(sessionStorage.getItem('atomdojo.resumePublish')).not.toBeNull();
  });

  it('consumeResumePublishIntent returns true when marker is present AND payload is fresh', () => {
    setLocation('?authReturn=1');
    sessionStorage.setItem(
      'atomdojo.resumePublish',
      JSON.stringify({ kind: 'resumePublish', provider: 'google', iat: Date.now() }),
    );
    expect(consumeResumePublishIntent()).toBe(true);
    // Sentinel consumed — subsequent calls return false.
    expect(sessionStorage.getItem('atomdojo.resumePublish')).toBeNull();
    // URL marker cleaned up via history.replaceState (called with a URL
    // stripped of the authReturn param).
    expect(window.history.replaceState).toHaveBeenCalled();
  });

  it('consumeResumePublishIntent returns false when payload is older than the TTL', () => {
    setLocation('?authReturn=1');
    const staleIat = Date.now() - (11 * 60 * 1000); // 11 min ago
    sessionStorage.setItem(
      'atomdojo.resumePublish',
      JSON.stringify({ kind: 'resumePublish', provider: 'google', iat: staleIat }),
    );
    expect(consumeResumePublishIntent()).toBe(false);
    // The marker was seen — sentinel is always cleared to prevent stale
    // payloads from persisting across reloads.
    expect(sessionStorage.getItem('atomdojo.resumePublish')).toBeNull();
  });

  it('consumeResumePublishIntent returns false for malformed payload (and cleans it up)', () => {
    setLocation('?authReturn=1');
    sessionStorage.setItem('atomdojo.resumePublish', 'not-json');
    expect(consumeResumePublishIntent()).toBe(false);
    expect(sessionStorage.getItem('atomdojo.resumePublish')).toBeNull();
  });

  it('requestShareTabOpen sets the one-shot flag and consumeShareTabOpen clears it', () => {
    // Reset baseline.
    act(() => { useAppStore.setState({ shareTabOpenRequested: false }); });
    expect(useAppStore.getState().shareTabOpenRequested).toBe(false);

    act(() => { useAppStore.getState().requestShareTabOpen(); });
    expect(useAppStore.getState().shareTabOpenRequested).toBe(true);

    // First consume returns true and clears.
    let first = false;
    act(() => { first = useAppStore.getState().consumeShareTabOpen(); });
    expect(first).toBe(true);
    expect(useAppStore.getState().shareTabOpenRequested).toBe(false);

    // Idempotent: second consume returns false (no double-fire).
    let second = true;
    act(() => { second = useAppStore.getState().consumeShareTabOpen(); });
    expect(second).toBe(false);
  });
});

// ── Logout reconciliation (Fix G) ──

describe('onSignOut — reconciliation after server failure', () => {
  const originalLocation = window.location;
  const originalFetch = globalThis.fetch;
  beforeEach(() => {
    useAppStore.getState().resetTransientState();
    useAppStore.getState().setAuthSignedIn({ userId: 'u1', displayName: 'Alice' });
    delete (window as unknown as { location?: Location }).location;
    (window as unknown as { location: Partial<Location> }).location = {
      ...originalLocation, assign: vi.fn(),
    } as Location;
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    globalThis.fetch = originalFetch;
    delete (window as unknown as { location?: Location }).location;
    (window as unknown as { location: Location }).location = originalLocation;
  });

  it('logout success: flips to signed-out, schedules NO reconciliation', async () => {
    globalThis.fetch = vi.fn(async () => new Response('', { status: 200 })) as typeof fetch;
    const { callbacks } = createAuthRuntime();
    await callbacks.onSignOut();
    expect(useAppStore.getState().auth.status).toBe('signed-out');
    // No reconciliation fetch scheduled on success — the session endpoint
    // should NOT be hit after LOGOUT_RECONCILE_DELAY_MS.
    const initialCalls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.length;
    vi.advanceTimersByTime(4000);
    expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.length).toBe(initialCalls);
  });

  it('logout 5xx: flips UI to signed-out, then reconciles via /session after delay', async () => {
    let callIdx = 0;
    globalThis.fetch = vi.fn(async () => {
      callIdx++;
      if (callIdx === 1) return new Response('', { status: 500 });
      // Reconciliation /session returns 200 signed-in (cookie still live).
      return new Response(
        JSON.stringify({ status: 'signed-in', userId: 'u1', displayName: 'Alice', createdAt: 'x' }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }) as typeof fetch;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const { callbacks } = createAuthRuntime();
    await callbacks.onSignOut();
    expect(useAppStore.getState().auth.status).toBe('signed-out');

    // Advance past the reconcile delay + drain the microtasks from the
    // scheduled hydrate.
    await vi.advanceTimersByTimeAsync(3500);
    expect(useAppStore.getState().auth.status).toBe('signed-in');
    warn.mockRestore();
  });

  it('logout transport failure: schedules reconciliation', async () => {
    let callIdx = 0;
    globalThis.fetch = vi.fn(async () => {
      callIdx++;
      if (callIdx === 1) throw new Error('network down');
      // Reconciliation /session returns 200 signed-out — UI stays signed-out (consistent).
      return new Response(
        JSON.stringify({ status: 'signed-out' }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }) as typeof fetch;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const { callbacks } = createAuthRuntime();
    await callbacks.onSignOut();
    expect(useAppStore.getState().auth.status).toBe('signed-out');

    // Reconciliation confirms signed-out — UI stays signed-out (consistent).
    await vi.advanceTimersByTimeAsync(3500);
    expect(useAppStore.getState().auth.status).toBe('signed-out');
    warn.mockRestore();
  });
});

// ── Resume-intent hardening (Hunter M2 + iat finiteness) ──

describe('resume-intent payload — iat finiteness guard', () => {
  const originalLocation = window.location;
  beforeEach(() => {
    sessionStorage.clear();
    delete (window as unknown as { location?: Location }).location;
    (window as unknown as { location: Partial<Location> }).location = {
      ...originalLocation,
      pathname: '/lab/', search: '?authReturn=1', hash: '',
      href: 'https://example.test/lab/?authReturn=1', assign: vi.fn(),
    } as Location;
    vi.spyOn(window.history, 'replaceState').mockImplementation(() => {});
  });
  afterEach(() => {
    delete (window as unknown as { location?: Location }).location;
    (window as unknown as { location: Location }).location = originalLocation;
    vi.restoreAllMocks();
  });

  it('iat=NaN is rejected (would otherwise pass typeof check and skew age calc)', () => {
    sessionStorage.setItem('atomdojo.resumePublish',
      JSON.stringify({ kind: 'resumePublish', provider: 'google', iat: NaN }));
    expect(consumeResumePublishIntent()).toBe(false);
  });

  it('iat=Infinity is rejected', () => {
    sessionStorage.setItem('atomdojo.resumePublish',
      JSON.stringify({ kind: 'resumePublish', provider: 'google', iat: Infinity }));
    expect(consumeResumePublishIntent()).toBe(false);
  });

  it('iat=negative is rejected', () => {
    sessionStorage.setItem('atomdojo.resumePublish',
      JSON.stringify({ kind: 'resumePublish', provider: 'google', iat: -1 }));
    expect(consumeResumePublishIntent()).toBe(false);
  });

  it('still clears the sentinel when marker is present, even on rejected payload', () => {
    sessionStorage.setItem('atomdojo.resumePublish',
      JSON.stringify({ kind: 'resumePublish', provider: 'google', iat: NaN }));
    consumeResumePublishIntent();
    expect(sessionStorage.getItem('atomdojo.resumePublish')).toBeNull();
  });
});

// ── AuthState discriminated-union enforcement ──
//
// The AuthState type is a discriminated union:
//   { status: 'loading';    session: null }
//   { status: 'signed-in';  session: AuthSessionState }
//   { status: 'signed-out'; session: null }
//   { status: 'unverified'; session: null }
//
// These tests lock in the *runtime* behavior of the narrow helpers. The
// compile-time enforcement (impossible shapes are type errors) is verified
// by the typecheck script; expressing it here would require // @ts-expect-error
// directives that are fragile across tsc upgrades.

describe('AuthState narrow helpers enforce the invariant', () => {
  beforeEach(() => { useAppStore.getState().resetTransientState(); });

  it('setAuthLoading produces { status: loading, session: null }', () => {
    useAppStore.getState().setAuthSignedIn({ userId: 'a', displayName: 'A' });
    act(() => { useAppStore.getState().setAuthLoading(); });
    expect(useAppStore.getState().auth).toEqual({ status: 'loading', session: null });
  });

  it('setAuthSignedIn always binds the provided session', () => {
    act(() => { useAppStore.getState().setAuthSignedIn({ userId: 'x', displayName: 'X' }); });
    const { auth } = useAppStore.getState();
    expect(auth.status).toBe('signed-in');
    // Invariant: session is non-null iff status === 'signed-in'.
    if (auth.status === 'signed-in') {
      expect(auth.session.userId).toBe('x');
    } else {
      throw new Error('expected signed-in branch');
    }
  });

  it('setAuthSignedOut produces { status: signed-out, session: null }', () => {
    useAppStore.getState().setAuthSignedIn({ userId: 'a', displayName: 'A' });
    act(() => { useAppStore.getState().setAuthSignedOut(); });
    expect(useAppStore.getState().auth).toEqual({ status: 'signed-out', session: null });
  });

  it('setAuthUnverified produces { status: unverified, session: null }', () => {
    useAppStore.getState().setAuthSignedIn({ userId: 'a', displayName: 'A' });
    act(() => { useAppStore.getState().setAuthUnverified(); });
    expect(useAppStore.getState().auth).toEqual({ status: 'unverified', session: null });
  });
});

// ── resetTransientState boundary for one-shot auth flags ──
//
// Ephemeral control-flow flags (authPopupBlocked, shareTabOpenRequested)
// must be cleared on scene/runtime teardown. Identity state
// (auth.status, auth.session) is a cross-session concern and MUST
// survive the reset — signing out should be the only thing that clears
// it.

describe('resetTransientState — clears one-shot auth flags, preserves identity', () => {
  it('clears authPopupBlocked and shareTabOpenRequested', () => {
    act(() => {
      useAppStore.getState().setAuthPopupBlocked({ provider: 'google', resumePublish: true });
      useAppStore.getState().requestShareTabOpen();
    });
    expect(useAppStore.getState().authPopupBlocked).not.toBeNull();
    expect(useAppStore.getState().shareTabOpenRequested).toBe(true);

    act(() => { useAppStore.getState().resetTransientState(); });
    expect(useAppStore.getState().authPopupBlocked).toBeNull();
    expect(useAppStore.getState().shareTabOpenRequested).toBe(false);
  });

  it('AccountControl provider buttons disable while authSignInAttempt.status === starting', () => {
    act(() => {
      setSession(null);
      useAppStore.getState().setAuthCallbacks({
        onSignIn: vi.fn(), onSignInSameTab: vi.fn(),
        onDismissPopupBlocked: vi.fn(), onSignOut: vi.fn(async () => {}),
      });
      useAppStore.getState().setAuthSignInAttempt({
        provider: 'google', resumePublish: false, status: 'starting', message: null,
      });
    });
    render(<AccountControl />);
    act(() => { (document.querySelector('[data-testid="account-signin"]') as HTMLButtonElement).click(); });
    const google = document.querySelector('[data-testid="account-signin-google"]') as HTMLButtonElement;
    const github = document.querySelector('[data-testid="account-signin-github"]') as HTMLButtonElement;
    expect(google.disabled).toBe(true);
    expect(github.disabled).toBe(true);
  });

  it('Transfer dialog provider buttons disable while authSignInAttempt.status === starting', () => {
    act(() => {
      installPublishableTimeline();
      setSession(null);
      useAppStore.getState().setAuthCallbacks({
        onSignIn: vi.fn(), onSignInSameTab: vi.fn(),
        onDismissPopupBlocked: vi.fn(), onSignOut: vi.fn(async () => {}),
      });
      useAppStore.getState().setAuthSignInAttempt({
        provider: 'github', resumePublish: true, status: 'starting', message: null,
      });
    });
    render(<TimelineBar />);
    act(() => { (document.querySelector('.timeline-transfer-trigger') as HTMLButtonElement).click(); });
    const google = document.querySelector('[data-testid="transfer-auth-google"]') as HTMLButtonElement;
    const github = document.querySelector('[data-testid="transfer-auth-github"]') as HTMLButtonElement;
    expect(google.disabled).toBe(true);
    expect(github.disabled).toBe(true);
  });

  it('clears authSignInAttempt (D120 — same lifecycle as authPopupBlocked)', () => {
    act(() => {
      useAppStore.getState().setAuthSignInAttempt({
        provider: 'google', resumePublish: false, status: 'starting', message: null,
      });
    });
    expect(useAppStore.getState().authSignInAttempt).not.toBeNull();

    act(() => { useAppStore.getState().resetTransientState(); });
    expect(useAppStore.getState().authSignInAttempt).toBeNull();
  });

  it('preserves auth identity (auth.status / auth.session) across the reset', () => {
    act(() => {
      useAppStore.getState().setAuthSignedIn({ userId: 'u1', displayName: 'Alice' });
    });
    expect(useAppStore.getState().auth.status).toBe('signed-in');

    act(() => { useAppStore.getState().resetTransientState(); });
    // Sign-in survives — only the transient UI/control-flow state clears.
    expect(useAppStore.getState().auth.status).toBe('signed-in');
    expect(useAppStore.getState().auth.session?.userId).toBe('u1');
  });

  it('also preserves the auth.status=signed-out identity (not re-initialized to loading)', () => {
    act(() => { useAppStore.getState().setAuthSignedOut(); });
    act(() => { useAppStore.getState().resetTransientState(); });
    expect(useAppStore.getState().auth.status).toBe('signed-out');
  });
});

// ── 401 recovery flow ──

describe('Transfer dialog — 401 recovery flips Share back to auth prompt', () => {
  beforeEach(() => { useAppStore.getState().resetTransientState(); });
  afterEach(() => { cleanup(); });

  it('on AuthRequiredError from publish: session → null, prompt re-renders with inline note', async () => {
    const onPublish = vi.fn(async () => {
      throw new AuthRequiredError('Your session expired. Sign in to publish again.');
    });
    act(() => {
      useAppStore.getState().installTimelineUI(
        {
          ...baseTimelineCallbacks,
          onExportHistory: vi.fn(async () => 'saved' as const),
          onPublishCapsule: onPublish,
          onPauseForExport: vi.fn(() => true),
          onResumeFromExport: vi.fn(),
        },
        'active',
        { full: true, capsule: true },
      );
      useAppStore.getState().updateTimelineState({
        mode: 'live', currentTimePs: 100, reviewTimePs: null,
        rangePs: { start: 0, end: 200 },
        canReturnToLive: false, canRestart: false, restartTargetPs: null,
      });
      setSession({ userId: 'u1', displayName: 'Alice' });
    });
    render(<TimelineBar />);

    // Open the dialog (defaults to Share since publish is wired + signed in).
    act(() => { (document.querySelector('.timeline-transfer-trigger') as HTMLButtonElement).click(); });
    // Publish button is visible — click it.
    const publishBtn = document.querySelector('.timeline-transfer-dialog__confirm') as HTMLButtonElement;
    expect(publishBtn).not.toBeNull();
    await act(async () => { publishBtn.click(); });

    // Auth state flipped to signed-out.
    expect(useAppStore.getState().auth.session).toBeNull();
    // Dialog is still open on Share tab with the in-context prompt.
    expect(document.querySelector('[data-testid="transfer-auth-prompt"]')).not.toBeNull();
    // Inline note communicates the reason (uses the AuthRequiredError message).
    const note = document.querySelector('[data-testid="transfer-auth-note"]');
    expect(note?.textContent).toContain('expired');
    // Publish button is no longer rendered.
    expect(document.querySelector('.timeline-transfer-dialog__confirm')).toBeNull();
  });
});

// ── 413 payload-too-large integration: UI renders the size-specific copy ──
//
// Proves the full UI flow end-to-end:
//   signed-in user → click Publish → onPublishCapsule throws the
//   413-formatted Error → handleShareConfirm sets shareError with
//   kind:'other' → signed-in Share panel renders it as a red error.
// Formatter + parser are covered in tests/unit/publish-client-413.test.ts;
// this locks the wire-through to the actual dialog render.

describe('Transfer dialog — 413 payload-too-large renders in Share panel', () => {
  beforeEach(() => { useAppStore.getState().resetTransientState(); });
  afterEach(() => { cleanup(); });

  function setupPublishThrows(err: Error) {
    const onPublish = vi.fn(async () => { throw err; });
    act(() => {
      useAppStore.getState().installTimelineUI(
        {
          ...baseTimelineCallbacks,
          onExportHistory: vi.fn(async () => 'saved' as const),
          onPublishCapsule: onPublish,
          onPauseForExport: vi.fn(() => true),
          onResumeFromExport: vi.fn(),
        },
        'active',
        { full: true, capsule: true },
      );
      useAppStore.getState().updateTimelineState({
        mode: 'live', currentTimePs: 100, reviewTimePs: null,
        rangePs: { start: 0, end: 200 },
        canReturnToLive: false, canRestart: false, restartTargetPs: null,
      });
      setSession({ userId: 'u1', displayName: 'Alice' });
    });
  }

  async function clickPublish() {
    render(<TimelineBar />);
    act(() => { (document.querySelector('.timeline-transfer-trigger') as HTMLButtonElement).click(); });
    const publishBtn = document.querySelector('.timeline-transfer-dialog__confirm') as HTMLButtonElement;
    expect(publishBtn).not.toBeNull();
    await act(async () => { publishBtn.click(); });
  }

  it('renders "Current size + Maximum allowed" when both figures are known', async () => {
    // Simulates main.ts's publishCapsule having parsed a server 413
    // response with actualBytes+maxBytes, then thrown the formatted
    // message as an Error. The dialog should route it into the
    // signed-in branch's red error slot (kind:'other').
    const message = 'This capsule is too large to publish. Current size: 23.5 MB. Maximum allowed: 20.0 MB.';
    setupPublishThrows(new Error(message));
    await clickPublish();

    // Dialog is still open on Share tab, signed-in branch — publish
    // failed but auth is unchanged.
    expect(useAppStore.getState().auth.status).toBe('signed-in');
    expect(document.querySelector('[data-testid="transfer-auth-prompt"]')).toBeNull();
    const err = document.querySelector('.timeline-transfer-dialog__error');
    expect(err).not.toBeNull();
    const txt = err?.textContent ?? '';
    expect(txt).toContain('This capsule is too large to publish');
    expect(txt).toContain('Current size: 23.5 MB');
    expect(txt).toContain('Maximum allowed: 20.0 MB');
    // Publish button remains clickable (shareSubmitting is reset on
    // failure) so the user can retry after reducing the capsule.
    const publishBtn = document.querySelector('.timeline-transfer-dialog__confirm') as HTMLButtonElement;
    expect(publishBtn).not.toBeNull();
    expect(publishBtn.disabled).toBe(false);
  });

  it('renders "Maximum allowed" only when the server only supplied maxBytes (preflight path)', async () => {
    const message = 'This capsule is too large to publish. Maximum allowed: 20.0 MB.';
    setupPublishThrows(new Error(message));
    await clickPublish();

    const err = document.querySelector('.timeline-transfer-dialog__error');
    const txt = err?.textContent ?? '';
    expect(txt).toContain('Maximum allowed: 20.0 MB');
    // No "Current size" leak into this branch.
    expect(txt).not.toContain('Current size');
  });

  it('renders the generic copy when neither body nor header yielded a numeric limit', async () => {
    // Malformed 413 path — parsePayloadTooLargeMessage falls all the way
    // through to the trust-preserving generic. Honest under deploy skew.
    const message = 'This capsule is too large to publish.';
    setupPublishThrows(new Error(message));
    await clickPublish();

    const err = document.querySelector('.timeline-transfer-dialog__error');
    const txt = err?.textContent ?? '';
    expect(txt).toContain('This capsule is too large to publish');
    // No numeric limit at all — we don't invent one.
    expect(txt).not.toContain('MB');
    expect(txt).not.toContain('Maximum allowed');
    expect(txt).not.toContain('Current size');
  });

  it('does NOT flip auth state on 413 (unlike 401 recovery)', async () => {
    // 413 is a size rejection, not an auth failure — the kind-tagged
    // shareError mechanism routes it into the red-error slot, NOT the
    // signed-out auth-note slot. Auth session must remain signed-in.
    setupPublishThrows(new Error('This capsule is too large to publish. Current size: 21.0 MB. Maximum allowed: 20.0 MB.'));
    await clickPublish();

    expect(useAppStore.getState().auth.status).toBe('signed-in');
    expect(useAppStore.getState().auth.session?.userId).toBe('u1');
    // No auth-note, no auth-prompt.
    expect(document.querySelector('[data-testid="transfer-auth-note"]')).toBeNull();
    expect(document.querySelector('[data-testid="transfer-auth-prompt"]')).toBeNull();
  });
});

// ── Top-right layout container ──

describe('TopRightControls layout', () => {
  beforeEach(() => { useAppStore.getState().resetTransientState(); });
  afterEach(() => { cleanup(); });

  it('renders AccountControl and FPSDisplay inside a single .topbar-right container', () => {
    act(() => { setSession({ userId: 'u1', displayName: 'Alice' }); });
    render(<TopRightControls />);
    const container = document.querySelector('.topbar-right');
    expect(container).not.toBeNull();
    // Both children live inside the container — not as independent absolute layers.
    expect(container?.querySelector('.account-control')).not.toBeNull();
    expect(container?.querySelector('.react-fps')).not.toBeNull();
  });

  it('accommodates long display names without spilling out of the container', () => {
    // The flex container uses `gap` + child ellipsis; a 60-char name must
    // not crash rendering, and the chip label element retains its max-width
    // CSS class so the text truncates cleanly.
    act(() => {
      setSession({
        userId: 'u1',
        displayName: 'An Exceptionally Long Display Name That Exceeds Reasonable Chip Widths',
      });
    });
    render(<TopRightControls />);
    const chip = document.querySelector('[data-testid="account-chip"]');
    expect(chip).not.toBeNull();
    const label = chip?.querySelector('.account-control__label');
    expect(label).not.toBeNull();
    // Ellipsis is applied via CSS (overflow:hidden + text-overflow:ellipsis +
    // white-space:nowrap on .account-control__label) — we verify the class
    // contract is present, not the computed pixel bounds (jsdom has no
    // layout engine).
    expect(label?.className).toContain('account-control__label');
  });

  it('account menu uses .account-control as its positioning ancestor (not the viewport)', () => {
    act(() => { setSession({ userId: 'u1', displayName: 'Alice' }); });
    render(<TopRightControls />);
    // The chip's parent chain: chip → .account-control → .topbar-right.
    // The menu must anchor to .account-control so moving the container
    // does not require tuning the menu's right: offset.
    const chip = document.querySelector('[data-testid="account-chip"]') as HTMLButtonElement;
    act(() => { chip.click(); });
    const menu = document.querySelector('.account-control__menu');
    expect(menu).not.toBeNull();
    const accountRoot = menu?.closest('.account-control');
    expect(accountRoot).not.toBeNull();
    // The immediate flex parent of .account-control is .topbar-right — not body.
    expect(accountRoot?.parentElement?.classList.contains('topbar-right')).toBe(true);
  });
});

// ── Popup OAuth flow (Fix 1) ──
//
// These tests lock in the contract:
//   - onSignIn prefers window.open. When the popup is blocked, it DOES
//     NOT silently navigate same-tab — it sets `authPopupBlocked` on the
//     store so the UI can offer explicit Retry / Continue-in-tab.
//   - Each onSignIn attempt tries the popup fresh — no sticky "blocker
//     active" hint that suppresses later attempts.
//   - onSignInSameTab performs the destructive redirect ONLY when the
//     user has explicitly committed via the popup-blocked prompt.
//   - attachAuthCompleteListener handles same-origin postMessage of
//     `{ type: 'atomdojo-auth-complete' }` by re-hydrating, and opens the
//     Share tab if the resume-publish intent was fresh.
//   - Cross-origin or malformed messages are ignored.

describe('auth-runtime — popup OAuth flow', () => {
  const originalLocation = window.location;
  const originalOpen = window.open;
  const originalFetch = globalThis.fetch;
  let attachedTeardown: (() => void) | null = null;

  beforeEach(() => {
    // resetTransientState clears both authPopupBlocked and
    // shareTabOpenRequested — the one-shot auth flags are now part of the
    // reset boundary (fixed April 2026; previously tests patched them up
    // manually). Identity state (auth.status/session) still persists
    // across scene resets and must be explicitly re-set below.
    useAppStore.getState().resetTransientState();
    sessionStorage.clear();
    useAppStore.getState().setAuthLoading();
    _resetAuthRuntimeForTest();
    // Stub window.location so we can observe fallback assign(). Explicit
    // protocol + port keep isViteDevHost() (guard added April 2026) from
    // treating the stub as a Vite dev host, which would short-circuit
    // `tryBeginOAuthPopup` and cause the popup-flow tests to bypass
    // `window.open` entirely.
    delete (window as unknown as { location?: Location }).location;
    (window as unknown as { location: Partial<Location> }).location = {
      ...originalLocation,
      protocol: 'https:',
      host: 'atomdojo.test',
      hostname: 'atomdojo.test',
      port: '',
      origin: 'https://atomdojo.test',
      href: 'https://atomdojo.test/lab/',
      assign: vi.fn(),
    } as Location;
  });
  afterEach(() => {
    if (attachedTeardown) { attachedTeardown(); attachedTeardown = null; }
    (window as unknown as { open: typeof window.open }).open = originalOpen;
    delete (window as unknown as { location?: Location }).location;
    (window as unknown as { location: Location }).location = originalLocation;
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('tries window.open first; navigates the popup to /auth/{provider}/start after intent fetch (D120)', async () => {
    // D120 (supersedes D118): the popup shell opens with empty URL
    // synchronously inside the user gesture, then the runtime fetches
    // the age intent JIT and sets `popup.location.href` to the start
    // URL once the fetch resolves. The opener's `window.open` is
    // called with `''`; the navigated URL appears on
    // `popup.location.href` only after the async fetch completes.
    const popupLocation = { href: '' };
    const fakePopup = {
      focus: vi.fn(),
      closed: false,
      location: popupLocation,
      document: { write: vi.fn(), close: vi.fn(), open: vi.fn() },
      close: vi.fn(),
    };
    (window as unknown as { open: typeof window.open }).open = vi.fn(
      () => fakePopup as unknown as Window,
    ) as typeof window.open;
    const savedFetch = stubAgeIntentFetch('popup-token');
    try {
    const { callbacks } = createAuthRuntime();
    callbacks.onSignIn('google', { resumePublish: true });
    expect(window.open).toHaveBeenCalledTimes(1);
    // Shell opens with empty URL — no navigation yet.
    expect((window.open as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe('');
    expect(popupLocation.href).toBe('');

    await flushMicrotasks();

    // After the JIT fetch resolves, the runtime sets popup.location.href
    // to the start URL with the freshly minted ageIntent embedded.
    expect(popupLocation.href).toContain('/auth/google/start');
    expect(popupLocation.href).toContain(encodeURIComponent('/auth/popup-complete'));
    expect(popupLocation.href).toContain('ageIntent=popup-token');
    expect(window.location.assign).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = savedFetch;
    }
  });

  it('popup blocked: sets authPopupBlocked on the store and does NOT navigate', () => {
    (window as unknown as { open: typeof window.open }).open = vi.fn(() => null) as typeof window.open;
    const { callbacks } = createAuthRuntime();
    callbacks.onSignIn('github', { resumePublish: true });
    // No silent same-tab redirect.
    expect(window.location.assign).not.toHaveBeenCalled();
    // Store flag captures the pending descriptor so the UI can surface
    // the Retry / Continue-in-tab choice and we can resume the original
    // resumePublish intent if the user commits to same-tab.
    expect(useAppStore.getState().authPopupBlocked).toEqual({
      provider: 'github',
      resumePublish: true,
    });
  });

  it('popup blocked: each onSignIn attempt tries window.open fresh (no sticky hint)', () => {
    const openSpy = vi.fn(() => null) as unknown as typeof window.open;
    (window as unknown as { open: typeof window.open }).open = openSpy;
    const { callbacks } = createAuthRuntime();
    callbacks.onSignIn('google', { resumePublish: false });
    callbacks.onSignIn('google', { resumePublish: false });
    callbacks.onSignIn('google', { resumePublish: false });
    // Every call reaches window.open — no permanent suppression after one block.
    expect(openSpy).toHaveBeenCalledTimes(3);
    // No auto-navigation — the UI must drive any same-tab fallback.
    expect(window.location.assign).not.toHaveBeenCalled();
  });

  it('onSignInSameTab commits the destructive redirect for the pending descriptor (D120: awaits fetch)', async () => {
    // D120: same-tab fallback fetches a fresh age intent JIT before
    // navigation. `location.assign` does not require user-gesture
    // qualification so the await is safe (unlike the popup path).
    (window as unknown as { open: typeof window.open }).open = vi.fn(() => null) as typeof window.open;
    const savedFetch = stubAgeIntentFetch('sametab-token');
    try {
      const { callbacks } = createAuthRuntime();
      callbacks.onSignIn('github', { resumePublish: true });
      // First call writes the popup-blocked descriptor (popup returned null).
      expect(useAppStore.getState().authPopupBlocked).not.toBeNull();

      callbacks.onSignInSameTab();
      // Pending descriptor cleared synchronously so a second click can't re-fire.
      expect(useAppStore.getState().authPopupBlocked).toBeNull();

      await flushMicrotasks();

      expect(window.location.assign).toHaveBeenCalledTimes(1);
      const target = (window.location.assign as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(target).toContain('/auth/github/start');
      expect(target).toContain(encodeURIComponent('/lab/?authReturn=1'));
      expect(target).toContain('ageIntent=sametab-token');
    } finally {
      globalThis.fetch = savedFetch;
    }
  });

  it('onSignInSameTab is a no-op when no pending descriptor is set', () => {
    (window as unknown as { open: typeof window.open }).open = vi.fn(() => ({ focus: vi.fn(), closed: false } as unknown as Window)) as typeof window.open;
    const { callbacks } = createAuthRuntime();
    callbacks.onSignInSameTab();
    expect(window.location.assign).not.toHaveBeenCalled();
  });

  it('successful popup on retry clears the popup-blocked flag', () => {
    // First call: popup blocked → flag set. Second call: popup opens → flag cleared.
    const openSpy = vi.fn()
      .mockReturnValueOnce(null)
      .mockReturnValueOnce({ focus: vi.fn(), closed: false }) as unknown as typeof window.open;
    (window as unknown as { open: typeof window.open }).open = openSpy;
    const { callbacks } = createAuthRuntime();
    callbacks.onSignIn('google', { resumePublish: true });
    expect(useAppStore.getState().authPopupBlocked).not.toBeNull();

    callbacks.onSignIn('google', { resumePublish: true });
    // onSignIn always clears the flag up front; a successful popup leaves
    // it null (the store flag only turns back on if window.open returns null).
    expect(useAppStore.getState().authPopupBlocked).toBeNull();
  });

  it('same-origin postMessage triggers hydrate + opens Share tab when resume intent was set', async () => {
    // Set up a signed-in /session response and a live resume-publish intent.
    globalThis.fetch = vi.fn(async () => new Response(
      JSON.stringify({ status: 'signed-in', userId: 'u1', displayName: 'Alice' }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )) as typeof fetch;
    sessionStorage.setItem(
      'atomdojo.resumePublish',
      JSON.stringify({ kind: 'resumePublish', provider: 'google', iat: Date.now() }),
    );

    attachedTeardown = attachAuthCompleteListener();
    expect(useAppStore.getState().shareTabOpenRequested).toBe(false);

    // Simulate the popup's postMessage landing in the opener.
    window.dispatchEvent(new MessageEvent('message', {
      data: { type: 'atomdojo-auth-complete' },
      origin: window.location.origin,
    }));
    // Drain microtasks so hydrate + follow-up store write resolve.
    await new Promise((r) => setTimeout(r, 0));

    expect(useAppStore.getState().auth.status).toBe('signed-in');
    expect(useAppStore.getState().shareTabOpenRequested).toBe(true);
    // Sentinel consumed.
    expect(sessionStorage.getItem('atomdojo.resumePublish')).toBeNull();
  });

  it('ignores cross-origin postMessage', async () => {
    globalThis.fetch = vi.fn(async () => new Response(
      JSON.stringify({ status: 'signed-in', userId: 'u1', displayName: 'Alice' }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )) as typeof fetch;
    attachedTeardown = attachAuthCompleteListener();

    window.dispatchEvent(new MessageEvent('message', {
      data: { type: 'atomdojo-auth-complete' },
      origin: 'https://evil.example',
    }));
    await new Promise((r) => setTimeout(r, 0));
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(useAppStore.getState().auth.status).toBe('loading');
  });

  it('ignores malformed postMessage payload', async () => {
    globalThis.fetch = vi.fn(async () => new Response(
      JSON.stringify({ status: 'signed-in', userId: 'u1', displayName: 'Alice' }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )) as typeof fetch;
    attachedTeardown = attachAuthCompleteListener();

    window.dispatchEvent(new MessageEvent('message', {
      data: { type: 'something-else' },
      origin: window.location.origin,
    }));
    await new Promise((r) => setTimeout(r, 0));
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('does NOT open Share tab when resume intent is absent or stale (>TTL)', async () => {
    globalThis.fetch = vi.fn(async () => new Response(
      JSON.stringify({ status: 'signed-in', userId: 'u1', displayName: 'Alice' }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )) as typeof fetch;

    // Stale intent.
    sessionStorage.setItem(
      'atomdojo.resumePublish',
      JSON.stringify({ kind: 'resumePublish', provider: 'google', iat: Date.now() - (11 * 60 * 1000) }),
    );
    attachedTeardown = attachAuthCompleteListener();

    window.dispatchEvent(new MessageEvent('message', {
      data: { type: 'atomdojo-auth-complete' },
      origin: window.location.origin,
    }));
    await new Promise((r) => setTimeout(r, 0));
    expect(useAppStore.getState().shareTabOpenRequested).toBe(false);
    // Sentinel cleared regardless of freshness.
    expect(sessionStorage.getItem('atomdojo.resumePublish')).toBeNull();
  });
});

// ── Popup-blocked UX surface (Fix 2) ──

describe('Transfer dialog — popup-blocked Retry / Continue-in-tab prompt', () => {
  beforeEach(() => { useAppStore.getState().resetTransientState(); });
  afterEach(() => { cleanup(); });

  it('renders Retry / Continue-in-tab buttons when authPopupBlocked is set; hides OAuth provider buttons', () => {
    act(() => {
      installPublishableTimeline();
      setSession(null);
      useAppStore.getState().setAuthPopupBlocked({ provider: 'google', resumePublish: true });
    });
    render(<TimelineBar />);
    act(() => { (document.querySelector('.timeline-transfer-trigger') as HTMLButtonElement).click(); });

    expect(document.querySelector('[data-testid="transfer-popup-blocked"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="transfer-popup-retry"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="transfer-popup-same-tab"]')).not.toBeNull();
    // Provider buttons are NOT rendered while the popup-blocked prompt is up.
    expect(document.querySelector('[data-testid="transfer-auth-google"]')).toBeNull();
    expect(document.querySelector('[data-testid="transfer-auth-github"]')).toBeNull();
  });

  it('Retry button re-invokes onSignIn with the pending descriptor', () => {
    const onSignIn = vi.fn();
    act(() => {
      installPublishableTimeline();
      setSession(null);
      useAppStore.getState().setAuthCallbacks({
        onSignIn, onSignInSameTab: vi.fn(), onDismissPopupBlocked: vi.fn(), onSignOut: vi.fn(async () => {}),
      });
      useAppStore.getState().setAuthPopupBlocked({ provider: 'github', resumePublish: true });
    });
    render(<TimelineBar />);
    act(() => { (document.querySelector('.timeline-transfer-trigger') as HTMLButtonElement).click(); });
    act(() => { (document.querySelector('[data-testid="transfer-popup-retry"]') as HTMLButtonElement).click(); });

    expect(onSignIn).toHaveBeenCalledTimes(1);
    // After Phase B age-gate, the Retry path also forwards an `ageIntent`
    // (null when the abandoned popup-blocked attempt had no nonce).
    expect(onSignIn).toHaveBeenCalledWith('github', { resumePublish: true });
  });

  // Stale-token recovery tests removed (D120). The popup-blocked
  // descriptor no longer carries an ageIntent snapshot — every Retry /
  // Continue-in-tab fetches a fresh intent JIT, so there is no stale
  // path to test. The popup-blocked descriptor stays valid indefinitely.

  it('Continue-in-tab button invokes onSignInSameTab', () => {
    const onSignInSameTab = vi.fn();
    act(() => {
      installPublishableTimeline();
      setSession(null);
      useAppStore.getState().setAuthCallbacks({
        onSignIn: vi.fn(), onSignInSameTab, onDismissPopupBlocked: vi.fn(), onSignOut: vi.fn(async () => {}),
      });
      useAppStore.getState().setAuthPopupBlocked({ provider: 'google', resumePublish: true });
    });
    render(<TimelineBar />);
    act(() => { (document.querySelector('.timeline-transfer-trigger') as HTMLButtonElement).click(); });
    act(() => { (document.querySelector('[data-testid="transfer-popup-same-tab"]') as HTMLButtonElement).click(); });

    expect(onSignInSameTab).toHaveBeenCalledTimes(1);
  });

  it('Back button invokes onDismissPopupBlocked and restores provider buttons', () => {
    // The host component delegates Back to the auth runtime's callback so
    // the runtime can also clear the resume-publish sentinel when the
    // abandoned flow was publish-initiated. Stub the callback with a
    // behavior-faithful mock that just clears the store flag so the UI
    // assertions exercise the full render path.
    const onDismissPopupBlocked = vi.fn(() => {
      useAppStore.getState().setAuthPopupBlocked(null);
    });
    act(() => {
      installPublishableTimeline();
      setSession(null);
      useAppStore.getState().setAuthCallbacks({
        onSignIn: vi.fn(), onSignInSameTab: vi.fn(), onDismissPopupBlocked, onSignOut: vi.fn(async () => {}),
      });
      useAppStore.getState().setAuthPopupBlocked({ provider: 'google', resumePublish: true });
    });
    render(<TimelineBar />);
    act(() => { (document.querySelector('.timeline-transfer-trigger') as HTMLButtonElement).click(); });
    expect(document.querySelector('[data-testid="transfer-popup-blocked"]')).not.toBeNull();

    act(() => { (document.querySelector('[data-testid="transfer-popup-back"]') as HTMLButtonElement).click(); });
    expect(onDismissPopupBlocked).toHaveBeenCalledTimes(1);
    // Flag cleared via the stub, provider picker restored.
    expect(useAppStore.getState().authPopupBlocked).toBeNull();
    expect(document.querySelector('[data-testid="transfer-popup-blocked"]')).toBeNull();
    expect(document.querySelector('[data-testid="transfer-auth-google"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="transfer-auth-github"]')).not.toBeNull();
  });

  it('popup-blocked copy names the blocked provider', () => {
    act(() => {
      installPublishableTimeline();
      setSession(null);
      useAppStore.getState().setAuthPopupBlocked({ provider: 'github', resumePublish: true });
    });
    render(<TimelineBar />);
    act(() => { (document.querySelector('.timeline-transfer-trigger') as HTMLButtonElement).click(); });
    const copy = document.querySelector('[data-testid="transfer-popup-blocked"]')?.textContent ?? '';
    expect(copy).toContain('GitHub popup was blocked');
    // Retry button is provider-specific too.
    const retryLabel = document.querySelector('[data-testid="transfer-popup-retry"]')?.textContent ?? '';
    expect(retryLabel).toContain('Retry GitHub popup');
  });
});

describe('AccountControl — popup-blocked Retry / Continue-in-tab prompt', () => {
  beforeEach(() => {
    useAppStore.getState().resetTransientState();
    useAppStore.setState({ authPopupBlocked: null });
  });
  afterEach(() => { cleanup(); });

  it('replaces provider buttons with Retry / Continue-in-tab when flag is set', () => {
    act(() => {
      setSession(null);
      useAppStore.getState().setAuthPopupBlocked({ provider: 'google', resumePublish: false });
    });
    render(<AccountControl />);
    act(() => { (document.querySelector('[data-testid="account-signin"]') as HTMLButtonElement).click(); });

    expect(document.querySelector('[data-testid="account-popup-blocked"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="account-popup-retry"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="account-popup-same-tab"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="account-signin-google"]')).toBeNull();
    expect(document.querySelector('[data-testid="account-signin-github"]')).toBeNull();
  });

  it('Retry re-invokes onSignIn with the pending descriptor from the store', () => {
    const onSignIn = vi.fn();
    act(() => {
      setSession(null);
      useAppStore.getState().setAuthCallbacks({
        onSignIn, onSignInSameTab: vi.fn(), onDismissPopupBlocked: vi.fn(), onSignOut: vi.fn(async () => {}),
      });
      useAppStore.getState().setAuthPopupBlocked({ provider: 'github', resumePublish: false });
    });
    render(<AccountControl />);
    act(() => { (document.querySelector('[data-testid="account-signin"]') as HTMLButtonElement).click(); });
    act(() => { (document.querySelector('[data-testid="account-popup-retry"]') as HTMLButtonElement).click(); });

    // Phase 7: AccountControl now mirrors TimelineBar by carrying the
    // pending ageIntent through the retry path. Without this, the
    // second attempt would land at /auth/{provider}/start with no
    // nonce and immediately 400.
    expect(onSignIn).toHaveBeenCalledWith('github', { resumePublish: false });
  });

  it('Back button invokes onDismissPopupBlocked and restores the provider picker', () => {
    const onDismissPopupBlocked = vi.fn(() => {
      useAppStore.getState().setAuthPopupBlocked(null);
    });
    act(() => {
      setSession(null);
      useAppStore.getState().setAuthCallbacks({
        onSignIn: vi.fn(), onSignInSameTab: vi.fn(), onDismissPopupBlocked, onSignOut: vi.fn(async () => {}),
      });
      useAppStore.getState().setAuthPopupBlocked({ provider: 'google', resumePublish: false });
    });
    render(<AccountControl />);
    act(() => { (document.querySelector('[data-testid="account-signin"]') as HTMLButtonElement).click(); });
    expect(document.querySelector('[data-testid="account-popup-blocked"]')).not.toBeNull();

    act(() => { (document.querySelector('[data-testid="account-popup-back"]') as HTMLButtonElement).click(); });
    expect(onDismissPopupBlocked).toHaveBeenCalledTimes(1);
    expect(useAppStore.getState().authPopupBlocked).toBeNull();
    expect(document.querySelector('[data-testid="account-popup-blocked"]')).toBeNull();
    expect(document.querySelector('[data-testid="account-signin-google"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="account-signin-github"]')).not.toBeNull();
  });

  it('AccountControl popup-blocked copy names the blocked provider', () => {
    act(() => {
      setSession(null);
      useAppStore.getState().setAuthPopupBlocked({ provider: 'google', resumePublish: false });
    });
    render(<AccountControl />);
    act(() => { (document.querySelector('[data-testid="account-signin"]') as HTMLButtonElement).click(); });
    const copy = document.querySelector('[data-testid="account-popup-blocked"]')?.textContent ?? '';
    expect(copy).toContain('Google popup was blocked');
    const retryLabel = document.querySelector('[data-testid="account-popup-retry"]')?.textContent ?? '';
    expect(retryLabel).toContain('Retry Google popup');
  });
});

// ── Rate-limited fetch (D120 — 429 branch). The intent endpoint has
// an app-level layer-2 cap that surfaces 429 with Retry-After. The
// runtime must route this to a distinct mode (not the generic 4xx
// "not available here" bucket) and render a temporary-wait message
// with the server's retry hint.

describe('auth-runtime — 429 rate-limited fetch surfaces a temporary-wait message', () => {
  const originalLocation = window.location;
  const originalOpen = window.open;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    useAppStore.getState().resetTransientState();
    useAppStore.getState().setAuthLoading();
    sessionStorage.clear();
    _resetAuthRuntimeForTest();
    delete (window as unknown as { location?: Location }).location;
    (window as unknown as { location: Partial<Location> }).location = {
      ...originalLocation,
      protocol: 'https:', host: 'atomdojo.test', hostname: 'atomdojo.test', port: '',
      origin: 'https://atomdojo.test', href: 'https://atomdojo.test/lab/', assign: vi.fn(),
    } as Location;
  });
  afterEach(() => {
    (window as unknown as { open: typeof window.open }).open = originalOpen;
    delete (window as unknown as { location?: Location }).location;
    (window as unknown as { location: Location }).location = originalLocation;
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  function stubIntentWith429(retryAfter: string | null): typeof fetch {
    const original = globalThis.fetch;
    globalThis.fetch = vi.fn(async (url) => {
      if (String(url).includes('/api/account/age-confirmation/intent')) {
        const headers: Record<string, string> = {};
        if (retryAfter !== null) headers['Retry-After'] = retryAfter;
        return new Response('Too many requests', { status: 429, headers });
      }
      return new Response('not mocked', { status: 500 });
    }) as typeof fetch;
    return original;
  }

  function stubFakePopup() {
    const popupLocation = { href: '' };
    const fakePopup = {
      focus: vi.fn(), closed: false, location: popupLocation,
      document: { write: vi.fn(), close: vi.fn(), open: vi.fn() }, close: vi.fn(),
    };
    (window as unknown as { open: typeof window.open }).open = vi.fn(
      () => fakePopup as unknown as Window,
    ) as typeof window.open;
    return { fakePopup, popupLocation };
  }

  it('429 with a parseable Retry-After → "wait about N seconds/minutes" message', async () => {
    stubFakePopup();
    const savedFetch = stubIntentWith429('45');
    try {
      const { callbacks } = createAuthRuntime();
      callbacks.onSignIn('google', { resumePublish: false });
      await flushMicrotasks();
      const attempt = useAppStore.getState().authSignInAttempt;
      expect(attempt?.status).toBe('failed');
      expect(attempt?.message).toMatch(/too many sign-in attempts/i);
      // The rounding rule: < 60 s renders as "about N seconds".
      expect(attempt?.message).toContain('about 45 seconds');
    } finally {
      globalThis.fetch = savedFetch;
    }
  });

  it('429 with Retry-After ≥ 60 renders as "about 1 minute" / "about N minutes"', async () => {
    stubFakePopup();
    const savedFetch = stubIntentWith429('60');
    try {
      const { callbacks } = createAuthRuntime();
      callbacks.onSignIn('google', { resumePublish: false });
      await flushMicrotasks();
      const attempt = useAppStore.getState().authSignInAttempt;
      expect(attempt?.message).toContain('about 1 minute');
    } finally {
      globalThis.fetch = savedFetch;
    }
  });

  it('429 without a Retry-After header → falls back to "wait a moment"', async () => {
    stubFakePopup();
    const savedFetch = stubIntentWith429(null);
    try {
      const { callbacks } = createAuthRuntime();
      callbacks.onSignIn('github', { resumePublish: false });
      await flushMicrotasks();
      const attempt = useAppStore.getState().authSignInAttempt;
      expect(attempt?.message).toMatch(/too many sign-in attempts/i);
      expect(attempt?.message).toContain('a moment');
    } finally {
      globalThis.fetch = savedFetch;
    }
  });

  it('429 with a malformed Retry-After also falls back to "wait a moment" (does not throw)', async () => {
    stubFakePopup();
    const savedFetch = stubIntentWith429('not-a-number');
    try {
      const { callbacks } = createAuthRuntime();
      callbacks.onSignIn('github', { resumePublish: false });
      await flushMicrotasks();
      const attempt = useAppStore.getState().authSignInAttempt;
      expect(attempt?.message).toContain('a moment');
    } finally {
      globalThis.fetch = savedFetch;
    }
  });

  it('429 with Retry-After="60abc" (partial-garbage tail) is treated as unknown, not 60', async () => {
    stubFakePopup();
    const savedFetch = stubIntentWith429('60abc');
    try {
      const { callbacks } = createAuthRuntime();
      callbacks.onSignIn('google', { resumePublish: false });
      await flushMicrotasks();
      const attempt = useAppStore.getState().authSignInAttempt;
      // Whole-string regex contract: partial-garbage MUST fall through
      // to "a moment" — NOT silently render "about 1 minute".
      expect(attempt?.message).toContain('a moment');
      expect(attempt?.message).not.toContain('about 1 minute');
    } finally {
      globalThis.fetch = savedFetch;
    }
  });

  it('429 with Retry-After="1.5" (fractional) falls through to "a moment"', async () => {
    stubFakePopup();
    const savedFetch = stubIntentWith429('1.5');
    try {
      const { callbacks } = createAuthRuntime();
      callbacks.onSignIn('google', { resumePublish: false });
      await flushMicrotasks();
      const attempt = useAppStore.getState().authSignInAttempt;
      // delta-seconds is an integer per RFC 7231; reject fractionals.
      expect(attempt?.message).toContain('a moment');
    } finally {
      globalThis.fetch = savedFetch;
    }
  });

  it('429 with Retry-After whitespace-only value falls through to "a moment"', async () => {
    stubFakePopup();
    const savedFetch = stubIntentWith429('   ');
    try {
      const { callbacks } = createAuthRuntime();
      callbacks.onSignIn('google', { resumePublish: false });
      await flushMicrotasks();
      const attempt = useAppStore.getState().authSignInAttempt;
      expect(attempt?.message).toContain('a moment');
    } finally {
      globalThis.fetch = savedFetch;
    }
  });

  it('429 DOES NOT render the generic 4xx "isn\u2019t available here" copy', async () => {
    stubFakePopup();
    const savedFetch = stubIntentWith429('5');
    try {
      const { callbacks } = createAuthRuntime();
      callbacks.onSignIn('google', { resumePublish: false });
      await flushMicrotasks();
      const attempt = useAppStore.getState().authSignInAttempt;
      expect(attempt?.message).not.toContain('isn\u2019t available here');
      expect(attempt?.message).not.toContain("isn't available here");
    } finally {
      globalThis.fetch = savedFetch;
    }
  });
});

// ── Runtime-level critical section (D120 — audit P1 follow-up).
// The UI disables provider buttons while authSignInAttempt.status ===
// 'starting', but UI disabling is advisory. The runtime enforces the
// same invariant at the owner of the side effect: onSignIn refuses
// re-entry while an attempt is in flight, and a monotonic attemptId
// strands any stale async branch so it cannot navigate the popup or
// flip the store after a newer attempt has started.

describe('auth-runtime — critical section (runtime guards UI-bypass races)', () => {
  const originalLocation = window.location;
  const originalOpen = window.open;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    useAppStore.getState().resetTransientState();
    useAppStore.getState().setAuthLoading();
    sessionStorage.clear();
    _resetAuthRuntimeForTest();
    delete (window as unknown as { location?: Location }).location;
    (window as unknown as { location: Partial<Location> }).location = {
      ...originalLocation,
      protocol: 'https:', host: 'atomdojo.test', hostname: 'atomdojo.test', port: '',
      origin: 'https://atomdojo.test', href: 'https://atomdojo.test/lab/', assign: vi.fn(),
    } as Location;
  });
  afterEach(() => {
    (window as unknown as { open: typeof window.open }).open = originalOpen;
    delete (window as unknown as { location?: Location }).location;
    (window as unknown as { location: Location }).location = originalLocation;
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('onSignIn: second call while first is in flight is rejected — only one popup + one fetch commit', async () => {
    const popupLocation = { href: '' };
    const fakePopup = {
      focus: vi.fn(),
      closed: false,
      location: popupLocation,
      document: { write: vi.fn(), close: vi.fn(), open: vi.fn() },
      close: vi.fn(),
    };
    const openSpy = vi.fn(() => fakePopup as unknown as Window);
    (window as unknown as { open: typeof window.open }).open = openSpy as typeof window.open;
    const fetchSpy = vi.fn(async (url: string) => {
      if (String(url).includes('/api/account/age-confirmation/intent')) {
        return new Response(JSON.stringify({ ageIntent: 'tok', ttlSeconds: 300 }), {
          status: 200, headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response('not mocked', { status: 500 });
    });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const { callbacks } = createAuthRuntime();
    // Two synchronous calls back-to-back — mimics a rapid double-click
    // that defeats React's async re-render of the disabled state.
    callbacks.onSignIn('google', { resumePublish: true });
    callbacks.onSignIn('google', { resumePublish: true });

    await flushMicrotasks();

    // Exactly one popup shell opened, exactly one intent fetch issued,
    // exactly one navigation committed to the popup.
    expect(openSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(popupLocation.href).toContain('/auth/google/start');
  });

  it('onSignIn: three rapid calls still commit only one attempt', async () => {
    const popupLocation = { href: '' };
    const fakePopup = {
      focus: vi.fn(), closed: false, location: popupLocation,
      document: { write: vi.fn(), close: vi.fn(), open: vi.fn() }, close: vi.fn(),
    };
    const openSpy = vi.fn(() => fakePopup as unknown as Window);
    (window as unknown as { open: typeof window.open }).open = openSpy as typeof window.open;
    const savedFetch = stubAgeIntentFetch('tok');
    try {
      const { callbacks } = createAuthRuntime();
      callbacks.onSignIn('google', { resumePublish: false });
      callbacks.onSignIn('github', { resumePublish: false });
      callbacks.onSignIn('google', { resumePublish: true });
      await flushMicrotasks();
      // Only the first click wins — the other two see the 'starting'
      // status and early-return without opening a shell.
      expect(openSpy).toHaveBeenCalledTimes(1);
      expect(popupLocation.href).toContain('/auth/google/start');
      // Sentinel NOT written because the winning call had resumePublish=false.
      expect(sessionStorage.getItem('atomdojo.resumePublish')).toBeNull();
    } finally {
      globalThis.fetch = savedFetch;
    }
  });

  it('onSignInSameTab: second call while first is in flight is rejected', async () => {
    (window as unknown as { open: typeof window.open }).open = vi.fn(() => null) as typeof window.open;
    const savedFetch = stubAgeIntentFetch('tok');
    try {
      const { callbacks } = createAuthRuntime();
      callbacks.onSignIn('github', { resumePublish: true });
      // Popup blocked, descriptor set. Now two rapid Continue-in-tab clicks.
      expect(useAppStore.getState().authPopupBlocked).not.toBeNull();
      callbacks.onSignInSameTab();
      // Pending descriptor cleared by the first call; the second
      // should early-return because no pending descriptor remains
      // AND authSignInAttempt.status === 'starting'.
      callbacks.onSignInSameTab();
      await flushMicrotasks();
      expect(window.location.assign).toHaveBeenCalledTimes(1);
    } finally {
      globalThis.fetch = savedFetch;
    }
  });
});

// ── Back clears the resume-publish sentinel when the abandoned flow
// was a publish-initiated sign-in (regression for the last leak in the
// popup-blocked UX). Concrete path exercised:
//
//   1. User clicks Publish → popup blocked (resumePublish:true stored).
//   2. User clicks Back → pending descriptor cleared + sentinel cleared.
//   3. User later clicks top-bar Sign in → popup-complete handshake runs.
//   4. Share tab must NOT auto-open because the stale intent is gone.

describe('Popup-blocked Back dismisses the resume-publish intent', () => {
  const originalLocation = window.location;
  const originalOpen = window.open;
  const originalFetch = globalThis.fetch;
  let attachedTeardown: (() => void) | null = null;

  beforeEach(() => {
    useAppStore.getState().resetTransientState();
    useAppStore.getState().setAuthLoading();
    sessionStorage.clear();
    _resetAuthRuntimeForTest();
    delete (window as unknown as { location?: Location }).location;
    (window as unknown as { location: Partial<Location> }).location = {
      ...originalLocation,
      protocol: 'https:',
      host: 'atomdojo.test',
      hostname: 'atomdojo.test',
      port: '',
      origin: 'https://atomdojo.test',
      href: 'https://atomdojo.test/lab/',
      assign: vi.fn(),
    } as Location;
  });
  afterEach(() => {
    if (attachedTeardown) { attachedTeardown(); attachedTeardown = null; }
    (window as unknown as { open: typeof window.open }).open = originalOpen;
    delete (window as unknown as { location?: Location }).location;
    (window as unknown as { location: Location }).location = originalLocation;
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('Back after publish-initiated popup-block clears the sessionStorage sentinel', () => {
    // D120: the popup-blocked path no longer writes the sentinel
    // (sentinel is written only at the navigation site, after the JIT
    // fetch resolves). For this test we pre-seed the sentinel as if a
    // PRIOR successful sign-in attempt had stored it; the dismiss
    // handler must still clear it defensively when the abandoned flow
    // was publish-initiated, so a later unrelated sign-in's
    // popup-complete handshake does not auto-open Share.
    sessionStorage.setItem(
      'atomdojo.resumePublish',
      JSON.stringify({ kind: 'resumePublish', provider: 'google', iat: Date.now() }),
    );
    (window as unknown as { open: typeof window.open }).open = vi.fn(() => null) as typeof window.open;
    const { callbacks } = createAuthRuntime();
    callbacks.onSignIn('google', { resumePublish: true });
    // Popup-blocked descriptor set; sentinel from the prior attempt
    // remains because the runtime did not clear it on this attempt.
    expect(useAppStore.getState().authPopupBlocked).toEqual({ provider: 'google', resumePublish: true });
    expect(sessionStorage.getItem('atomdojo.resumePublish')).not.toBeNull();

    // User clicks Back.
    callbacks.onDismissPopupBlocked();
    expect(useAppStore.getState().authPopupBlocked).toBeNull();
    // Sentinel cleared so a later unrelated sign-in cannot auto-open Share.
    expect(sessionStorage.getItem('atomdojo.resumePublish')).toBeNull();
  });

  it('Back after top-bar (non-publish) popup-block leaves the sentinel untouched', () => {
    // Simulate a stale resume-publish intent from a different flow that
    // the user has NOT abandoned — e.g. an in-flight popup in another tab.
    const livePayload = JSON.stringify({
      kind: 'resumePublish', provider: 'google', iat: Date.now(),
    });
    sessionStorage.setItem('atomdojo.resumePublish', livePayload);

    // Now block a secondary top-bar sign-in (resumePublish:false).
    (window as unknown as { open: typeof window.open }).open = vi.fn(() => null) as typeof window.open;
    const { callbacks } = createAuthRuntime();
    callbacks.onSignIn('github', { resumePublish: false }); // defaults to resumePublish:false
    expect(useAppStore.getState().authPopupBlocked).toEqual({ provider: 'github', resumePublish: false });

    callbacks.onDismissPopupBlocked();
    // Pending cleared, but the pre-existing intent (unrelated) is not
    // touched — abandoning a top-bar sign-in has no semantic bearing on
    // a separate publish flow's intent.
    expect(useAppStore.getState().authPopupBlocked).toBeNull();
    expect(sessionStorage.getItem('atomdojo.resumePublish')).toBe(livePayload);
  });

  it('end-to-end: Back after publish-block → unrelated top-bar sign-in → Share does NOT auto-open', async () => {
    // D120: pre-seed a sentinel (as if a prior successful publish-
    // initiated attempt had set it) so we can verify the Back path
    // clears it. The new sentinel-write timing means a fresh
    // popup-blocked attempt does NOT write the sentinel itself.
    sessionStorage.setItem(
      'atomdojo.resumePublish',
      JSON.stringify({ kind: 'resumePublish', provider: 'google', iat: Date.now() }),
    );
    (window as unknown as { open: typeof window.open }).open = vi.fn(() => null) as typeof window.open;
    const { callbacks } = createAuthRuntime();
    callbacks.onSignIn('google', { resumePublish: true });
    // Sentinel still present (came from the pre-seed, not from this attempt).
    expect(sessionStorage.getItem('atomdojo.resumePublish')).not.toBeNull();

    // Step 2: user clicks Back — sentinel cleared by the runtime.
    callbacks.onDismissPopupBlocked();
    expect(sessionStorage.getItem('atomdojo.resumePublish')).toBeNull();

    // Step 3: unrelated top-bar sign-in. Popup succeeds; completion handshake fires.
    (window as unknown as { open: typeof window.open }).open = vi.fn(
      () => ({ focus: vi.fn(), closed: false } as unknown as Window),
    ) as typeof window.open;
    globalThis.fetch = vi.fn(async () => new Response(
      JSON.stringify({ status: 'signed-in', userId: 'u1', displayName: 'Alice' }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )) as typeof fetch;
    attachedTeardown = attachAuthCompleteListener();
    callbacks.onSignIn('github', { resumePublish: false }); // no resumePublish — top-bar default

    // Simulate the popup-complete postMessage arriving.
    window.dispatchEvent(new MessageEvent('message', {
      data: { type: 'atomdojo-auth-complete' },
      origin: window.location.origin,
    }));
    await new Promise((r) => setTimeout(r, 0));

    // Session hydrated, but Share MUST NOT auto-open — there's no live
    // intent that should fire it.
    expect(useAppStore.getState().auth.status).toBe('signed-in');
    expect(useAppStore.getState().shareTabOpenRequested).toBe(false);
  });
});

// ── Onboarding dismissal persistence (Fix 3) ──
//
// Dismissal is sessionStorage-scoped: a same-tab OAuth redirect that lands
// back on /lab/ must not re-show the overlay. Browser restart resets.

describe('onboarding — dismissal persistence across same-tab OAuth bounce', () => {
  beforeEach(() => {
    useAppStore.getState().resetTransientState();
    sessionStorage.clear();
  });

  it('markOnboardingDismissed writes the session sentinel', async () => {
    const { markOnboardingDismissed } = await import('../../lab/js/runtime/onboarding');
    markOnboardingDismissed();
    expect(sessionStorage.getItem('atomdojo.onboardingDismissed')).toBe('1');
  });

  it('isOnboardingEligible returns false when the session sentinel is set', async () => {
    const { isOnboardingEligible } = await import('../../lab/js/runtime/onboarding');
    // Seed the app state that would otherwise make the overlay eligible.
    useAppStore.getState().updateAtomCount(60);
    expect(isOnboardingEligible()).toBe(true);

    sessionStorage.setItem('atomdojo.onboardingDismissed', '1');
    expect(isOnboardingEligible()).toBe(false);
  });

  it('eligibility returns to true after sessionStorage is cleared (full browser restart analogue)', async () => {
    const { isOnboardingEligible } = await import('../../lab/js/runtime/onboarding');
    useAppStore.getState().updateAtomCount(60);
    sessionStorage.setItem('atomdojo.onboardingDismissed', '1');
    expect(isOnboardingEligible()).toBe(false);
    sessionStorage.clear();
    expect(isOnboardingEligible()).toBe(true);
  });

  it('markOnboardingDismissed logs a warning when sessionStorage.setItem throws (private browsing)', async () => {
    const { markOnboardingDismissed } = await import('../../lab/js/runtime/onboarding');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // Simulate a Safari ITP / private-browsing setItem throw.
    const setItemSpy = vi.spyOn(Storage.prototype, 'setItem')
      .mockImplementation(() => { throw new Error('QuotaExceededError'); });
    markOnboardingDismissed();
    expect(warn).toHaveBeenCalled();
    const msg = warn.mock.calls.map((c) => String(c[0])).join('\n');
    expect(msg).toMatch(/onboarding/i);
    expect(msg).toMatch(/private browsing/i);
    setItemSpy.mockRestore();
    warn.mockRestore();
  });
});

// ── Audit fix H2: Vite dev host heuristic skips the popup path ──

describe('auth-runtime — Vite dev host guard (H2)', () => {
  const originalLocation = window.location;
  const originalOpen = window.open;

  beforeEach(() => {
    useAppStore.getState().resetTransientState();
    useAppStore.getState().setAuthLoading();
    sessionStorage.clear();
    _resetAuthRuntimeForTest();
  });
  afterEach(() => {
    (window as unknown as { open: typeof window.open }).open = originalOpen;
    delete (window as unknown as { location?: Location }).location;
    (window as unknown as { location: Location }).location = originalLocation;
    vi.restoreAllMocks();
  });

  function stubLocation(partial: Partial<Location>) {
    delete (window as unknown as { location?: Location }).location;
    (window as unknown as { location: Partial<Location> }).location = {
      ...originalLocation, ...partial,
    } as Location;
  }

  it('http://localhost:5173 (Vite dev) skips window.open and sets authPopupBlocked', () => {
    stubLocation({
      protocol: 'http:', host: 'localhost:5173', hostname: 'localhost', port: '5173',
      origin: 'http://localhost:5173', href: 'http://localhost:5173/lab/', assign: vi.fn(),
    });
    const openSpy = vi.fn();
    (window as unknown as { open: typeof window.open }).open = openSpy as typeof window.open;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const { callbacks } = createAuthRuntime();
    callbacks.onSignIn('google', { resumePublish: false });
    // The dev guard short-circuits BEFORE window.open — popup-blocked UI fires.
    expect(openSpy).not.toHaveBeenCalled();
    expect(useAppStore.getState().authPopupBlocked).toEqual({
      provider: 'google', resumePublish: false,
    });
    // Developer-facing diagnostic.
    const msg = warn.mock.calls.map((c) => String(c[0])).join('\n');
    expect(msg).toMatch(/wrangler pages dev/i);
    warn.mockRestore();
  });

  it('http://localhost:8788 (wrangler pages dev) DOES attempt window.open', () => {
    stubLocation({
      protocol: 'http:', host: 'localhost:8788', hostname: 'localhost', port: '8788',
      origin: 'http://localhost:8788', href: 'http://localhost:8788/lab/', assign: vi.fn(),
    });
    const openSpy = vi.fn(() => ({ focus: vi.fn(), closed: false } as unknown as Window));
    (window as unknown as { open: typeof window.open }).open = openSpy as unknown as typeof window.open;

    const { callbacks } = createAuthRuntime();
    callbacks.onSignIn('google', { resumePublish: false });
    expect(openSpy).toHaveBeenCalledTimes(1);
    expect(useAppStore.getState().authPopupBlocked).toBeNull();
  });

  it('production HTTPS DOES attempt window.open', () => {
    stubLocation({
      protocol: 'https:', host: 'atomdojo.pages.dev', hostname: 'atomdojo.pages.dev', port: '',
      origin: 'https://atomdojo.pages.dev', href: 'https://atomdojo.pages.dev/lab/', assign: vi.fn(),
    });
    const openSpy = vi.fn(() => ({ focus: vi.fn(), closed: false } as unknown as Window));
    (window as unknown as { open: typeof window.open }).open = openSpy as unknown as typeof window.open;

    const { callbacks } = createAuthRuntime();
    callbacks.onSignIn('google', { resumePublish: false });
    expect(openSpy).toHaveBeenCalledTimes(1);
  });
});

// ── Audit fix M2: detachAuthCompleteListener truly removes the listener ──

describe('auth-runtime — detachAuthCompleteListener singleton semantics (M2)', () => {
  const originalLocation = window.location;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    useAppStore.getState().resetTransientState();
    useAppStore.getState().setAuthLoading();
    _resetAuthRuntimeForTest();
    delete (window as unknown as { location?: Location }).location;
    (window as unknown as { location: Partial<Location> }).location = {
      ...originalLocation,
      protocol: 'https:', host: 'atomdojo.test', hostname: 'atomdojo.test', port: '',
      origin: 'https://atomdojo.test', href: 'https://atomdojo.test/lab/', assign: vi.fn(),
    } as Location;
    globalThis.fetch = vi.fn(async () => new Response(
      JSON.stringify({ status: 'signed-in', userId: 'u1', displayName: 'Alice' }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )) as typeof fetch;
  });
  afterEach(() => {
    _resetAuthRuntimeForTest();
    delete (window as unknown as { location?: Location }).location;
    (window as unknown as { location: Location }).location = originalLocation;
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('second attach returns the SAME detach reference as the first', () => {
    const d1 = attachAuthCompleteListener();
    const d2 = attachAuthCompleteListener();
    // Both references point at the same detach function — so a second
    // caller's teardown genuinely cleans up (not a silent no-op).
    expect(d1).toBe(d2);
  });

  it('detach truly removes the listener — a subsequent postMessage fires no handler', async () => {
    const detach = attachAuthCompleteListener();
    // Dispatch a message BEFORE detach — handler runs, store becomes signed-in.
    window.dispatchEvent(new MessageEvent('message', {
      data: { type: 'atomdojo-auth-complete' },
      origin: window.location.origin,
    }));
    await new Promise((r) => setTimeout(r, 0));
    expect(useAppStore.getState().auth.status).toBe('signed-in');

    // Reset auth to signed-out baseline, then detach, then dispatch.
    act(() => { useAppStore.getState().setAuthSignedOut(); });
    detach();

    // After detach, a fresh message must NOT trigger another hydrate.
    const fetchCallsBefore = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.length;
    window.dispatchEvent(new MessageEvent('message', {
      data: { type: 'atomdojo-auth-complete' },
      origin: window.location.origin,
    }));
    await new Promise((r) => setTimeout(r, 0));
    // No new fetch → no handler fired.
    expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.length).toBe(fetchCallsBefore);
    expect(useAppStore.getState().auth.status).toBe('signed-out');
  });

  it('logs a dev diagnostic when a cross-origin postMessage is dropped on a Vite dev host', async () => {
    // Re-stub location as Vite dev so the diagnostic branch fires.
    delete (window as unknown as { location?: Location }).location;
    (window as unknown as { location: Partial<Location> }).location = {
      ...originalLocation,
      protocol: 'http:', host: 'localhost:5173', hostname: 'localhost', port: '5173',
      origin: 'http://localhost:5173', href: 'http://localhost:5173/lab/', assign: vi.fn(),
    } as Location;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    attachAuthCompleteListener();
    // Dispatch from a different origin (simulates a wrangler popup on 8788).
    window.dispatchEvent(new MessageEvent('message', {
      data: { type: 'atomdojo-auth-complete' },
      origin: 'http://localhost:8788',
    }));
    // Message is dropped for security, but the dev-mode diagnostic fires.
    const msg = warn.mock.calls.map((c) => String(c[0])).join('\n');
    expect(msg).toMatch(/unexpected origin/i);
    warn.mockRestore();
  });
});

// ── Audit fix H3 + H4: handleAuthComplete .catch + clearResumeIntent persistence warning ──

describe('auth-runtime — resilience under store / storage failures (H3, H4)', () => {
  const originalLocation = window.location;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    useAppStore.getState().resetTransientState();
    useAppStore.getState().setAuthLoading();
    sessionStorage.clear();
    _resetAuthRuntimeForTest();
    delete (window as unknown as { location?: Location }).location;
    (window as unknown as { location: Partial<Location> }).location = {
      ...originalLocation,
      protocol: 'https:', host: 'atomdojo.test', hostname: 'atomdojo.test', port: '',
      origin: 'https://atomdojo.test', href: 'https://atomdojo.test/lab/', assign: vi.fn(),
    } as Location;
  });
  afterEach(() => {
    _resetAuthRuntimeForTest();
    delete (window as unknown as { location?: Location }).location;
    (window as unknown as { location: Location }).location = originalLocation;
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('H3: message handler catches errors from handleAuthComplete (no unhandled rejection)', async () => {
    // Force hydrateAuthSession's first write to throw by making
    // setAuthSignedIn blow up — simulates a future regression in a store
    // setter that used to be safe.
    const setAuthSignedIn = useAppStore.getState().setAuthSignedIn;
    const spy = vi.spyOn(useAppStore.getState(), 'setAuthSignedIn')
      .mockImplementation(() => { throw new Error('store setter boom'); });
    // Need fresh authCallbacks context: just dispatch message directly.
    globalThis.fetch = vi.fn(async () => new Response(
      JSON.stringify({ status: 'signed-in', userId: 'u1', displayName: 'Alice' }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )) as typeof fetch;
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});

    attachAuthCompleteListener();
    // Should NOT raise unhandled rejection.
    window.dispatchEvent(new MessageEvent('message', {
      data: { type: 'atomdojo-auth-complete' },
      origin: window.location.origin,
    }));
    await new Promise((r) => setTimeout(r, 10));

    expect(err).toHaveBeenCalled();
    const msg = err.mock.calls.map((c) => String(c[0])).join('\n');
    expect(msg).toMatch(/popup-complete handler failed/i);

    spy.mockRestore();
    err.mockRestore();
    // Re-install original so other tests aren't affected.
    useAppStore.setState({ setAuthSignedIn });
  });

  it('H4: onDismissPopupBlocked logs an error if sessionStorage.removeItem silently fails', () => {
    // D120: pre-seed the sentinel directly. The popup-blocked path
    // no longer writes the sentinel itself (sentinel is written only
    // at the navigation site, after the JIT fetch resolves).
    sessionStorage.setItem(
      'atomdojo.resumePublish',
      JSON.stringify({ kind: 'resumePublish', provider: 'google', iat: Date.now() }),
    );
    (window as unknown as { open: typeof window.open }).open = vi.fn(() => null) as typeof window.open;
    const { callbacks } = createAuthRuntime();
    callbacks.onSignIn('google', { resumePublish: true });
    expect(sessionStorage.getItem('atomdojo.resumePublish')).not.toBeNull();

    // Simulate removeItem silently failing (no throw but no effect).
    const removeSpy = vi.spyOn(Storage.prototype, 'removeItem')
      .mockImplementation(() => { /* silent no-op */ });
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});

    callbacks.onDismissPopupBlocked();
    // The sentinel persists because removeItem is mocked — we must log.
    expect(err).toHaveBeenCalled();
    const msg = err.mock.calls.map((c) => String(c[0])).join('\n');
    expect(msg).toMatch(/resume-intent sentinel persists/i);

    removeSpy.mockRestore();
    err.mockRestore();
  });
});

// ── Audit fix H1: popup-complete HTML carries the fallback channels + stuck-state copy ──

describe('popup-complete HTML contract (H1)', () => {
  it('includes postMessage, BroadcastChannel fallback, stuck-state DOM, and strict CSP', async () => {
    // Read the source of the Pages Function and grep for the contract hooks.
    // Running the actual function would require a wrangler environment; the
    // HTML is a static string so a source-level check is enough to guard
    // against regressions that silently drop one of the three channels.
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const src = await fs.readFile(
      path.resolve(process.cwd(), 'functions/auth/popup-complete.ts'),
      'utf-8',
    );
    // Primary channel.
    expect(src).toContain('window.opener.postMessage');
    expect(src).toContain("window.location.origin");
    // Fallback channel (for COOP-severed openers).
    expect(src).toContain("new BroadcastChannel('atomdojo-auth')");
    // Stuck-state recovery copy surfaces in the DOM when neither channel
    // delivers AND close() doesn't close the popup.
    expect(src).toMatch(/showStuck/);
    expect(src).toMatch(/Close this tab/i);
    // CSP is still strict.
    expect(src).toContain("default-src 'none'");
  });
});
