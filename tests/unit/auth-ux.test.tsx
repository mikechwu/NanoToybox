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
import { TimelineBar } from '../../lab/js/components/TimelineBar';
import { AccountControl } from '../../lab/js/components/AccountControl';
import {
  createAuthRuntime,
  hydrateAuthSession,
  consumeResumePublishIntent,
  AuthRequiredError,
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

  it('auth prompt button invokes authCallbacks.onSignIn with resumePublish: true', () => {
    const onSignIn = vi.fn();
    act(() => {
      installPublishableTimeline();
      setSession(null);
      useAppStore.getState().setAuthCallbacks({ onSignIn, onSignOut: vi.fn(async () => {}) });
    });
    render(<TimelineBar />);
    act(() => { (document.querySelector('.timeline-transfer-trigger') as HTMLButtonElement).click(); });

    act(() => {
      (document.querySelector('[data-testid="transfer-auth-google"]') as HTMLButtonElement).click();
    });
    expect(onSignIn).toHaveBeenCalledWith('google', { resumePublish: true });

    act(() => {
      (document.querySelector('[data-testid="transfer-auth-github"]') as HTMLButtonElement).click();
    });
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

  it('shows "Sign in" trigger when signed out, with Google + GitHub menu items', () => {
    const onSignIn = vi.fn();
    act(() => {
      setSession(null);
      useAppStore.getState().setAuthCallbacks({ onSignIn, onSignOut: vi.fn(async () => {}) });
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

    act(() => { google.click(); });
    // Top-bar sign-in is secondary — should NOT set resumePublish intent.
    expect(onSignIn).toHaveBeenCalledTimes(1);
    const [provider, opts] = onSignIn.mock.calls[0];
    expect(provider).toBe('google');
    expect(opts).toBeUndefined();
  });

  it('shows account chip with display name and Sign out when signed in', async () => {
    const onSignOut = vi.fn(async () => {});
    act(() => {
      setSession({ userId: 'user-12345678', displayName: 'Alice Smith' });
      useAppStore.getState().setAuthCallbacks({ onSignIn: vi.fn(), onSignOut });
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

  it('settles to signed-in on 200 with valid payload', async () => {
    globalThis.fetch = vi.fn(async () => new Response(
      JSON.stringify({ userId: 'u1', displayName: 'Alice', createdAt: '2026-01-01' }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )) as typeof fetch;

    const state = await hydrateAuthSession();
    expect(state.status).toBe('signed-in');
    expect(state.session?.userId).toBe('u1');
  });

  it('settles to signed-out on 401', async () => {
    globalThis.fetch = vi.fn(async () => new Response('Unauthorized', { status: 401 })) as typeof fetch;
    const state = await hydrateAuthSession();
    expect(state).toEqual({ status: 'signed-out', session: null });
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
    // fetch. The SECOND resolves first (401 → signed-out). The FIRST resolves
    // later (200 → would-set signed-in). The sequence token must drop the
    // late 200, preserving the authoritative signed-out.
    let resolveFirst!: (r: Response) => void;
    const firstPromise = new Promise<Response>((r) => { resolveFirst = r; });
    const responses = [
      () => firstPromise,
      () => Promise.resolve(new Response('Unauthorized', { status: 401 })),
    ];
    let callIdx = 0;
    globalThis.fetch = vi.fn(() => responses[callIdx++]()) as typeof fetch;

    const inFlight = hydrateAuthSession(); // increments seq to N
    const second = await hydrateAuthSession(); // increments seq to N+1, resolves 401
    expect(second.status).toBe('signed-out');
    expect(useAppStore.getState().auth.status).toBe('signed-out');

    // Now the first resolves with 200 — the sequence token should drop its write.
    resolveFirst(new Response(
      JSON.stringify({ userId: 'late', displayName: 'Late', createdAt: 'x' }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ));
    await inFlight;
    // Authoritative signed-out must still be in the store — the stale 200
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

  it('trigger uses aria-haspopup="true" not "menu"', () => {
    act(() => { setSession({ userId: 'u1', displayName: 'Alice' }); });
    render(<AccountControl />);
    const trigger = document.querySelector('[data-testid="account-chip"]');
    expect(trigger?.getAttribute('aria-haspopup')).toBe('true');
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
    (window as unknown as { location: Partial<Location> }).location = {
      ...originalLocation,
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

  it('onSignIn with resumePublish stores a structured JSON payload with iat + provider', () => {
    const now = 1_700_000_000_000;
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const { callbacks } = createAuthRuntime();
    callbacks.onSignIn('google', { resumePublish: true });

    const raw = sessionStorage.getItem('atomdojo.resumePublish');
    expect(raw).not.toBeNull();
    const payload = JSON.parse(raw!);
    expect(payload).toEqual({ kind: 'resumePublish', provider: 'google', iat: now });

    // The returnTo URL must carry the `authReturn=1` marker so the callback
    // handshake is provable on return.
    const assignSpy = window.location.assign as unknown as ReturnType<typeof vi.fn>;
    const target = assignSpy.mock.calls[0][0] as string;
    expect(target).toContain('/auth/google/start');
    expect(target).toContain(encodeURIComponent('/lab/?authReturn=1'));
  });

  it('onSignIn without resumePublish does NOT store a payload and does NOT add the marker', () => {
    const { callbacks } = createAuthRuntime();
    callbacks.onSignIn('github');
    expect(sessionStorage.getItem('atomdojo.resumePublish')).toBeNull();
    const target = (window.location.assign as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(target).not.toContain('authReturn');
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
        JSON.stringify({ userId: 'u1', displayName: 'Alice', createdAt: 'x' }),
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
      return new Response('Unauthorized', { status: 401 });
    }) as typeof fetch;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const { callbacks } = createAuthRuntime();
    await callbacks.onSignOut();
    expect(useAppStore.getState().auth.status).toBe('signed-out');

    // Reconciliation /session returns 401 — UI stays signed-out (consistent).
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
