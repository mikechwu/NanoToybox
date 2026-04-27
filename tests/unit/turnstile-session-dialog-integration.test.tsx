/**
 * @vitest-environment jsdom
 *
 * Dialog/panel integration coverage for the session-scoped Turnstile
 * runtime — see .reports/2026-04-26-turnstile-session-ux-implementation-report.md
 * §"Test Surfaces — Tier 2".
 *
 *   1. Structural — host element is NOT JSX-owned; the dialog renders
 *      only an empty `data-turnstile-mountpoint` slot.
 *   2. Behavioral — switching guest surfaces preserves host identity
 *      (no `turnstile.render` re-call). The Cloudflare script never
 *      loads in jsdom, so the widget stays in 'mounting' — but the
 *      controller-owned host element is appended synchronously inside
 *      `ensureMounted`, which is sufficient to verify host identity
 *      across cascade flips.
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, act } from '@testing-library/react';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { useAppStore } from '../../lab/js/store/app-store';
import type { TimelineCallbacks } from '../../lab/js/store/app-store';
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

beforeEach(() => {
  if (!(globalThis as any).ResizeObserver) {
    (globalThis as any).ResizeObserver = class {
      observe() {} unobserve() {} disconnect() {}
    };
  }
  document.head
    .querySelectorAll('script[data-atomdojo-turnstile]')
    .forEach((s) => s.remove());
  delete (globalThis as unknown as { turnstile?: unknown }).turnstile;
  useAppStore.getState().resetTransientState();
});
afterEach(() => { cleanup(); });

describe('turnstile-session — structural (host is not JSX-owned)', () => {
  const dialogPath = path.resolve(
    __dirname,
    '../../lab/js/components/timeline/timeline-transfer-dialog.tsx',
  );
  const stripComments = (src: string): string => src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');

  it('dialog source has no JSX node carrying data-turnstile-host', () => {
    const code = stripComments(fs.readFileSync(dialogPath, 'utf8'));
    expect(code).not.toMatch(/data-turnstile-host/);
  });

  it('dialog source declares the empty data-turnstile-mountpoint slot', () => {
    const code = stripComments(fs.readFileSync(dialogPath, 'utf8'));
    expect(code).toMatch(/data-turnstile-mountpoint/);
  });

  it('QuickShareDestinationPanel props no longer carry turnstileSiteKey or controllerRef', () => {
    const src = fs.readFileSync(dialogPath, 'utf8');
    const propsBlock = src.split('interface QuickShareDestinationPanelProps')[1] ?? '';
    const propsBody = propsBlock.slice(0, propsBlock.indexOf('}'));
    expect(propsBody).not.toMatch(/\bturnstileSiteKey\b/);
    expect(propsBody).not.toMatch(/\bcontrollerRef\b/);
    expect(propsBody).toMatch(/turnstileSession/);
    expect(propsBody).toMatch(/verificationState/);
    expect(propsBody).toMatch(/hasToken/);
    expect(propsBody).toMatch(/\bsiteKey\b/);
  });
});

describe('turnstile-session — behavioral (host identity survives cascade flips)', () => {
  it('host is parented under the active mountpoint and is the same node across surface flips', async () => {
    useAppStore.getState().installTimelineUI({
      ...defaultCallbacks,
      onExportHistory: () => Promise.resolve('saved' as const),
      onPublishFullAccountCapsule: () => Promise.resolve({ mode: 'account' as const, shareCode: 'X', shareUrl: 'x' }),
      onPublishFullGuestCapsule: () => Promise.resolve({ mode: 'guest' as const, shareCode: 'Y', shareUrl: 'y', expiresAt: '2030-01-01T00:00:00Z' }),
      onPauseForExport: () => true,
      onResumeFromExport: () => {},
    }, 'active', { full: true, capsule: true });
    useAppStore.getState().setAuthSignedOut();
    useAppStore.getState().setPublicConfig({
      guestPublish: { enabled: true, turnstileSiteKey: 'site-key-A' },
    });
    setActiveRange();

    render(<TimelineBar />);
    act(() => {
      (document.querySelector('.timeline-transfer-trigger') as HTMLButtonElement).click();
    });

    // Wait a microtask tick so the panel's useLayoutEffect fires its
    // ensureMounted call and the host element is appended into the
    // mountpoint slot.
    await act(async () => { await Promise.resolve(); });

    const mountpoint = document.querySelector(
      '[data-testid="transfer-guest-turnstile"]',
    ) as HTMLElement | null;
    expect(mountpoint).not.toBeNull();
    const hostBefore = mountpoint!.querySelector('[data-turnstile-host]');
    expect(hostBefore).not.toBeNull();

    // Flip scope to trim. The Trim selection toggle moves the panel
    // into the trim-guest render branch — same destination, different
    // mountpoint inside the dialog.
    const scopeTrim = document.querySelector(
      '[data-testid="transfer-scope-trim"]',
    ) as HTMLButtonElement | null;
    if (scopeTrim) {
      await act(async () => { scopeTrim.click(); });
      await act(async () => { await Promise.resolve(); });
    }

    // The host node is the same DOM element (controller-owned),
    // reparented into the new active mountpoint.
    const hostAfter = document.querySelector('[data-turnstile-host]');
    expect(hostAfter).not.toBeNull();
    expect(hostAfter).toBe(hostBefore);
  });
});

describe('turnstile-session — C1 silent-failure-fix UI contract (Acceptance #21)', () => {
  // The C1 contract says the dialog must surface unique testids for
  // each runtime failure mode so support / e2e can detect them
  // deterministically. The runtime-level state transitions are
  // covered in turnstile-session.test.ts; here we verify the JSX
  // mapping from `verificationState` to the testid is wired
  // unambiguously by source-scanning the panel render block.
  it('panel render block maps load-failed → transfer-guest-widget-unavailable and challenge-error → transfer-guest-widget-challenge-error', () => {
    const dialogPath = path.resolve(
      __dirname,
      '../../lab/js/components/timeline/timeline-transfer-dialog.tsx',
    );
    const src = fs.readFileSync(dialogPath, 'utf8');
    // Find the QuickShareDestinationPanel function body.
    const panelStart = src.indexOf('function QuickShareDestinationPanel(');
    expect(panelStart).toBeGreaterThan(0);
    const panelEnd = src.indexOf('\nfunction ', panelStart + 1);
    const panelBody = panelEnd > 0 ? src.slice(panelStart, panelEnd) : src.slice(panelStart);

    // load-failed branch must render the unavailable testid AND the
    // CTA's "Verification unavailable" label.
    expect(panelBody).toMatch(/widgetUnavailable[\s\S]+transfer-guest-widget-unavailable/);
    expect(panelBody).toMatch(/Verification unavailable/);
    // challenge-error branch must render the challenge-error testid.
    expect(panelBody).toMatch(/widgetChallengeError[\s\S]+transfer-guest-widget-challenge-error/);
    // The CTA disables when widgetUnavailable is true.
    expect(panelBody).toMatch(/ctaDisabled[\s\S]+widgetUnavailable/);
  });

  // Release-bar criterion #4 from the PAT/Trusted-Types diagnosis
  // (.reports/2026-04-26-turnstile-pat-trusted-types-diagnosis.md):
  // when verification fails, the user must have an actionable path to
  // account publish. The fallback copy must be auth-mode-aware —
  // signed-in users have the "Publish to account" radio in the
  // destination selector; signed-out users have OAuth providers below.
  // Pointing signed-in users at "sign-in option" dead-ends.
  it('panel copy directs signed-in users to "Publish to account" (the actual control label) and signed-out users to "sign-in option below" on both load-failed and challenge-error', () => {
    const dialogPath = path.resolve(
      __dirname,
      '../../lab/js/components/timeline/timeline-transfer-dialog.tsx',
    );
    const src = fs.readFileSync(dialogPath, 'utf8');
    // Strip comments so an explanatory comment containing the literal
    // copy strings doesn't false-positive the regex assertions below.
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
    const panelStart = code.indexOf('function QuickShareDestinationPanel(');
    expect(panelStart).toBeGreaterThan(0);
    const panelEnd = code.indexOf('\nfunction ', panelStart + 1);
    const panelBody = panelEnd > 0 ? code.slice(panelStart, panelEnd) : code.slice(panelStart);
    // Both load-failed and challenge-error blocks must branch on
    // authMode, with the signed-in branch directing the user to
    // "Publish to account" (the literal radio label, durable against
    // layout reordering) and the signed-out branch to a "sign-in
    // option below" (where OAuth providers actually render).
    expect(panelBody).toMatch(/transfer-guest-widget-unavailable[\s\S]+authMode === 'signed-in'[\s\S]+Publish to account/);
    expect(panelBody).toMatch(/transfer-guest-widget-unavailable[\s\S]+sign-in option below/);
    expect(panelBody).toMatch(/transfer-guest-widget-challenge-error[\s\S]+authMode === 'signed-in'[\s\S]+Publish to account/);
    expect(panelBody).toMatch(/transfer-guest-widget-challenge-error[\s\S]+sign-in option below/);
    // Verify the radio control referenced by the copy actually exists
    // by that exact label in `ShareDestinationSelector`.
    expect(code).toMatch(/ShareDestinationSelector[\s\S]+Publish to account/);
  });
});

describe('turnstile-session — Acceptance #7 (warm called on destination flip)', () => {
  // The warm() trigger is a single useEffect at the controller-wiring
  // level. Verifying it via source-scan rather than mock-injection
  // because a vi.doMock that beats the static `import { TimelineBar }`
  // race in this file is brittle. The runtime's own warm() behavior
  // is exhaustively covered in turnstile-session.test.ts.
  it('TimelineBar declares a useEffect that calls warm() conditioned on guestSurfaceActive + (ready|preparing) + !hasToken; recovery from challenge-error is user-initiated', () => {
    const tbPath = path.resolve(
      __dirname,
      '../../lab/js/components/timeline/TimelineBar.tsx',
    );
    const src = fs.readFileSync(tbPath, 'utf8');
    // The warm call site reads turnstileSession.warm() inside a useEffect
    // gated on guestSurfaceActive AND verificationState AND hasGuestToken.
    expect(src).toMatch(/turnstileSession\.warm\(\)/);
    // The effect must depend on all three signals so a flip in any of
    // them re-evaluates the warm trigger.
    expect(src).toMatch(/\[turnstileSession,\s*guestSurfaceActive,\s*verificationState,\s*hasGuestToken\]/);
    // 'challenge-error' MUST NOT be an auto-warmable state — auto-
    // warming a parked failure creates a tight retry loop with the
    // new solve watchdog. Recovery from challenge-error is via the
    // QuickShareDestinationPanel "Try verification again" button
    // (resetToken + warm) only. See the bug report
    // .reports/2026-04-26-turnstile-preparing-stuck-root-cause-bug-report.md.
    // Strip comments first so the explanatory comment about excluding
    // 'challenge-error' (which mentions the literal) doesn't false-
    // positive the negative assertion.
    const codeOnly = src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
    const warmEffectMatch = codeOnly.match(/useEffect\(\(\) => \{[\s\S]{0,400}turnstileSession\.warm\(\);[\s\S]{0,80}\}, \[turnstileSession,\s*guestSurfaceActive,\s*verificationState,\s*hasGuestToken\]\);/);
    expect(warmEffectMatch).not.toBeNull();
    if (warmEffectMatch) {
      expect(warmEffectMatch[0]).not.toMatch(/'challenge-error'/);
    }
  });

  it('QuickShareDestinationPanel renders the "Try verification again" button when verificationState === \'challenge-error\' and wires it to resetToken + warm', () => {
    // The user-initiated recovery path replaces the prior auto-warm
    // on challenge-error. Source-scan the panel render block.
    const dialogPath = path.resolve(
      __dirname,
      '../../lab/js/components/timeline/timeline-transfer-dialog.tsx',
    );
    const src = fs.readFileSync(dialogPath, 'utf8');
    const panelStart = src.indexOf('function QuickShareDestinationPanel(');
    const panelEnd = src.indexOf('\nfunction ', panelStart + 1);
    const panelBody = panelEnd > 0 ? src.slice(panelStart, panelEnd) : src.slice(panelStart);
    // The retry button is gated on widgetChallengeError (the
    // verificationState === 'challenge-error' boolean derived in the
    // panel) and renders the testid + label.
    expect(panelBody).toMatch(/widgetChallengeError[\s\S]+transfer-guest-verify-retry/);
    expect(panelBody).toMatch(/Try verification again/);
    // The click handler calls BOTH resetToken and warm in sequence
    // — this is the contract of the recovery path.
    expect(panelBody).toMatch(/turnstileSession\.resetToken\(\);[\s\S]{0,80}turnstileSession\.warm\(\);/);
  });
});

describe('turnstile-session — guestSurfaceActive config gate (regression)', () => {
  it('TimelineBar source folds guestPublishConfig.enabled + turnstileSiteKey into guestSurfaceActive', () => {
    // The runtime must not consider a guest surface active when the
    // dialog refuses to render Quick Share UI for it. The dialog
    // gates rendering on `guestPublishConfig.enabled &&
    // guestPublishConfig.turnstileSiteKey`; the TimelineBar surface-
    // active formula must mirror that gate so a config flip mid-
    // session doesn't leave proactive refresh / expired auto-rewarm
    // firing against a non-existent UI.
    const tbPath = path.resolve(
      __dirname,
      '../../lab/js/components/timeline/TimelineBar.tsx',
    );
    const src = fs.readFileSync(tbPath, 'utf8');
    const idx = src.indexOf('const guestSurfaceActive');
    expect(idx).toBeGreaterThan(0);
    // The reachability gate must be referenced AT or just before the
    // guestSurfaceActive declaration (declared via `guestSurfaceReachable`).
    const lookback = src.slice(Math.max(0, idx - 800), idx + 1000);
    expect(lookback).toMatch(/guestPublishConfig\.enabled/);
    expect(lookback).toMatch(/turnstileSiteKey/);
    expect(lookback).toMatch(/guestSurfaceReachable/);
  });

  it('signed-out user with guestPublish.enabled=false sees no Quick Share UI (so no guest surface can be active)', async () => {
    useAppStore.getState().installTimelineUI({
      ...defaultCallbacks,
      onExportHistory: () => Promise.resolve('saved' as const),
      onPublishFullGuestCapsule: () => Promise.resolve({ mode: 'guest' as const, shareCode: 'Y', shareUrl: 'y', expiresAt: '2030-01-01T00:00:00Z' }),
      onPauseForExport: () => true,
      onResumeFromExport: () => {},
    }, 'active', { full: true, capsule: true });
    useAppStore.getState().setAuthSignedOut();
    useAppStore.getState().setPublicConfig({
      guestPublish: { enabled: false, turnstileSiteKey: null },
    });
    setActiveRange();

    render(<TimelineBar />);
    act(() => {
      (document.querySelector('.timeline-transfer-trigger') as HTMLButtonElement).click();
    });
    await act(async () => { await Promise.resolve(); });

    // Quick Share panel must not render — no guest CTA, no
    // mountpoint, no host element. With no panel, ensureMounted is
    // never called; even if guestSurfaceActive were spuriously true,
    // there would be no surface to drive proactive refresh against.
    expect(document.querySelector('[data-testid="transfer-guest-continue"]')).toBeNull();
    expect(document.querySelector('[data-testid="transfer-guest-turnstile"]')).toBeNull();
    expect(document.querySelector('[data-turnstile-host]')).toBeNull();
  });
});

describe('turnstile-session — script-load behavior', () => {
  it('opening the Quick Share surface injects the Cloudflare script exactly once', async () => {
    useAppStore.getState().installTimelineUI({
      ...defaultCallbacks,
      onExportHistory: () => Promise.resolve('saved' as const),
      onPublishFullGuestCapsule: () => Promise.resolve({ mode: 'guest' as const, shareCode: 'Y', shareUrl: 'y', expiresAt: '2030-01-01T00:00:00Z' }),
      onPauseForExport: () => true,
      onResumeFromExport: () => {},
    }, 'active', { full: true, capsule: true });
    useAppStore.getState().setAuthSignedOut();
    useAppStore.getState().setPublicConfig({
      guestPublish: { enabled: true, turnstileSiteKey: 'site-key-A' },
    });
    setActiveRange();

    render(<TimelineBar />);
    act(() => {
      (document.querySelector('.timeline-transfer-trigger') as HTMLButtonElement).click();
    });
    await act(async () => { await Promise.resolve(); });

    expect(
      document.head.querySelectorAll('script[data-atomdojo-turnstile]').length,
    ).toBe(1);
  });
});
