/**
 * @vitest-environment jsdom
 *
 * Render-level coverage for release-bar criterion #4 from
 * .reports/2026-04-26-turnstile-pat-trusted-types-diagnosis.md:
 *   "Account publish remains reachable when guest verification is
 *    failing."
 *
 * The structural source-scan in turnstile-session-dialog-integration
 * proves the auth-mode-aware copy *exists* in source and that the
 * radio control is named "Publish to account" somewhere. This file
 * goes further and asserts the rendered DOM under each failure state
 * for both signed-in guest contexts (whole-history + trim):
 *
 *   - the failure copy renders with a literal "Publish to account"
 *     reference (so the user is pointed at the actual control),
 *   - the destination selector with the "Publish to account" radio is
 *     present in the same render so the recovery path is reachable.
 *
 * Forces `verificationState` via a `vi.mock` of the runtime module —
 * the mock factory captures the `onStateChange` callback supplied by
 * `TimelineBar.useMemo([])` so tests can drive the state machine
 * deterministically without booting Cloudflare.
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, act, within } from '@testing-library/react';

import { useAppStore } from '../../lab/js/store/app-store';
import type { TimelineCallbacks } from '../../lab/js/store/app-store';

const { listeners } = vi.hoisted(() => ({
  listeners: {
    state: null as null | ((s: string) => void),
    token: null as null | ((t: string | null) => void),
  },
}));

vi.mock('../../lab/js/runtime/turnstile-session', () => ({
  // Capture the callbacks so tests can drive state transitions.
  createTurnstileSession: vi.fn((cbs: { onStateChange: (s: string) => void; onTokenChange: (t: string | null) => void }) => {
    listeners.state = cbs.onStateChange;
    listeners.token = cbs.onTokenChange;
    return {
      ensureScriptLoaded: vi.fn(async () => {}),
      ensureMounted: vi.fn(async () => {}),
      disposeWidget: vi.fn(),
      warm: vi.fn(),
      setQuickShareSurfaceActive: vi.fn(),
      getToken: vi.fn(() => null),
      resetToken: vi.fn(),
      getState: vi.fn(() => 'idle'),
    };
  }),
  // Re-export the constants used by other modules — runtime is the
  // single source so we keep the values consistent here.
  LOAD_TIMEOUT_MS: 10_000,
  EXECUTE_TIMEOUT_MS: 15_000,
}));

import { TimelineBar } from '../../lab/js/components/timeline/TimelineBar';

const noop = () => {};
const defaultCallbacks: TimelineCallbacks = {
  onScrub: noop, onReturnToLive: noop, onEnterReview: noop,
  onRestartFromHere: noop, onStartRecordingNow: noop, onTurnRecordingOff: noop,
};

function setActiveRange() {
  useAppStore.getState().updateTimelineState({
    mode: 'live', currentTimePs: 10, reviewTimePs: null,
    rangePs: { start: 0, end: 10 },
    canReturnToLive: false, canRestart: false, restartTargetPs: null,
  });
}

function setVerificationState(next: string): void {
  expect(listeners.state).not.toBeNull();
  listeners.state!(next);
}

beforeEach(() => {
  if (!(globalThis as any).ResizeObserver) {
    (globalThis as any).ResizeObserver = class {
      observe() {} unobserve() {} disconnect() {}
    };
  }
  listeners.state = null;
  listeners.token = null;
  useAppStore.getState().resetTransientState();
});
afterEach(() => { cleanup(); });

describe('release-bar #4 — signed-in whole-timeline guest, verificationState=load-failed', () => {
  it('renders the auth-mode-aware fallback copy AND the destination selector with the "Publish to account" radio', async () => {
    useAppStore.getState().installTimelineUI({
      ...defaultCallbacks,
      onExportHistory: () => Promise.resolve('saved' as const),
      onPublishFullAccountCapsule: () => Promise.resolve({ mode: 'account' as const, shareCode: 'A', shareUrl: 'a' }),
      onPublishFullGuestCapsule: () => Promise.resolve({ mode: 'guest' as const, shareCode: 'Y', shareUrl: 'y', expiresAt: '2030-01-01T00:00:00Z' }),
      onPauseForExport: () => true,
      onResumeFromExport: () => {},
    }, 'active', { full: true, capsule: true });
    useAppStore.getState().setAuthSignedIn({ userId: 'u', displayName: 'U' });
    useAppStore.getState().setPublicConfig({
      guestPublish: { enabled: true, turnstileSiteKey: 'SK' },
    });
    setActiveRange();

    render(<TimelineBar />);
    act(() => {
      (document.querySelector('.timeline-transfer-trigger') as HTMLButtonElement).click();
    });
    // Switch destination to guest so the Quick Share panel renders.
    const guestRadio = document.querySelector(
      '[data-testid="transfer-destination-guest"]',
    ) as HTMLButtonElement | null;
    expect(guestRadio).not.toBeNull();
    await act(async () => { guestRadio!.click(); });
    // Force the load-failed state.
    await act(async () => { setVerificationState('load-failed'); });

    // The unavailable paragraph renders.
    const errParagraph = document.querySelector(
      '[data-testid="transfer-guest-widget-unavailable"]',
    ) as HTMLElement | null;
    expect(errParagraph).not.toBeNull();
    expect(errParagraph!.textContent).toMatch(/Publish to account/);
    expect(errParagraph!.textContent).not.toMatch(/sign-in option/);

    // The destination selector with the "Publish to account" radio is
    // present and reachable in the same render — proving the user has
    // an actionable recovery path.
    const accountRadio = document.querySelector(
      '[data-testid="transfer-destination-account"]',
    ) as HTMLButtonElement | null;
    expect(accountRadio).not.toBeNull();
    expect(accountRadio!.textContent).toMatch(/Publish to account/);
    expect(accountRadio!.disabled).toBe(false);
  });
});

describe('release-bar #4 — signed-in whole-timeline guest, verificationState=challenge-error', () => {
  it('renders the auth-mode-aware fallback copy, the retry button, AND the "Publish to account" radio', async () => {
    useAppStore.getState().installTimelineUI({
      ...defaultCallbacks,
      onExportHistory: () => Promise.resolve('saved' as const),
      onPublishFullAccountCapsule: () => Promise.resolve({ mode: 'account' as const, shareCode: 'A', shareUrl: 'a' }),
      onPublishFullGuestCapsule: () => Promise.resolve({ mode: 'guest' as const, shareCode: 'Y', shareUrl: 'y', expiresAt: '2030-01-01T00:00:00Z' }),
      onPauseForExport: () => true,
      onResumeFromExport: () => {},
    }, 'active', { full: true, capsule: true });
    useAppStore.getState().setAuthSignedIn({ userId: 'u', displayName: 'U' });
    useAppStore.getState().setPublicConfig({
      guestPublish: { enabled: true, turnstileSiteKey: 'SK' },
    });
    setActiveRange();

    render(<TimelineBar />);
    act(() => {
      (document.querySelector('.timeline-transfer-trigger') as HTMLButtonElement).click();
    });
    const guestRadio = document.querySelector(
      '[data-testid="transfer-destination-guest"]',
    ) as HTMLButtonElement | null;
    await act(async () => { guestRadio!.click(); });
    await act(async () => { setVerificationState('challenge-error'); });

    const errParagraph = document.querySelector(
      '[data-testid="transfer-guest-widget-challenge-error"]',
    ) as HTMLElement | null;
    expect(errParagraph).not.toBeNull();
    expect(errParagraph!.textContent).toMatch(/Publish to account/);

    // Retry affordance present (criterion #2).
    const retryBtn = document.querySelector(
      '[data-testid="transfer-guest-verify-retry"]',
    ) as HTMLButtonElement | null;
    expect(retryBtn).not.toBeNull();
    expect(retryBtn!.disabled).toBe(false);

    // Account-publish recovery path present AND actionable (criterion #4).
    const accountRadio = document.querySelector(
      '[data-testid="transfer-destination-account"]',
    ) as HTMLButtonElement | null;
    expect(accountRadio).not.toBeNull();
    expect(accountRadio!.textContent).toMatch(/Publish to account/);
    expect(accountRadio!.disabled).toBe(false);
  });
});

describe('release-bar #4 — signed-in trim guest, verificationState=load-failed', () => {
  it('renders the trim panel with auth-mode-aware fallback copy AND the trim destination selector with "Publish to account"', async () => {
    useAppStore.getState().installTimelineUI({
      ...defaultCallbacks,
      onExportHistory: () => Promise.resolve('saved' as const),
      onPublishFullAccountCapsule: () => Promise.resolve({ mode: 'account' as const, shareCode: 'A', shareUrl: 'a' }),
      onPublishFullGuestCapsule: () => Promise.resolve({ mode: 'guest' as const, shareCode: 'Y', shareUrl: 'y', expiresAt: '2030-01-01T00:00:00Z' }),
      onPrepareCapsuleTrim: () => Promise.resolve({
        prepareId: 'p-1',
        bytes: 5 * 1024 * 1024,
        maxBytes: 20 * 1024 * 1024,
        maxSource: 'client-fallback' as const,
        frameCount: 8,
      }),
      onPublishPreparedAccountCapsule: () => Promise.resolve({ mode: 'account' as const, shareCode: 'A', shareUrl: 'a' }),
      onPublishPreparedGuestCapsule: () => Promise.resolve({ mode: 'guest' as const, shareCode: 'Y', shareUrl: 'y', expiresAt: '2030-01-01T00:00:00Z' }),
      onCancelPreparedCapsule: () => {},
      getCapsuleFrameIndex: () => ({
        snapshotId: 'v1:0:0:0',
        frames: Array.from({ length: 8 }, (_, i) => ({ frameId: i, timePs: i })),
      }),
      onPauseForExport: () => true,
      onResumeFromExport: () => {},
    }, 'active', { full: true, capsule: true });
    useAppStore.getState().setAuthSignedIn({ userId: 'u', displayName: 'U' });
    useAppStore.getState().setPublicConfig({
      guestPublish: { enabled: true, turnstileSiteKey: 'SK' },
    });
    setActiveRange();

    render(<TimelineBar />);
    act(() => {
      (document.querySelector('.timeline-transfer-trigger') as HTMLButtonElement).click();
    });
    // Enter manual trim via the scope toggle.
    const scopeTrim = document.querySelector(
      '[data-testid="transfer-scope-trim"]',
    ) as HTMLButtonElement | null;
    expect(scopeTrim).not.toBeNull();
    await act(async () => { scopeTrim!.click(); });
    // Flip trim destination to guest.
    const trimGuest = document.querySelector(
      '[data-testid="transfer-destination-guest"]',
    ) as HTMLButtonElement | null;
    expect(trimGuest).not.toBeNull();
    await act(async () => { trimGuest!.click(); });
    // Force load-failed.
    await act(async () => { setVerificationState('load-failed'); });

    // Trim panel renders.
    const trimPanel = document.querySelector(
      '[data-testid="transfer-share-trim"]',
    ) as HTMLElement | null;
    expect(trimPanel).not.toBeNull();

    // Inside the trim panel, the auth-mode-aware fallback copy points
    // at the "Publish to account" radio — not at a non-existent
    // sign-in option.
    const errParagraph = within(trimPanel!).getByTestId('transfer-guest-widget-unavailable');
    expect(errParagraph.textContent).toMatch(/Publish to account/);
    expect(errParagraph.textContent).not.toMatch(/sign-in option/);

    // The trim destination selector is rendered above the QSP card —
    // and offers the "Publish to account" radio as the recovery path.
    // Scoped within the trim panel so we're proving the radio is
    // present in the SAME render tree as the failure copy, and
    // assert it's enabled (the recovery path is actionable, not
    // present-but-disabled).
    const accountRadio = within(trimPanel!).getByTestId('transfer-destination-account') as HTMLButtonElement;
    expect(accountRadio.textContent).toMatch(/Publish to account/);
    expect(accountRadio.disabled).toBe(false);
  });
});

describe('release-bar #4 — signed-in trim guest, verificationState=challenge-error', () => {
  it('renders the trim panel with retry button, fallback copy AND the trim destination selector with "Publish to account"', async () => {
    useAppStore.getState().installTimelineUI({
      ...defaultCallbacks,
      onExportHistory: () => Promise.resolve('saved' as const),
      onPublishFullAccountCapsule: () => Promise.resolve({ mode: 'account' as const, shareCode: 'A', shareUrl: 'a' }),
      onPublishFullGuestCapsule: () => Promise.resolve({ mode: 'guest' as const, shareCode: 'Y', shareUrl: 'y', expiresAt: '2030-01-01T00:00:00Z' }),
      onPrepareCapsuleTrim: () => Promise.resolve({
        prepareId: 'p-1',
        bytes: 5 * 1024 * 1024,
        maxBytes: 20 * 1024 * 1024,
        maxSource: 'client-fallback' as const,
        frameCount: 8,
      }),
      onPublishPreparedAccountCapsule: () => Promise.resolve({ mode: 'account' as const, shareCode: 'A', shareUrl: 'a' }),
      onPublishPreparedGuestCapsule: () => Promise.resolve({ mode: 'guest' as const, shareCode: 'Y', shareUrl: 'y', expiresAt: '2030-01-01T00:00:00Z' }),
      onCancelPreparedCapsule: () => {},
      getCapsuleFrameIndex: () => ({
        snapshotId: 'v1:0:0:0',
        frames: Array.from({ length: 8 }, (_, i) => ({ frameId: i, timePs: i })),
      }),
      onPauseForExport: () => true,
      onResumeFromExport: () => {},
    }, 'active', { full: true, capsule: true });
    useAppStore.getState().setAuthSignedIn({ userId: 'u', displayName: 'U' });
    useAppStore.getState().setPublicConfig({
      guestPublish: { enabled: true, turnstileSiteKey: 'SK' },
    });
    setActiveRange();

    render(<TimelineBar />);
    act(() => {
      (document.querySelector('.timeline-transfer-trigger') as HTMLButtonElement).click();
    });
    const scopeTrim = document.querySelector(
      '[data-testid="transfer-scope-trim"]',
    ) as HTMLButtonElement | null;
    await act(async () => { scopeTrim!.click(); });
    const trimGuest = document.querySelector(
      '[data-testid="transfer-destination-guest"]',
    ) as HTMLButtonElement | null;
    await act(async () => { trimGuest!.click(); });
    await act(async () => { setVerificationState('challenge-error'); });

    const trimPanel = document.querySelector(
      '[data-testid="transfer-share-trim"]',
    ) as HTMLElement | null;
    expect(trimPanel).not.toBeNull();

    // Auth-mode-aware copy.
    const errParagraph = within(trimPanel!).getByTestId('transfer-guest-widget-challenge-error');
    expect(errParagraph.textContent).toMatch(/Publish to account/);

    // Retry affordance + account-publish recovery path both present
    // AND actionable inside the trim panel render tree.
    const retryBtn = within(trimPanel!).getByTestId('transfer-guest-verify-retry') as HTMLButtonElement;
    expect(retryBtn.disabled).toBe(false);
    const accountRadio = within(trimPanel!).getByTestId('transfer-destination-account') as HTMLButtonElement;
    expect(accountRadio.textContent).toMatch(/Publish to account/);
    expect(accountRadio.disabled).toBe(false);
  });
});

describe('release-bar #4 — signed-out whole-timeline guest, verificationState=challenge-error', () => {
  it('renders signed-out fallback copy ("sign-in option below") AND OAuth provider buttons below the panel', async () => {
    useAppStore.getState().installTimelineUI({
      ...defaultCallbacks,
      onExportHistory: () => Promise.resolve('saved' as const),
      onPublishFullGuestCapsule: () => Promise.resolve({ mode: 'guest' as const, shareCode: 'Y', shareUrl: 'y', expiresAt: '2030-01-01T00:00:00Z' }),
      onPauseForExport: () => true,
      onResumeFromExport: () => {},
    }, 'active', { full: true, capsule: true });
    useAppStore.getState().setAuthSignedOut();
    useAppStore.getState().setPublicConfig({
      guestPublish: { enabled: true, turnstileSiteKey: 'SK' },
    });
    setActiveRange();

    render(<TimelineBar />);
    act(() => {
      (document.querySelector('.timeline-transfer-trigger') as HTMLButtonElement).click();
    });
    await act(async () => { setVerificationState('challenge-error'); });

    const errParagraph = document.querySelector(
      '[data-testid="transfer-guest-widget-challenge-error"]',
    ) as HTMLElement | null;
    expect(errParagraph).not.toBeNull();
    expect(errParagraph!.textContent).toMatch(/sign-in option below/);
    expect(errParagraph!.textContent).not.toMatch(/Publish to account/);

    // OAuth providers ARE rendered below the QSP for signed-out
    // users — "below" is truthful — and they are actionable, not
    // present-but-disabled.
    const googleBtn = document.querySelector(
      '[data-testid="transfer-auth-google"]',
    ) as HTMLButtonElement | null;
    const githubBtn = document.querySelector(
      '[data-testid="transfer-auth-github"]',
    ) as HTMLButtonElement | null;
    expect(googleBtn).not.toBeNull();
    expect(githubBtn).not.toBeNull();
    expect(googleBtn!.disabled).toBe(false);
    expect(githubBtn!.disabled).toBe(false);
  });
});
