/**
 * @vitest-environment jsdom
 *
 * Tests for `lab/js/runtime/turnstile-session.ts`. Covers the runtime
 * session controller: state machine, token lifecycle, ensureMounted
 * idempotence, site-key rotation, surface-active gating, and instance
 * isolation. See .reports/2026-04-26-turnstile-session-ux-implementation-report.md
 * §"Test Surfaces — Tier 1".
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

import {
  createTurnstileSession,
  LOAD_TIMEOUT_MS,
  type TurnstileApiStub,
  type TurnstileRenderOpts,
  type VerificationState,
} from '../../lab/js/runtime/turnstile-session';

interface CapturedWidget {
  id: string;
  el: HTMLElement;
  opts: TurnstileRenderOpts;
}

interface StubApi extends TurnstileApiStub {
  widgets: CapturedWidget[];
  fireSolve(token: string, idx?: number): void;
  fireError(idx?: number): void;
  fireExpired(idx?: number): void;
  renderCalls: number;
  removeCalls: number;
  resetCalls: number;
  executeCalls: number;
}

function createStub(): StubApi {
  const widgets: CapturedWidget[] = [];
  let nextId = 1;
  const counters = { render: 0, remove: 0, reset: 0, execute: 0 };
  const stub = {
    widgets,
    get renderCalls() { return counters.render; },
    get removeCalls() { return counters.remove; },
    get resetCalls() { return counters.reset; },
    get executeCalls() { return counters.execute; },
    render(el: HTMLElement, opts: TurnstileRenderOpts): string {
      counters.render += 1;
      const id = `w-${nextId++}`;
      widgets.push({ id, el, opts });
      return id;
    },
    remove(id: string): void {
      counters.remove += 1;
      const idx = widgets.findIndex((w) => w.id === id);
      if (idx >= 0) widgets.splice(idx, 1);
    },
    reset(_id: string): void { counters.reset += 1; },
    execute(_id: string): void { counters.execute += 1; },
    fireSolve(token: string, idx = widgets.length - 1): void {
      widgets[idx]?.opts.callback?.(token);
    },
    fireError(idx = widgets.length - 1): void {
      widgets[idx]?.opts['error-callback']?.();
    },
    fireExpired(idx = widgets.length - 1): void {
      widgets[idx]?.opts['expired-callback']?.();
    },
  };
  return stub as StubApi;
}

interface Sink {
  states: VerificationState[];
  tokens: Array<string | null>;
}

function createSink(): Sink {
  return { states: [], tokens: [] };
}

function makeMountpoint(): HTMLDivElement {
  const el = document.createElement('div');
  document.body.appendChild(el);
  return el;
}

beforeEach(() => {
  document.body.innerHTML = '';
  document.head
    .querySelectorAll('script[data-atomdojo-turnstile]')
    .forEach((s) => s.remove());
});

describe('createTurnstileSession — basic lifecycle', () => {
  it('mount + solve transitions state to ready and propagates the token', async () => {
    const stub = createStub();
    const sink = createSink();
    const c = createTurnstileSession({
      onStateChange: (s) => sink.states.push(s),
      onTokenChange: (t) => sink.tokens.push(t),
    }, stub);
    const mp = makeMountpoint();
    await c.ensureMounted(mp, 'site-A');
    expect(sink.states).toContain('mounting');
    expect(sink.states).toContain('ready');
    expect(stub.renderCalls).toBe(1);
    expect(c.getState()).toBe('ready');
    expect(c.getToken()).toBe(null);

    stub.fireSolve('TOK-1');
    expect(c.getToken()).toBe('TOK-1');
    expect(c.getState()).toBe('ready');
    expect(sink.tokens).toContain('TOK-1');
  });

  it('host element is created imperatively and reparented into mountpoints', async () => {
    const stub = createStub();
    const c = createTurnstileSession({
      onStateChange: () => {}, onTokenChange: () => {},
    }, stub);
    const a = makeMountpoint();
    const b = makeMountpoint();
    await c.ensureMounted(a, 'site-A');
    const host = a.querySelector('[data-turnstile-host]');
    expect(host).not.toBeNull();
    await c.ensureMounted(b, 'site-A');
    expect(b.querySelector('[data-turnstile-host]')).toBe(host);
    expect(a.querySelector('[data-turnstile-host]')).toBeNull();
  });

  it('ensureMounted is idempotent for the same site key — no second render', async () => {
    const stub = createStub();
    const c = createTurnstileSession({ onStateChange: () => {}, onTokenChange: () => {} }, stub);
    const a = makeMountpoint();
    const b = makeMountpoint();
    await c.ensureMounted(a, 'site-A');
    await c.ensureMounted(b, 'site-A');
    expect(stub.renderCalls).toBe(1);
    expect(stub.removeCalls).toBe(0);
  });

  it('ensureMounted(null, key) detaches the host without removing the widget', async () => {
    const stub = createStub();
    const c = createTurnstileSession({ onStateChange: () => {}, onTokenChange: () => {} }, stub);
    const a = makeMountpoint();
    await c.ensureMounted(a, 'site-A');
    stub.fireSolve('T');
    await c.ensureMounted(null, 'site-A');
    expect(a.querySelector('[data-turnstile-host]')).toBeNull();
    expect(stub.removeCalls).toBe(0);
    expect(c.getToken()).toBe('T');
    // Reattach a different mountpoint without a re-render.
    const b = makeMountpoint();
    await c.ensureMounted(b, 'site-A');
    expect(b.querySelector('[data-turnstile-host]')).not.toBeNull();
    expect(stub.renderCalls).toBe(1);
  });
});

describe('createTurnstileSession — uses execution: \'execute\'', () => {
  it('renders with appearance interaction-only and execution execute', async () => {
    const stub = createStub();
    const c = createTurnstileSession({ onStateChange: () => {}, onTokenChange: () => {} }, stub);
    await c.ensureMounted(makeMountpoint(), 'site-A');
    expect(stub.widgets[0].opts.appearance).toBe('interaction-only');
    expect(stub.widgets[0].opts.execution).toBe('execute');
  });
});

describe('createTurnstileSession — error / expired callbacks', () => {
  it('error-callback while surface inactive: clears token and transitions to challenge-error', async () => {
    const stub = createStub();
    const sink = createSink();
    const c = createTurnstileSession({
      onStateChange: (s) => sink.states.push(s),
      onTokenChange: (t) => sink.tokens.push(t),
    }, stub);
    await c.ensureMounted(makeMountpoint(), 'site-A');
    stub.fireSolve('T');
    expect(c.getToken()).toBe('T');
    stub.fireError();
    expect(c.getState()).toBe('challenge-error');
    expect(c.getToken()).toBe(null);
    expect(sink.states).toContain('challenge-error');
    // Reset was called so the widget is recoverable on the next warm.
    expect(stub.resetCalls).toBe(1);
  });

  it('inactive challenge-error → re-enter active surface + warm() recovers the widget', async () => {
    // Regression: when the surface is inactive and Cloudflare emits
    // error-callback, the controller parks at 'challenge-error'. On
    // later re-entry, the host (TimelineBar) calls warm(); because
    // the runtime already reset the widget inside error-callback,
    // warm() can safely call execute() and the widget recovers
    // without the user having to close and reopen the dialog.
    const stub = createStub();
    const c = createTurnstileSession({ onStateChange: () => {}, onTokenChange: () => {} }, stub);
    await c.ensureMounted(makeMountpoint(), 'site-A');
    // Inactive surface — error fires.
    stub.fireSolve('T-old');
    stub.fireError();
    expect(c.getState()).toBe('challenge-error');
    expect(c.getToken()).toBe(null);
    expect(stub.resetCalls).toBe(1); // reset happened inside error-callback
    expect(stub.executeCalls).toBe(0); // no auto-rewarm because inactive

    // User comes back to a guest surface. The host flips active and
    // then calls warm() — this is the exact sequence the TimelineBar
    // useEffect produces when verificationState === 'challenge-error'
    // && hasGuestToken === false.
    c.setQuickShareSurfaceActive(true);
    c.warm();
    expect(stub.executeCalls).toBe(1);
    expect(c.getState()).toBe('preparing');

    // Fresh solve closes the recovery loop.
    stub.fireSolve('T-new');
    expect(c.getState()).toBe('ready');
    expect(c.getToken()).toBe('T-new');
  });

  it('error-callback retry cap: after 3 consecutive errors the controller parks at challenge-error and stops auto-retrying', async () => {
    const stub = createStub();
    const c = createTurnstileSession({ onStateChange: () => {}, onTokenChange: () => {} }, stub);
    await c.ensureMounted(makeMountpoint(), 'site-A');
    c.setQuickShareSurfaceActive(true);
    // First failure: retry #1.
    stub.fireError();
    expect(c.getState()).toBe('preparing');
    expect(stub.executeCalls).toBe(1);
    // Second failure: retry #2.
    stub.fireError();
    expect(c.getState()).toBe('preparing');
    expect(stub.executeCalls).toBe(2);
    // Third failure: retry #3.
    stub.fireError();
    expect(c.getState()).toBe('preparing');
    expect(stub.executeCalls).toBe(3);
    // Fourth failure: cap reached → park at challenge-error, no execute fired.
    stub.fireError();
    expect(c.getState()).toBe('challenge-error');
    expect(stub.executeCalls).toBe(3);
  });

  it('error-callback retry counter resets after a successful solve', async () => {
    const stub = createStub();
    const c = createTurnstileSession({ onStateChange: () => {}, onTokenChange: () => {} }, stub);
    await c.ensureMounted(makeMountpoint(), 'site-A');
    c.setQuickShareSurfaceActive(true);
    stub.fireError(); // retry #1
    stub.fireError(); // retry #2
    expect(stub.executeCalls).toBe(2);
    stub.fireSolve('T-recovery');
    expect(c.getState()).toBe('ready');
    // The counter is cleared — three more errors should each trigger a retry.
    stub.fireError();
    stub.fireError();
    stub.fireError();
    expect(stub.executeCalls).toBe(2 + 3);
    expect(c.getState()).toBe('preparing');
  });

  it('error-callback while surface active auto-recovers via reset + execute (no terminal challenge-error)', async () => {
    // Regression: 'challenge-error' used to be a terminal state — the
    // CTA was disabled forever and no automatic rewarm fired. The
    // runtime now resets the widget AND triggers an immediate
    // re-execute when the user is in a Quick Share surface, so the
    // visible state goes 'preparing' (CTA shows "Preparing…") instead.
    const stub = createStub();
    const c = createTurnstileSession({ onStateChange: () => {}, onTokenChange: () => {} }, stub);
    await c.ensureMounted(makeMountpoint(), 'site-A');
    c.setQuickShareSurfaceActive(true);
    stub.fireSolve('T');
    stub.fireError();
    expect(stub.resetCalls).toBe(1);
    expect(stub.executeCalls).toBe(1);
    expect(c.getState()).toBe('preparing');
    expect(c.getToken()).toBe(null);
    // A subsequent fresh solve closes the recovery loop.
    stub.fireSolve('T2');
    expect(c.getState()).toBe('ready');
    expect(c.getToken()).toBe('T2');
  });

  it('expired-callback while inactive: clears token, state stays ready, no auto-rewarm', async () => {
    const stub = createStub();
    const c = createTurnstileSession({ onStateChange: () => {}, onTokenChange: () => {} }, stub);
    await c.ensureMounted(makeMountpoint(), 'site-A');
    stub.fireSolve('T');
    // No setQuickShareSurfaceActive(true) — surface inactive by default.
    stub.fireExpired();
    expect(c.getToken()).toBe(null);
    expect(c.getState()).toBe('ready');
    expect(stub.executeCalls).toBe(0);
  });

  it('expired-callback while active: clears token, transitions preparing, calls execute', async () => {
    const stub = createStub();
    const c = createTurnstileSession({ onStateChange: () => {}, onTokenChange: () => {} }, stub);
    await c.ensureMounted(makeMountpoint(), 'site-A');
    c.setQuickShareSurfaceActive(true);
    stub.fireSolve('T');
    stub.fireExpired();
    expect(c.getToken()).toBe(null);
    expect(c.getState()).toBe('preparing');
    expect(stub.executeCalls).toBe(1);
  });
});

describe('createTurnstileSession — load-failed timeout', () => {
  it('fires load-failed when widget never reaches ready within LOAD_TIMEOUT_MS', async () => {
    vi.useFakeTimers();
    try {
      const sink = createSink();
      // Stub.render captures opts but we never call it — simulate a
      // render that never resolves by NOT installing a stub. Instead
      // we install one that throws to mimic a script-load failure.
      const stub: TurnstileApiStub = {
        render: () => { throw new Error('script blocked'); },
        remove: () => {},
        reset: () => {},
        execute: () => {},
      };
      const c = createTurnstileSession({
        onStateChange: (s) => sink.states.push(s),
        onTokenChange: () => {},
      }, stub);
      const mp = makeMountpoint();
      // Don't await — render throws synchronously inside ensureMounted's
      // try/catch and sets load-failed immediately.
      await c.ensureMounted(mp, 'site-A');
      expect(sink.states).toContain('load-failed');
      // Watchdog timer should be cleared but we still advance to ensure
      // it doesn't double-fire.
      vi.advanceTimersByTime(LOAD_TIMEOUT_MS + 1000);
      expect(c.getState()).toBe('load-failed');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('createTurnstileSession — warm() and resetToken()', () => {
  it('warm() calls execute when no live token is present', async () => {
    const stub = createStub();
    const c = createTurnstileSession({ onStateChange: () => {}, onTokenChange: () => {} }, stub);
    await c.ensureMounted(makeMountpoint(), 'site-A');
    c.warm();
    expect(stub.executeCalls).toBe(1);
    expect(c.getState()).toBe('preparing');
  });

  it('warm() is a no-op when state is ready and a fresh token is live', async () => {
    const stub = createStub();
    const c = createTurnstileSession({ onStateChange: () => {}, onTokenChange: () => {} }, stub);
    await c.ensureMounted(makeMountpoint(), 'site-A');
    stub.fireSolve('T');
    c.warm();
    expect(stub.executeCalls).toBe(0);
  });

  it('resetToken() calls turnstile.reset and clears the token', async () => {
    const stub = createStub();
    const c = createTurnstileSession({ onStateChange: () => {}, onTokenChange: () => {} }, stub);
    await c.ensureMounted(makeMountpoint(), 'site-A');
    stub.fireSolve('T');
    c.resetToken();
    expect(stub.resetCalls).toBe(1);
    expect(c.getToken()).toBe(null);
  });
});

describe('createTurnstileSession — site-key rotation', () => {
  it('mount A → ensureMounted with key B → remove called once, fresh render with new key', async () => {
    const stub = createStub();
    const sink = createSink();
    const c = createTurnstileSession({
      onStateChange: (s) => sink.states.push(s),
      onTokenChange: (t) => sink.tokens.push(t),
    }, stub);
    const mp = makeMountpoint();
    await c.ensureMounted(mp, 'site-A');
    stub.fireSolve('TOK-A');
    expect(c.getToken()).toBe('TOK-A');

    await c.ensureMounted(mp, 'site-B');
    expect(stub.removeCalls).toBe(1);
    expect(stub.renderCalls).toBe(2);
    expect(stub.widgets[stub.widgets.length - 1].opts.sitekey).toBe('site-B');
    expect(c.getToken()).toBe(null);
    expect(sink.states).toContain('mounting');

    stub.fireSolve('TOK-B');
    expect(c.getToken()).toBe('TOK-B');
  });
});

describe('createTurnstileSession — surface-active gating (Acceptance #24)', () => {
  it('inactive surface: proactive 4-min refresh does not fire execute', async () => {
    vi.useFakeTimers();
    try {
      const stub = createStub();
      const c = createTurnstileSession({ onStateChange: () => {}, onTokenChange: () => {} }, stub);
      await c.ensureMounted(makeMountpoint(), 'site-A');
      c.setQuickShareSurfaceActive(true);
      stub.fireSolve('T');
      // Advance past the 4-minute refresh point.
      vi.advanceTimersByTime(4 * 60 * 1000 + 30_000);
      expect(stub.executeCalls).toBeGreaterThanOrEqual(1);
      const before = stub.executeCalls;
      // Now go inactive and advance further — proactive refresh stops.
      c.setQuickShareSurfaceActive(false);
      vi.advanceTimersByTime(60 * 60 * 1000);
      expect(stub.executeCalls).toBe(before);
    } finally {
      vi.useRealTimers();
    }
  });

  it('after expiry while inactive: warm() triggered by the host kicks off a re-solve', async () => {
    const stub = createStub();
    const c = createTurnstileSession({ onStateChange: () => {}, onTokenChange: () => {} }, stub);
    await c.ensureMounted(makeMountpoint(), 'site-A');
    stub.fireSolve('T');
    // Inactive, then expire — token clears, state stays 'ready'.
    c.setQuickShareSurfaceActive(false);
    stub.fireExpired();
    expect(c.getState()).toBe('ready');
    expect(stub.executeCalls).toBe(0);
    // Reactivate. The runtime does NOT auto-rewarm on activate; the
    // host (TimelineBar) explicitly calls warm() on the transition to
    // a guest Quick Share surface — that pattern is exercised here.
    c.setQuickShareSurfaceActive(true);
    expect(stub.executeCalls).toBe(0);
    c.warm();
    expect(stub.executeCalls).toBe(1);
    expect(c.getState()).toBe('preparing');
  });
});

describe('createTurnstileSession — instance isolation (Acceptance #25)', () => {
  it('two controllers do not share token/widget state', async () => {
    const stubA = createStub();
    const stubB = createStub();
    const a = createTurnstileSession({ onStateChange: () => {}, onTokenChange: () => {} }, stubA);
    const b = createTurnstileSession({ onStateChange: () => {}, onTokenChange: () => {} }, stubB);
    const mpA = makeMountpoint();
    const mpB = makeMountpoint();
    await a.ensureMounted(mpA, 'site-A');
    await b.ensureMounted(mpB, 'site-A');
    expect(stubA.renderCalls).toBe(1);
    expect(stubB.renderCalls).toBe(1);

    stubA.fireSolve('TOK-A');
    expect(a.getToken()).toBe('TOK-A');
    expect(b.getToken()).toBe(null);

    a.disposeWidget();
    expect(stubA.removeCalls).toBe(1);
    expect(stubB.removeCalls).toBe(0);

    b.warm();
    expect(stubB.executeCalls).toBe(1);
  });
});

describe('createTurnstileSession — disposeWidget reuse', () => {
  it('disposeWidget then ensureMounted again mounts a fresh widget', async () => {
    const stub = createStub();
    const c = createTurnstileSession({ onStateChange: () => {}, onTokenChange: () => {} }, stub);
    const mp = makeMountpoint();
    await c.ensureMounted(mp, 'site-A');
    stub.fireSolve('T');
    c.disposeWidget();
    expect(stub.removeCalls).toBe(1);
    expect(c.getToken()).toBe(null);
    expect(c.getState()).toBe('idle');
    await c.ensureMounted(mp, 'site-A');
    expect(stub.renderCalls).toBe(2);
    expect(c.getState()).toBe('ready');
  });

  it('callbacks scheduled before disposeWidget are silently dropped', async () => {
    const stub = createStub();
    const c = createTurnstileSession({ onStateChange: () => {}, onTokenChange: () => {} }, stub);
    await c.ensureMounted(makeMountpoint(), 'site-A');
    const widget = stub.widgets[0];
    c.disposeWidget();
    // A late solve callback (e.g. from a backgrounded iframe) must not
    // resurrect a token on the disposed-then-fresh controller.
    widget.opts.callback?.('STALE');
    expect(c.getToken()).toBe(null);
    expect(c.getState()).toBe('idle');
  });
});

describe('createTurnstileSession — pending-mount cancellation', () => {
  it('ensureMounted(null) cancels an in-flight mount: the resolved script never triggers a stale render', async () => {
    // Regression: previously, a panel that started ensureMounted(mp)
    // and then unmounted (cleanup → ensureMounted(null)) before the
    // Cloudflare script resolved would still render the widget into
    // the now-detached `mp`. This test holds the script promise open,
    // calls the null-detach in between, and verifies render was never
    // called.
    let resolveScript: (() => void) | null = null;
    const scriptPromise = new Promise<void>((res) => { resolveScript = res; });
    const stub: TurnstileApiStub = {
      render: vi.fn((_el, _opts) => 'w-1') as unknown as TurnstileApiStub['render'],
      remove: vi.fn(),
      reset: vi.fn(),
      execute: vi.fn(),
    };
    // Build a controller that uses our stubbed api but a custom
    // ensureScriptLoaded — emulate it by holding the api reference
    // away until we explicitly resolve. We can't directly inject a
    // custom script-loader, but we CAN simulate it by NOT providing
    // the api on the first ensureMounted call and providing it after
    // we resolve. Instead, just install a global window.turnstile so
    // ensureScriptLoaded short-circuits, but delay detach via a
    // microtask:

    // Cleaner approach: pass the api stub directly so script load is
    // a resolved no-op. Fire the null-detach BEFORE the await
    // continuation runs by using a microtask sequence.
    const controller = createTurnstileSession({
      onStateChange: () => {},
      onTokenChange: () => {},
    }, stub);
    const mp = makeMountpoint();
    // Kick off the mount. Because api is passed, ensureScriptLoaded
    // resolves synchronously inside a Promise.resolve() — but the
    // `await` still yields one microtask. We schedule the null-detach
    // immediately so it lands BEFORE the await continuation.
    const p = controller.ensureMounted(mp, 'site-A');
    // null-detach: this bumps mountRequestEpoch, which the awaited
    // continuation will see as superseded.
    await controller.ensureMounted(null, 'site-A');
    await p;
    // The render must NEVER have been called.
    expect((stub.render as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
    // Host must be detached.
    expect(mp.querySelector('[data-turnstile-host]')).toBeNull();
    // Resolve the never-actually-pending promise to satisfy the
    // structural rule of the harness.
    resolveScript?.();
    void scriptPromise;
  });

  it('null detach mid-mount returns state to idle so a follow-up mount starts cleanly', async () => {
    const stub = createStub();
    const sink = createSink();
    const c = createTurnstileSession({
      onStateChange: (s) => sink.states.push(s),
      onTokenChange: () => {},
    }, stub);
    const mp = makeMountpoint();
    const p = c.ensureMounted(mp, 'site-A');
    // Detach before the mount await completes. With the `api` stub
    // the script-load is synchronous, but the mount continuation
    // still defers through a microtask.
    await c.ensureMounted(null, 'site-A');
    await p;
    // mount→idle: detach reset state because no widget was ever rendered.
    expect(sink.states.includes('mounting')).toBe(true);
    expect(sink.states[sink.states.length - 1]).toBe('idle');
    // A fresh mount works normally.
    await c.ensureMounted(mp, 'site-A');
    expect(c.getState()).toBe('ready');
    expect(stub.renderCalls).toBe(1);
  });
});

describe('createTurnstileSession — StrictMode invariant (Acceptance #22)', () => {
  it('a forced ensureMounted-detach + remount cycle preserves the live token (host stays alive)', async () => {
    // Models the React-18 StrictMode dev-mode unmount-then-remount of
    // the dialog: the panel's useLayoutEffect cleanup calls
    // ensureMounted(null, key), then the new effect calls
    // ensureMounted(mp, key). Across that cycle the controller's
    // widget id, host element, and live token must all survive — the
    // submit-coordinator reads getToken() at submit time and must not
    // observe null between the two effects.
    const stub = createStub();
    const c = createTurnstileSession({ onStateChange: () => {}, onTokenChange: () => {} }, stub);
    const mp = makeMountpoint();
    await c.ensureMounted(mp, 'site-A');
    stub.fireSolve('LIVE-TOK');
    expect(c.getToken()).toBe('LIVE-TOK');

    // Cleanup half of the StrictMode pair.
    await c.ensureMounted(null, 'site-A');
    expect(c.getToken()).toBe('LIVE-TOK');
    expect(c.getState()).toBe('ready');

    // Setup half — re-attach to the same mountpoint.
    await c.ensureMounted(mp, 'site-A');
    expect(c.getToken()).toBe('LIVE-TOK');
    expect(stub.renderCalls).toBe(1); // no re-render across the cycle
    expect(stub.removeCalls).toBe(0); // no widget tear-down across the cycle
  });
});

describe('createTurnstileSession — script-marker reuse', () => {
  it('does not inject the Cloudflare script when the api is provided', async () => {
    const stub = createStub();
    const c = createTurnstileSession({ onStateChange: () => {}, onTokenChange: () => {} }, stub);
    await c.ensureMounted(makeMountpoint(), 'site-A');
    expect(document.head.querySelector('script[data-atomdojo-turnstile]')).toBeNull();
  });

  it('document-level script marker is the registry — concurrent controllers do not double-inject', async () => {
    // Without a stub the controller would attempt the real script
    // injection. Pre-install a marker so the controller's reuse path
    // is exercised — this simulates a second controller in the same
    // page session.
    const marker = document.createElement('script');
    marker.setAttribute('data-atomdojo-turnstile', '1');
    marker.setAttribute('src', 'https://example.test/turnstile.js');
    document.head.appendChild(marker);
    // Install a fake global turnstile so ensureScriptLoaded resolves
    // immediately without firing load events.
    (globalThis as unknown as { turnstile?: TurnstileApiStub }).turnstile = createStub();
    try {
      const c = createTurnstileSession({ onStateChange: () => {}, onTokenChange: () => {} });
      await c.ensureScriptLoaded();
      const scripts = document.head.querySelectorAll('script[data-atomdojo-turnstile]');
      expect(scripts.length).toBe(1);
    } finally {
      delete (globalThis as unknown as { turnstile?: unknown }).turnstile;
    }
  });
});
