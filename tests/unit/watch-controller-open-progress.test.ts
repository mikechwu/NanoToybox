/**
 * @vitest-environment jsdom
 */
/**
 * Controller tests for the open-flow state machine: openProgress,
 * derived loadingShareCode, terminal-path fire count, immutability
 * invariant, stream-reader download, throttle, and the
 * normalizeTotalBytes helper.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { normalizeTotalBytes } from '../../watch/js/watch-controller';

// ── normalizeTotalBytes helper contract ──

describe('normalizeTotalBytes', () => {
  it('returns the value for positive safe integers', () => {
    expect(normalizeTotalBytes(1000)).toBe(1000);
    expect(normalizeTotalBytes(1)).toBe(1);
    expect(normalizeTotalBytes(1_000_000)).toBe(1_000_000);
  });

  it('returns null for non-integer numbers (bytes must be whole)', () => {
    expect(normalizeTotalBytes(1_000_000.5)).toBeNull();
    expect(normalizeTotalBytes(0.1)).toBeNull();
    expect(normalizeTotalBytes(1.0000001)).toBeNull();
  });

  it('returns null for zero and negative numbers', () => {
    expect(normalizeTotalBytes(0)).toBeNull();
    expect(normalizeTotalBytes(-5)).toBeNull();
    expect(normalizeTotalBytes(-0.1)).toBeNull();
  });

  it('returns null for non-finite numbers', () => {
    expect(normalizeTotalBytes(NaN)).toBeNull();
    expect(normalizeTotalBytes(Infinity)).toBeNull();
    expect(normalizeTotalBytes(-Infinity)).toBeNull();
  });

  it('returns null for non-number types', () => {
    expect(normalizeTotalBytes('1000')).toBeNull();
    expect(normalizeTotalBytes(undefined)).toBeNull();
    expect(normalizeTotalBytes(null)).toBeNull();
    expect(normalizeTotalBytes({})).toBeNull();
    expect(normalizeTotalBytes([1000])).toBeNull();
    expect(normalizeTotalBytes(true)).toBeNull();
  });
});

// ── openProgress state machine: metadata fetch + derived loadingShareCode ──

import { createWatchController } from '../../watch/js/watch-controller';

// jsdom's fetch may not exist — install a controllable stub per test.
const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

/**
 * Poll a predicate until it returns true, a promise settles, or a
 * timeout elapses. Replaces the brittle "drain N microtasks" pattern
 * — the test waits for the observable condition instead of assuming
 * the current promise depth, so future refactors that add or remove
 * await hops in the production path don't silently break it.
 *
 * Throws on timeout with a labelled message so a failure points at
 * the waiting contract itself, not at a downstream assertion that
 * happens to notice the unmet precondition later (or at a hung
 * `await` in the test body).
 */
async function waitFor(
  predicate: () => boolean,
  opts: { timeoutMs?: number; tickMs?: number; label?: string } = {},
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 500;
  const tickMs = opts.tickMs ?? 1;
  const start = Date.now();
  // Cheap microtask drain first — catches the common case without
  // needing a real-timer hop.
  for (let i = 0; i < 20 && !predicate(); i++) await Promise.resolve();
  while (!predicate() && Date.now() - start < timeoutMs) {
    await new Promise<void>((r) => setTimeout(r, tickMs));
  }
  if (!predicate()) {
    throw new Error(`waitFor: timed out after ${timeoutMs}ms waiting for ${opts.label ?? 'condition'}`);
  }
}

/** Promise whose `.settled` flag flips true once fulfilled OR
 *  rejected. Lets condition-based waits detect "this promise is
 *  done" without awaiting it (which would swallow a rejection). */
function trackSettle<T>(p: Promise<T>): Promise<T> & { settled: boolean } {
  const tracked = p as Promise<T> & { settled: boolean };
  tracked.settled = false;
  p.then(() => { tracked.settled = true; }, () => { tracked.settled = true; });
  return tracked;
}

/**
 * Build a deferred fetch stub: the Nth call resolves when the Nth
 * `release()` function is invoked. Enables assertions on
 * pre-response controller state during `?c=` auto-open.
 */
function makeDeferredFetchQueue(): {
  fetch: typeof fetch;
  expect: () => { release: (value: Response | Error) => void };
} {
  const pending: Array<{ resolve: (r: Response) => void; reject: (e: unknown) => void }> = [];
  const fetchImpl: typeof fetch = () =>
    new Promise<Response>((resolve, reject) => {
      pending.push({ resolve, reject });
    });
  return {
    fetch: fetchImpl,
    expect: () => {
      // Claim next pending entry.
      let idx = -1;
      return {
        release(value: Response | Error) {
          if (idx === -1) {
            // Fail-safe: find the first still-pending slot.
            idx = pending.findIndex((p) => p !== undefined);
            if (idx === -1) throw new Error('no pending fetch');
          }
          const entry = pending[idx];
          if (value instanceof Error) entry.reject(value);
          else entry.resolve(value);
        },
      };
    },
  };
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
}

describe('openProgress state machine', () => {
  beforeEach(() => {
    // Each test installs its own fetch per scenario.
  });

  it('idle → share/metadata transition publishes once', async () => {
    const ctl = createWatchController();
    const notifications: number[] = [];
    ctl.subscribe(() => { notifications.push(notifications.length); });

    const q = makeDeferredFetchQueue();
    globalThis.fetch = q.fetch;

    const initial = ctl.getSnapshot();
    expect(initial.openProgress.kind).toBe('idle');
    expect(initial.loadingShareCode).toBeNull();

    const opening = ctl.openSharedCapsule('ABC123DEF456');

    // Before any fetch resolves, the controller should have
    // published the share/metadata entry and the derived
    // loadingShareCode.
    const mid = ctl.getSnapshot();
    expect(mid.openProgress.kind).toBe('share');
    if (mid.openProgress.kind === 'share') {
      expect(mid.openProgress.stage).toBe('metadata');
      expect(mid.openProgress.code).toBe('ABC123DEF456');
    }
    expect(mid.loadingShareCode).toBe('ABC123DEF456');
    expect(notifications.length).toBe(1);

    // Cleanup: let the promise settle with a 404 so it doesn't leak.
    q.expect().release(new Response('Not found', { status: 404 }));
    await opening;
  });

  it('loadingShareCode is derived from openProgress (no separate write)', () => {
    const ctl = createWatchController();
    const initial = ctl.getSnapshot();
    expect(initial.loadingShareCode).toBeNull();

    // We never write loadingShareCode directly — openSharedCapsule
    // is the only public path that flips it. The state machine test
    // above exercises that path; here we simply assert the derivation
    // is stable at idle.
    expect(initial.openProgress.kind).toBe('idle');
  });

  it('metadata 404 fires exactly two subscriber notifications: idle→share, share→idle+error', async () => {
    const ctl = createWatchController();
    const fires: Array<{ kind: string; code: string | null; error: string | null }> = [];
    ctl.subscribe(() => {
      const s = ctl.getSnapshot();
      fires.push({
        kind: s.openProgress.kind,
        code: s.loadingShareCode,
        error: s.error,
      });
    });

    const q = makeDeferredFetchQueue();
    globalThis.fetch = q.fetch;

    const opening = ctl.openSharedCapsule('ABC123DEF456');

    // Release the metadata request as a 404.
    q.expect().release(new Response('Not found', {
      status: 404,
      headers: { 'Content-Type': 'text/plain' },
    }));
    await opening;

    // Exactly TWO fires:
    //   fire 1: loading begins (idle→share/metadata; error null)
    //   fire 2: terminal error (share/metadata→idle; error='Shared capsule not found')
    expect(fires.length).toBe(2);
    expect(fires[0]).toEqual({ kind: 'share', code: 'ABC123DEF456', error: null });
    expect(fires[1]).toEqual({ kind: 'idle', code: null, error: 'Shared capsule not found' });
  });

  it('invalid share input transitions through setErrorKeepingCurrentState (single fire, no loading state)', () => {
    const ctl = createWatchController();
    const fires: string[] = [];
    ctl.subscribe(() => { fires.push(ctl.getSnapshot().error ?? '(no error)'); });

    // Invalid code: no network call — we go straight to terminal.
    ctl.openSharedCapsule('');
    expect(fires).toEqual(['Invalid share code or URL']);
    expect(ctl.getSnapshot().openProgress.kind).toBe('idle');
    expect(ctl.getSnapshot().loadingShareCode).toBeNull();
  });

  it('loadingShareCode is derived: equals openProgress.code during share open', async () => {
    const ctl = createWatchController();
    const q = makeDeferredFetchQueue();
    globalThis.fetch = q.fetch;

    const opening = ctl.openSharedCapsule('ABC123DEF456');
    const snap = ctl.getSnapshot();
    // Derivation: without any separate write, loadingShareCode must
    // equal the code inside openProgress.
    expect(snap.openProgress.kind).toBe('share');
    if (snap.openProgress.kind === 'share') {
      expect(snap.loadingShareCode).toBe(snap.openProgress.code);
      expect(snap.loadingShareCode).toBe('ABC123DEF456');
    }

    q.expect().release(new Response('Not found', { status: 404 }));
    await opening;

    // After terminal idle: derivation holds null.
    const terminal = ctl.getSnapshot();
    expect(terminal.openProgress.kind).toBe('idle');
    expect(terminal.loadingShareCode).toBeNull();
  });

  it('double-submit races: second openSharedCapsule supersedes the first (generation guard)', async () => {
    // Two concurrent share opens: the first must bail at its next
    // await boundary once the second bumps the generation counter,
    // so we never see the first's state land after the second starts.
    const ctl = createWatchController();
    const responses: Response[] = [];
    const pendingResolvers: Array<(r: Response) => void> = [];
    globalThis.fetch = () => new Promise<Response>((resolve) => {
      pendingResolvers.push(resolve);
    });

    // Call 1 → pending on metadata fetch.
    const p1 = ctl.openSharedCapsule('AAAA1111BBBB');
    const snap1 = ctl.getSnapshot();
    expect(snap1.openProgress.kind).toBe('share');
    if (snap1.openProgress.kind === 'share') {
      expect(snap1.openProgress.code).toBe('AAAA1111BBBB');
    }

    // Call 2 → bumps generation, supersedes call 1.
    const p2 = ctl.openSharedCapsule('CCCC2222DDDD');
    const snap2 = ctl.getSnapshot();
    expect(snap2.openProgress.kind).toBe('share');
    if (snap2.openProgress.kind === 'share') {
      expect(snap2.openProgress.code).toBe('CCCC2222DDDD');
    }

    // Resolve call 1's metadata with a 404 — the stale-generation
    // check MUST bail before setErrorKeepingCurrentState runs, so
    // call 2's openProgress stays intact.
    pendingResolvers[0](new Response('Not found', { status: 404 }));
    // Drain microtasks.
    await Promise.resolve();
    await Promise.resolve();
    const afterStale = ctl.getSnapshot();
    expect(afterStale.openProgress.kind).toBe('share');
    if (afterStale.openProgress.kind === 'share') {
      expect(afterStale.openProgress.code).toBe('CCCC2222DDDD');
    }
    expect(afterStale.error).toBeNull();

    // Clean up call 2.
    pendingResolvers[1](new Response('Not found', { status: 404 }));
    await p1;
    await p2;
  });

  it('stale fetch rejection does not overwrite the active request (catch-side stale guard)', async () => {
    // A newer share open must not be disturbed when an older
    // request's fetch rejects after the generation counter has
    // bumped — the catch block short-circuits on isStale().
    const ctl = createWatchController();
    const pending: Array<{ resolve: (r: Response) => void; reject: (e: unknown) => void }> = [];
    globalThis.fetch = () => new Promise<Response>((resolve, reject) => {
      pending.push({ resolve, reject });
    });

    const p1 = ctl.openSharedCapsule('AAAA1111BBBB');
    const p2 = ctl.openSharedCapsule('CCCC2222DDDD');

    // Reject call 1's metadata fetch with a network error. Without
    // the catch-side stale guard, setErrorKeepingCurrentState would
    // wipe call 2's openProgress and surface a stale error.
    pending[0].reject(new Error('socket closed'));
    await Promise.resolve();
    await Promise.resolve();

    const mid = ctl.getSnapshot();
    expect(mid.error).toBeNull();
    expect(mid.openProgress.kind).toBe('share');
    if (mid.openProgress.kind === 'share') {
      expect(mid.openProgress.code).toBe('CCCC2222DDDD');
    }

    // Clean up call 2.
    pending[1].resolve(new Response('Not found', { status: 404 }));
    await p1;
    await p2;
  });

  it('stream-reader fallback path: blobRes.body===null uses arrayBuffer/blob path without crashing', async () => {
    // When `blobRes.body` is null (stale Safari, service-worker
    // injection), the controller must fall back to `await
    // blobRes.blob()` while keeping the determinate bar at the same
    // `normalizedTotal` — no silent drop to indeterminate just
    // because streaming is unavailable.
    const ctl = createWatchController();
    const states: Array<{ kind: string; total?: number | null }> = [];
    ctl.subscribe(() => {
      const p = ctl.getSnapshot().openProgress;
      if (p.kind === 'share' && p.stage === 'download') {
        states.push({ kind: p.stage, total: p.totalBytes });
      }
    });

    // Metadata with sizeBytes=500. Blob response built with body
    // explicitly null to force the fallback branch.
    const metadata = jsonResponse({ sizeBytes: 500 }, { status: 200 });
    // Construct a Response whose `.body` getter returns null.
    // (Response's body is only null for redirects / empty in the
    //  spec — we fake it directly via Object.defineProperty.)
    const fakeBlob = new Blob(['{"bad":"json"}'], { type: 'application/json' });
    const blobResponse = new Response(fakeBlob, {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
    Object.defineProperty(blobResponse, 'body', { get: () => null });

    globalThis.fetch = ((url: string) =>
      Promise.resolve(url.includes('/blob') ? blobResponse : metadata.clone())) as unknown as typeof fetch;

    // Run — will fail to parse as a capsule (expected) but must
    // have published the download stage with totalBytes=500.
    await ctl.openSharedCapsule('ABC123DEF456');

    const downloadPublishes = states.filter((s) => s.kind === 'download');
    expect(downloadPublishes.length).toBeGreaterThanOrEqual(1);
    // Same normalized total as a stream path would have produced.
    expect(downloadPublishes[0].total).toBe(500);
    // Terminal state: error set (parse failure) + openProgress idle.
    const terminal = ctl.getSnapshot();
    expect(terminal.openProgress.kind).toBe('idle');
    expect(terminal.error).toBeTruthy();
  });

  it('error→share transition notifies (error cleared, new loading state)', async () => {
    // A terminal error must not "stick" — a subsequent share open
    // clears error and transitions to share/metadata, producing a
    // notification observable via the subscriber.
    const ctl = createWatchController();
    const q = makeDeferredFetchQueue();
    globalThis.fetch = q.fetch;

    const listener = vi.fn();
    ctl.subscribe(listener);

    // First call: invalid input — terminal error fires once.
    ctl.openSharedCapsule('');
    expect(listener.mock.calls.length).toBe(1);
    expect(ctl.getSnapshot().error).toBe('Invalid share code or URL');

    // Second call: valid code, starts loading. Must fire at least
    // once more (error clears + openProgress transitions to share).
    const opening = ctl.openSharedCapsule('ABC123DEF456');
    expect(listener.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(ctl.getSnapshot().error).toBeNull();
    expect(ctl.getSnapshot().openProgress.kind).toBe('share');

    // Cleanup.
    q.expect().release(new Response('Not found', { status: 404 }));
    await opening;
  });

  it('success path publishes metadata → download → prepare → idle AND terminates with loaded=true', async () => {
    // Locks the exact regression that `commitOpenProgress` was
    // introduced to prevent. Every stage transition MUST reach the
    // subscriber — not be silently swallowed by the comparator.
    // Uses the same known-good capsule fixture the e2e suite relies
    // on, so the terminal assertion is `loaded=true` rather than
    // permissive.
    const fs = await import('fs');
    const path = await import('path');
    const fixturePath = path.resolve(__dirname, '../e2e/fixtures/share-capsule.json');
    const capsuleJson = fs.readFileSync(fixturePath, 'utf-8');

    const metadata = jsonResponse(
      { sizeBytes: capsuleJson.length }, { status: 200 },
    );
    // Force the fallback-blob branch for determinism in jsdom (the
    // ReadableStream integration is out of scope here — the stream
    // path is tested separately).
    const blobRes = new Response(capsuleJson, {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
    Object.defineProperty(blobRes, 'body', { get: () => null });

    const ctl = createWatchController();
    const stages: string[] = [];
    ctl.subscribe(() => {
      const p = ctl.getSnapshot().openProgress;
      const tag = p.kind === 'idle'
        ? `idle(loaded=${ctl.getSnapshot().loaded})`
        : `${p.kind}/${p.stage}`;
      if (stages[stages.length - 1] !== tag) stages.push(tag);
    });

    globalThis.fetch = ((url: string) =>
      Promise.resolve(url.includes('/blob') ? blobRes : metadata.clone())) as unknown as typeof fetch;

    await ctl.openSharedCapsule('7M4K2D8Q9T1V'); // matches fixture SHARE_CODE

    // Ordered presence of the three loading stages.
    expect(stages).toContain('share/metadata');
    expect(stages).toContain('share/download');
    expect(stages).toContain('share/prepare');
    expect(stages.indexOf('share/metadata')).toBeLessThan(stages.indexOf('share/download'));
    expect(stages.indexOf('share/download')).toBeLessThan(stages.indexOf('share/prepare'));

    // Tight success contract: terminal tag is exactly idle(loaded=true).
    expect(stages[stages.length - 1]).toBe('idle(loaded=true)');

    // Sanity: the public snapshot reflects a usable workspace.
    const final = ctl.getSnapshot();
    expect(final.loaded).toBe(true);
    expect(final.fileKind).toBe('capsule');
    expect(final.atomCount).toBe(2);
    expect(final.error).toBeNull();

    ctl.dispose();
  });

  it('invalid share input supersedes a prior in-flight valid open (older flow cannot commit after invalid rejection)', async () => {
    // "Last user intent wins" must apply to invalid-code rejections
    // too. Bumping the open-generation counter BEFORE
    // `normalizeShareInput` validation is what makes this work.
    //
    // We release the prior valid request with a SUCCESS path
    // (metadata + blob both resolve with a loadable fixture) rather
    // than a 404. This is the stronger contract: even when the
    // older flow is fully capable of committing a file (prepare +
    // playback.load + renderer init), the stale-generation guard
    // must bail before any destructive commit runs — the user's
    // most recent action (invalid-input rejection) owns terminal
    // state.
    const fs = await import('fs');
    const path = await import('path');
    const fixturePath = path.resolve(__dirname, '../e2e/fixtures/share-capsule.json');
    const capsuleJson = fs.readFileSync(fixturePath, 'utf-8');

    const ctl = createWatchController();
    const pending: Array<{ resolve: (r: Response) => void; reject: (e: unknown) => void; url: string }> = [];
    globalThis.fetch = ((url: string) => new Promise<Response>((resolve, reject) => {
      pending.push({ resolve, reject, url });
    })) as unknown as typeof fetch;

    // Request 1 — valid code, stuck on metadata fetch.
    const p1 = trackSettle(ctl.openSharedCapsule('7M4K2D8Q9T1V'));
    expect(ctl.getSnapshot().openProgress.kind).toBe('share');

    // Request 2 — INVALID input. Must bump generation, set the
    // invalid-input error as the terminal state, and make request 1
    // stale.
    await ctl.openSharedCapsule(''); // synchronous terminal
    expect(ctl.getSnapshot().openProgress.kind).toBe('idle');
    expect(ctl.getSnapshot().error).toBe('Invalid share code or URL');

    // Release request 1's metadata with SUCCESS (full capsule
    // fixture). The post-await `isStale()` guard at the top of the
    // metadata/parse/blob flow must return early — the stale flow
    // must not transition openProgress to `download`, must not
    // fetch the blob, must not commit a file.
    pending[0].resolve(new Response(
      JSON.stringify({ sizeBytes: capsuleJson.length }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ));

    // Condition-based wait: poll until request 1's promise settles
    // OR a second fetch appears (which would be a regression) OR a
    // short timeout elapses. waitFor THROWS on timeout (labelled)
    // so a stuck stale-generation check surfaces as an explicit
    // failure at this line instead of a downstream assertion or a
    // hung `await p1`.
    await waitFor(
      () => p1.settled || pending.length > 1,
      { label: 'stale share request to settle or second fetch to appear' },
    );

    // Invalid-input terminal state survives untouched.
    const after = ctl.getSnapshot();
    expect(after.openProgress.kind).toBe('idle');
    expect(after.error).toBe('Invalid share code or URL');
    expect(after.loaded).toBe(false);
    // Critically: request 1 did NOT proceed to a second fetch
    // (blob). Only the metadata request was ever issued — the
    // stale-generation guard bailed before any destructive work.
    expect(pending.length).toBe(1);

    await p1;
    ctl.dispose();
  });

  it('stream completion force-publishes the final loadedBytes even when all chunks fit inside one throttle window', async () => {
    // Force-publish-on-completion contract: if the stream completes
    // inside a single 333ms throttle window, the loop's throttle
    // guard never fires — the post-loop force-publish is what keeps
    // the UI from jumping 0% → Preparing… without ever showing the
    // real final byte count.
    const ctl = createWatchController();
    const downloadTicks: number[] = [];
    ctl.subscribe(() => {
      const p = ctl.getSnapshot().openProgress;
      if (p.kind === 'share' && p.stage === 'download') {
        downloadTicks.push(p.loadedBytes);
      }
    });

    // Pin performance.now so every chunk arrives within the same
    // throttle window — the loop's throttled publish will NEVER
    // fire. Only the completion force-publish should land the real
    // final byte count.
    const frozenNow = 0;
    vi.spyOn(performance, 'now').mockReturnValue(frozenNow);

    const chunks = [
      new Uint8Array(100),
      new Uint8Array(150),
      new Uint8Array(250), // total 500 bytes, matches metadata.sizeBytes
    ];
    let chunkIdx = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (chunkIdx < chunks.length) {
          controller.enqueue(chunks[chunkIdx++]);
        } else {
          controller.close();
        }
      },
    });

    const metadata = jsonResponse({ sizeBytes: 500 }, { status: 200 });
    const blobRes = new Response(stream, {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });

    globalThis.fetch = ((url: string) =>
      Promise.resolve(url.includes('/blob') ? blobRes : metadata.clone())) as unknown as typeof fetch;

    await ctl.openSharedCapsule('ABC123DEF456');

    // Ticks observed during the download stage MUST include:
    //   - the opening 0-byte force-publish,
    //   - AND the completion force-publish at 500 bytes (clamped to
    //     totalBytes).
    // Intermediate throttled publishes are allowed but not required
    // when all chunks land inside a single window.
    expect(downloadTicks[0]).toBe(0);
    expect(downloadTicks[downloadTicks.length - 1]).toBe(500);

    vi.restoreAllMocks();
  });

  it('over-download warns and clamps the final determinate tick to metadata sizeBytes', async () => {
    // R2 serving more bytes than D1 metadata promised is a real
    // divergence worth flagging. The progress bar clamps for UI
    // coherence; the console.warn gives operators the reconciliation
    // signal.
    const ctl = createWatchController();
    const downloadTicks: number[] = [];
    ctl.subscribe(() => {
      const p = ctl.getSnapshot().openProgress;
      if (p.kind === 'share' && p.stage === 'download') {
        downloadTicks.push(p.loadedBytes);
      }
    });

    // Pin performance.now so the throttle guard never fires — only
    // the completion force-publish lands the terminal tick.
    vi.spyOn(performance, 'now').mockReturnValue(0);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // 150 bytes streamed, metadata claims 100.
    const chunks = [new Uint8Array(60), new Uint8Array(90)]; // total 150
    let chunkIdx = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (chunkIdx < chunks.length) {
          controller.enqueue(chunks[chunkIdx++]);
        } else {
          controller.close();
        }
      },
    });

    const metadata = jsonResponse({ sizeBytes: 100 }, { status: 200 });
    const blobRes = new Response(stream, {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });

    globalThis.fetch = ((url: string) =>
      Promise.resolve(url.includes('/blob') ? blobRes : metadata.clone())) as unknown as typeof fetch;

    await ctl.openSharedCapsule('ABC123DEF456');

    // Completion tick is clamped to normalizedTotal (100), not the
    // real 150 bytes streamed — determinate bar stays coherent.
    expect(downloadTicks[0]).toBe(0);
    expect(downloadTicks[downloadTicks.length - 1]).toBe(100);

    // Warn signal was emitted with the reconciliation payload.
    expect(warnSpy).toHaveBeenCalled();
    const warnCall = warnSpy.mock.calls.find(
      (args) => typeof args[0] === 'string' && args[0].includes('exceeded metadata sizeBytes'),
    );
    expect(warnCall).toBeDefined();
    expect(warnCall![1]).toMatchObject({
      code: 'ABC123DEF456',
      loadedBytes: 150,
      totalBytes: 100,
    });

    vi.restoreAllMocks();
  });

  it('over-download warns even when a throttled publish already captured the final byte count', async () => {
    // Covers the branch the previous test misses: if a throttled
    // publish lands the final byte count (i.e.
    // `loadedBytes === lastPublishedLoadedBytes` after the loop),
    // the completion-force-publish branch is skipped — but the
    // divergence signal must still fire because the warn is now
    // decoupled from that branch. Additionally: the throttled
    // publish itself must clamp so the controller snapshot honors
    // the determinate invariant `loadedBytes <= totalBytes` — no
    // future snapshot-consumer should see 150/100.
    const ctl = createWatchController();
    const downloadTicks: number[] = [];
    ctl.subscribe(() => {
      const p = ctl.getSnapshot().openProgress;
      if (p.kind === 'share' && p.stage === 'download') {
        downloadTicks.push(p.loadedBytes);
      }
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // Step performance.now so the throttle window elapses between
    // every chunk — every chunk lands a publish, and the LAST of
    // those publishes captures the real final byte count. No
    // completion-branch publish fires.
    let fakeNow = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => {
      const value = fakeNow;
      fakeNow += 500; // > 333 ms → every read triggers a throttled publish
      return value;
    });

    const chunks = [new Uint8Array(70), new Uint8Array(80)]; // total 150
    let chunkIdx = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (chunkIdx < chunks.length) {
          controller.enqueue(chunks[chunkIdx++]);
        } else {
          controller.close();
        }
      },
    });

    const metadata = jsonResponse({ sizeBytes: 100 }, { status: 200 });
    const blobRes = new Response(stream, {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });

    globalThis.fetch = ((url: string) =>
      Promise.resolve(url.includes('/blob') ? blobRes : metadata.clone())) as unknown as typeof fetch;

    await ctl.openSharedCapsule('ABC123DEF456');

    // The warn must fire regardless of which branch captured the
    // final tick — divergence is a property of the download, not of
    // the publish path.
    const warnCall = warnSpy.mock.calls.find(
      (args) => typeof args[0] === 'string' && args[0].includes('exceeded metadata sizeBytes'),
    );
    expect(warnCall).toBeDefined();
    expect(warnCall![1]).toMatchObject({
      code: 'ABC123DEF456',
      loadedBytes: 150,
      totalBytes: 100,
    });

    // Snapshot invariant: every download publish satisfies
    // `loadedBytes <= totalBytes`. The last observed tick lands the
    // final value at 100, not the raw 150 — this locks clamping on
    // the throttled-publish path, not just the completion path.
    expect(downloadTicks.length).toBeGreaterThan(0);
    for (const t of downloadTicks) {
      expect(t).toBeLessThanOrEqual(100);
    }
    expect(downloadTicks[downloadTicks.length - 1]).toBe(100);

    vi.restoreAllMocks();
  });

  it('fallback (body === null) path warns on over-download AND publishes a final clamped tick', async () => {
    // The fallback `await blobRes.blob()` path must match the stream
    // path's diagnostic + UX guarantees: D1/R2 size divergence fires
    // the same warn, and a final clamped download tick lets users
    // see the real final byte count instead of 0% → Preparing…
    // even in environments without readable streaming (stale Safari,
    // service-worker injection).
    const ctl = createWatchController();
    const downloadTicks: number[] = [];
    ctl.subscribe(() => {
      const p = ctl.getSnapshot().openProgress;
      if (p.kind === 'share' && p.stage === 'download') {
        downloadTicks.push(p.loadedBytes);
      }
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // 150 bytes in the blob, metadata claims 100 — the warn must
    // fire and the final tick must clamp to 100.
    const payload = new Uint8Array(150).fill(0x20); // whitespace, harmless
    const metadata = jsonResponse({ sizeBytes: 100 }, { status: 200 });
    const blobRes = new Response(payload, {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
    // Force the fallback branch.
    Object.defineProperty(blobRes, 'body', { get: () => null });

    globalThis.fetch = ((url: string) =>
      Promise.resolve(url.includes('/blob') ? blobRes : metadata.clone())) as unknown as typeof fetch;

    await ctl.openSharedCapsule('ABC123DEF456');

    // Diagnostic signal fires on the fallback path too, not just
    // the stream path.
    const warnCall = warnSpy.mock.calls.find(
      (args) => typeof args[0] === 'string' && args[0].includes('exceeded metadata sizeBytes'),
    );
    expect(warnCall).toBeDefined();
    expect(warnCall![1]).toMatchObject({
      code: 'ABC123DEF456',
      loadedBytes: 150,
      totalBytes: 100,
    });

    // Snapshot invariant holds on the fallback path: every download
    // tick is clamped. Final tick is the clamped value (100), not
    // a stale 0% left over from the initial force-publish.
    expect(downloadTicks.length).toBeGreaterThan(0);
    for (const t of downloadTicks) {
      expect(t).toBeLessThanOrEqual(100);
    }
    expect(downloadTicks[0]).toBe(0);
    expect(downloadTicks[downloadTicks.length - 1]).toBe(100);

    vi.restoreAllMocks();
  });
});
