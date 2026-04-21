/**
 * @vitest-environment jsdom
 *
 * AccountApp state-machine tests for the lazy-rebake feedback loop
 * (ADR D135 follow-up, 2026-04-21). Validates the v5 + v6 invariants:
 *
 *   1. First-page auto-refresh schedules an 8 s follow-up when the
 *      response carries `previewPending`.
 *   2. Auto-refresh is suppressed after `onLoadMore()` fires (the
 *      timer-driven page-1 refetch cannot collapse the user's loaded
 *      page 2/3).
 *   3. Crossing into paginated mode tears down the pending-heal UI
 *      state so the shimmer overlay can't hang indefinitely on page-1
 *      rows that no timer is chasing any more.
 *   4. Reload anti-race — `reloadSeqRef` prevents a slow prior load
 *      from overwriting a newer transition.
 *   5. Post-delete `refreshCapsules` restarts the 8 s follow-up loop
 *      when the refreshed response carries `previewPending` (v6 #2).
 *
 * Harness: reuses the `bootAccountApp()` dynamic-import pattern that
 * `account-single-delete.test.tsx` and `account-delete-all-loop.test.tsx`
 * already use for AccountApp-level tests — single authoritative boot
 * path, not a new controller extraction (plan v6 finding #2).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, screen, act, fireEvent, waitFor } from '@testing-library/react';

interface FetchCall {
  url: string;
  method: string;
  cursor: string | null;
}

function defaultMe() {
  return {
    userId: 'user-1',
    displayName: 'Test',
    createdAt: '2026-01-01T00:00:00Z',
    provider: 'google',
    ageConfirmedAt: '2026-04-14T00:00:00Z',
    policyVersion: '2026-04-14.2',
  };
}

function capsule(shareCode: string) {
  return {
    shareCode,
    createdAt: '2026-04-14T10:00:00Z',
    sizeBytes: 1024,
    frameCount: 10,
    atomCount: 4,
    title: null,
    kind: 'capsule',
    status: 'ready',
    previewStatus: 'none',
    previewThumb: null,
  };
}

/** Boots a fresh `AccountApp` onto a test-owned root element via the
 *  `mountAccountApp` helper. The returned React root is stashed at
 *  module scope so `afterEach` can unmount between runs — without
 *  that, pending `setTimeouts` and document event listeners from the
 *  prior test's `AccountApp` keep firing into `globalThis.fetch` and
 *  side-effects register against the wrong boot.
 *
 *  When `controlScheduler: true`, installs the
 *  `setAccountSchedulerOverride` test seam so the 8 s follow-up
 *  timer can be fired deterministically via `fireScheduledRefresh()`
 *  instead of driven by wall-clock `setTimeout`. Tests that assert
 *  "a scheduled refresh eventually fires" should use this path; the
 *  few cases that only need to assert the absence of a refresh can
 *  boot without the override (the real timer never fires inside the
 *  test's 2 s default waitFor). */
interface ScheduledTask {
  fn: () => void;
  cancelled: boolean;
}

let currentAccountRoot: { unmount: () => void } | null = null;
let currentModule: typeof import('../../account/main') | null = null;
let pendingSchedulerTasks: ScheduledTask[] = [];

async function bootAccountApp(
  opts: { controlScheduler?: boolean } = {},
): Promise<void> {
  currentModule = await import('../../account/main');
  if (opts.controlScheduler) {
    pendingSchedulerTasks = [];
    currentModule.setAccountSchedulerOverride((fn) => {
      const entry: ScheduledTask = { fn, cancelled: false };
      pendingSchedulerTasks.push(entry);
      return () => { entry.cancelled = true; };
    });
  }
  const rootEl = document.createElement('div');
  rootEl.id = 'account-root';
  document.body.appendChild(rootEl);
  currentAccountRoot = currentModule.mountAccountApp(rootEl);
}

function teardownAccountApp(): void {
  currentAccountRoot?.unmount();
  currentAccountRoot = null;
  currentModule?.setAccountSchedulerOverride(null);
  currentModule = null;
  pendingSchedulerTasks = [];
}

/** Fire the oldest pending scheduled refresh (if any) and flush a
 *  microtask tick so the triggered `doRefresh` can start its fetch
 *  and the subsequent setState lands. */
async function fireScheduledRefresh(): Promise<void> {
  const next = pendingSchedulerTasks.find((t) => !t.cancelled);
  if (next) {
    next.cancelled = true;
    next.fn();
  }
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function pendingScheduledCount(): number {
  return pendingSchedulerTasks.filter((t) => !t.cancelled).length;
}

function installFetch(handler: (call: FetchCall) => Response | Promise<Response>): {
  restore: () => void;
  calls: FetchCall[];
} {
  const originalFetch = globalThis.fetch;
  const calls: FetchCall[] = [];
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = (init?.method ?? 'GET').toUpperCase();
    const parsed = new URL(url, 'https://x.test');
    const cursor = parsed.searchParams.get('cursor');
    calls.push({ url, method, cursor });
    return handler({ url, method, cursor });
  }) as typeof fetch;
  return { restore: () => { globalThis.fetch = originalFetch; }, calls };
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
}

beforeEach(() => {
  document.body.innerHTML = '';
  vi.resetModules();
});

afterEach(() => {
  teardownAccountApp();
  cleanup();
  document.body.innerHTML = '';
  vi.useRealTimers();
});

describe('AccountApp lazy-rebake flow', () => {
  it('1. first-page previewPending schedules an 8 s follow-up refresh', async () => {
    let capsuleCall = 0;
    const f = installFetch(({ url, method }) => {
      if (url.includes('/api/account/me')) return jsonResponse(defaultMe());
      if (url.includes('/api/account/capsules') && method === 'GET') {
        capsuleCall++;
        return jsonResponse({
          capsules: [capsule('ABCD0001')],
          hasMore: false,
          nextCursor: null,
          previewPending: capsuleCall === 1 ? ['ABCD0001'] : [],
        });
      }
      return new Response('not mocked', { status: 500 });
    });
    try {
      await bootAccountApp({ controlScheduler: true });
      await waitFor(() =>
        expect(document.body.textContent).toMatch(/ABCD0001/),
      );
      // The component scheduled the 8 s follow-up via our
      // deterministic override — assert it's armed, then fire it.
      await waitFor(() => expect(pendingScheduledCount()).toBe(1));
      const countBefore = f.calls.filter(
        (c) => c.url.includes('/api/account/capsules') && c.method === 'GET',
      ).length;
      await fireScheduledRefresh();
      await waitFor(() => {
        const now = f.calls.filter(
          (c) => c.url.includes('/api/account/capsules') && c.method === 'GET',
        ).length;
        expect(now).toBeGreaterThan(countBefore);
      });
    } finally {
      f.restore();
    }
  });

  it('2. auto-refresh is suppressed after onLoadMore()', async () => {
    let capsuleCall = 0;
    const f = installFetch(({ url, method, cursor }) => {
      if (url.includes('/api/account/me')) return jsonResponse(defaultMe());
      if (url.includes('/api/account/capsules') && method === 'GET') {
        if (cursor) {
          // Page 2.
          return jsonResponse({
            capsules: [capsule('PAGE2A001')],
            hasMore: false,
            nextCursor: null,
            previewPending: [],
          });
        }
        capsuleCall++;
        return jsonResponse({
          capsules: [capsule('ABCD0001')],
          hasMore: true,
          nextCursor: 'CURSOR-ABCD',
          previewPending: ['ABCD0001'],
        });
      }
      return new Response('not mocked', { status: 500 });
    });
    try {
      await bootAccountApp({ controlScheduler: true });
      await waitFor(() =>
        expect(document.body.textContent).toMatch(/ABCD0001/),
      );
      // The 8 s follow-up was scheduled after the initial load —
      // armed and waiting. Click Load more before firing it.
      expect(pendingScheduledCount()).toBe(1);
      const loadMore = await screen.findByTestId('account-uploads-load-more');
      await act(async () => { fireEvent.click(loadMore); });
      await waitFor(() =>
        expect(document.body.textContent).toMatch(/PAGE2A001/),
      );
      // `onLoadMore` cleared the timer → no pending schedules.
      expect(pendingScheduledCount()).toBe(0);
      const countBefore = f.calls.filter(
        (c) => c.url.includes('/api/account/capsules') && c.method === 'GET',
      ).length;
      // Try firing any remaining scheduled refresh (there shouldn't
      // be one) — this proves the timer was cleared, not merely
      // deferred. A fresh fetch would show up as extra GET /capsules.
      await fireScheduledRefresh();
      const countAfter = f.calls.filter(
        (c) => c.url.includes('/api/account/capsules') && c.method === 'GET',
      ).length;
      expect(countAfter).toBe(countBefore);
    } finally {
      f.restore();
    }
  });

  it('3. onLoadMore clears pending-heal UI state for page-1 rows', async () => {
    const f = installFetch(({ url, method, cursor }) => {
      if (url.includes('/api/account/me')) return jsonResponse(defaultMe());
      if (url.includes('/api/account/capsules') && method === 'GET') {
        if (cursor) {
          return jsonResponse({
            capsules: [capsule('PAGE2A001')],
            hasMore: false,
            nextCursor: null,
            previewPending: [],
          });
        }
        return jsonResponse({
          capsules: [capsule('ABCD0001')],
          hasMore: true,
          nextCursor: 'CURSOR-ABCD',
          previewPending: ['ABCD0001'],
        });
      }
      return new Response('not mocked', { status: 500 });
    });
    try {
      await bootAccountApp();
      await waitFor(() =>
        expect(document.body.textContent).toMatch(/ABCD0001/),
      );
      // Row carries the shimmer class before Load more.
      const shellBefore = document.querySelector(
        '[data-share-code="ABCD0001"]',
      );
      expect(shellBefore).not.toBeNull();
      expect(
        shellBefore!.classList.contains('acct__upload-thumb-shell--pending'),
      ).toBe(true);

      const loadMore = await screen.findByTestId('account-uploads-load-more');
      await act(async () => { fireEvent.click(loadMore); });
      await waitFor(() =>
        expect(document.body.textContent).toMatch(/PAGE2A001/),
      );
      // After pagination, the page-1 row's shimmer is gone.
      const shellAfter = document.querySelector(
        '[data-share-code="ABCD0001"]',
      );
      expect(shellAfter).not.toBeNull();
      expect(
        shellAfter!.classList.contains('acct__upload-thumb-shell--pending'),
      ).toBe(false);
    } finally {
      f.restore();
    }
  });

  it('4. reload anti-race — only the latest reload commits', async () => {
    // Two synchronous Retry clicks inside a single `act()` block
    // issue two overlapping reloads. The first reload's response is
    // delayed (stalls on a pending Promise) AND returns the older
    // error payload; the second reload resolves immediately with a
    // success. Without the `reloadSeqRef` guard the delayed first
    // response would overwrite the committed-to-ready state when it
    // eventually landed. With the guard, the stale response is
    // dropped and the final state reflects the second reload.
    let meCall = 0;
    let resolveFirstRetryMe: ((r: Response) => void) | null = null;
    const f = installFetch(async ({ url, method }) => {
      if (url.includes('/api/account/me')) {
        meCall++;
        if (meCall === 1) {
          return new Response('nope', { status: 500 });
        }
        if (meCall === 2) {
          // First retry's me stalls until explicitly resolved later.
          return await new Promise<Response>((resolve) => {
            resolveFirstRetryMe = resolve;
          });
        }
        // Second retry: immediate success.
        return jsonResponse(defaultMe());
      }
      if (url.includes('/api/account/capsules') && method === 'GET') {
        return jsonResponse({
          capsules: [capsule('FINALWIN01')],
          hasMore: false,
          nextCursor: null,
          previewPending: [],
        });
      }
      return new Response('not mocked', { status: 500 });
    });
    try {
      await bootAccountApp();
      await waitFor(() =>
        expect(document.body.textContent).toMatch(/Could not load account/),
      );
      const retry = screen.getByRole('button', { name: /Retry/i });
      // Two synchronous clicks: both land on the error view's Retry
      // button before React commits the loading-state re-render, so
      // both invoke reload(). reloadSeqRef goes 1 → 2.
      await act(async () => {
        fireEvent.click(retry);
        fireEvent.click(retry);
      });
      // Allow the second reload (immediate) to resolve and commit.
      await waitFor(() =>
        expect(document.body.textContent).toMatch(/FINALWIN01/),
      );
      // Now resolve the FIRST retry's stalled me. If the sequence
      // guard works, this stale 500 response should NOT overwrite
      // the committed ready state back into error.
      resolveFirstRetryMe?.(new Response('nope-stale', { status: 500 }));
      // Give the stale-response handler a chance to (fail to) run.
      await new Promise((resolve) => setTimeout(resolve, 40));
      expect(document.body.textContent).toMatch(/FINALWIN01/);
      expect(document.body.textContent).not.toMatch(/Could not load account/);
    } finally {
      f.restore();
    }
  });

  it('8. onLoadMore suppresses auto-refresh BEFORE the page-2 await — timer during pagination cannot start a new page-1 fetch', async () => {
    // Regression guard for the "latch-after-await" race. The intent
    // invariant: once onLoadMore() fires, no new auto-refresh may
    // start for the rest of the session. The earlier implementation
    // only latched AFTER the page-2 response, so an 8 s timer that
    // fired during the (potentially slow) pagination request could
    // kick off a page-1 refetch whose response would collapse the
    // paginated state.
    let resolvePage2: ((r: Response) => void) | null = null;
    let page1CallsBeforePage2: number = 0;
    let page1CallsAfterLoadMoreClick = 0;
    let loadMoreClicked = false;
    const baselineFetch = installFetch(({ url, method, cursor }) => {
      if (url.includes('/api/account/me')) return jsonResponse(defaultMe());
      if (url.includes('/api/account/capsules') && method === 'GET') {
        if (cursor) {
          // Page-2 fetch stalls on demand so the 8 s timer has a
          // window to fire while pagination is in flight.
          return new Promise<Response>((resolve) => {
            resolvePage2 = resolve;
          });
        }
        if (loadMoreClicked) page1CallsAfterLoadMoreClick++;
        else page1CallsBeforePage2++;
        return jsonResponse({
          capsules: [capsule('ABCD0001')],
          hasMore: true,
          nextCursor: 'CURSOR-ABCD',
          previewPending: ['ABCD0001'],
        });
      }
      return new Response('not mocked', { status: 500 });
    });
    try {
      await bootAccountApp({ controlScheduler: true });
      await waitFor(() =>
        expect(document.body.textContent).toMatch(/ABCD0001/),
      );
      // Initial load scheduled the 8 s follow-up. Click Load more
      // BEFORE firing the scheduled refresh, so pagination is in
      // flight while the follow-up would be due. The latch-before-
      // await fix must clear this pending schedule synchronously.
      expect(pendingScheduledCount()).toBe(1);
      const loadMore = await screen.findByTestId('account-uploads-load-more');
      loadMoreClicked = true;
      await act(async () => { fireEvent.click(loadMore); });
      // Immediately after the click (before the page-2 await
      // resolves), the pending schedule MUST have been cleared.
      expect(pendingScheduledCount()).toBe(0);
      // Even if we try to fire anything that might still be
      // scheduled, no new page-1 fetch should occur.
      await fireScheduledRefresh();
      expect(page1CallsAfterLoadMoreClick).toBe(0);
      // Resolve pagination and confirm page 2 lands normally.
      resolvePage2?.(jsonResponse({
        capsules: [capsule('PAGE2A001')],
        hasMore: false,
        nextCursor: null,
        previewPending: [],
      }));
      await waitFor(() =>
        expect(document.body.textContent).toMatch(/PAGE2A001/),
      );
      // Still zero after pagination lands.
      expect(page1CallsAfterLoadMoreClick).toBe(0);
      expect(page1CallsBeforePage2).toBeGreaterThanOrEqual(1);
    } finally {
      baselineFetch.restore();
    }
  });

  it('9. failed Load more restores first-page convergence — shimmer returns, 8 s timer re-armed', async () => {
    // Regression guard for the restore-on-pagination-failure branch.
    // After `onLoadMore` latches auto-refresh OFF (pre-await), a
    // rejected page-2 fetch must roll back to the page-1 regime:
    // `hasLoadedMoreRef` unset, `pendingShareCodes` restored, the
    // 8 s follow-up timer re-armed. Without this, a user who hits a
    // transient network blip on Load more is silently stuck with
    // convergence permanently disabled for the rest of their session.
    let page1CallsAfterFailure = 0;
    let pagination2Rejected = false;
    const f = installFetch(({ url, method, cursor }) => {
      if (url.includes('/api/account/me')) return jsonResponse(defaultMe());
      if (url.includes('/api/account/capsules') && method === 'GET') {
        if (cursor) {
          // Reject the pagination fetch.
          pagination2Rejected = true;
          return Promise.reject(new Error('network: page-2 blew up'));
        }
        if (pagination2Rejected) page1CallsAfterFailure++;
        return jsonResponse({
          capsules: [capsule('ABCD0001')],
          hasMore: true,
          nextCursor: 'CURSOR-ABCD',
          previewPending: ['ABCD0001'],
        });
      }
      return new Response('not mocked', { status: 500 });
    });
    try {
      await bootAccountApp({ controlScheduler: true });
      await waitFor(() =>
        expect(document.body.textContent).toMatch(/ABCD0001/),
      );
      // Pre-condition: shimmer present on page-1 row + 8 s timer armed.
      {
        const shell = document.querySelector('[data-share-code="ABCD0001"]');
        expect(
          shell?.classList.contains('acct__upload-thumb-shell--pending'),
        ).toBe(true);
      }
      expect(pendingScheduledCount()).toBe(1);
      // Click Load more — pagination will reject.
      const loadMore = await screen.findByTestId('account-uploads-load-more');
      await act(async () => { fireEvent.click(loadMore); });
      await waitFor(() =>
        expect(document.body.textContent).toMatch(/network: page-2 blew up/),
      );
      // Shimmer restored on ABCD0001 — convergence intent back in force.
      {
        const shell = document.querySelector('[data-share-code="ABCD0001"]');
        expect(shell).not.toBeNull();
        expect(
          shell?.classList.contains('acct__upload-thumb-shell--pending'),
        ).toBe(true);
      }
      // Page 1 content intact.
      expect(document.body.textContent).toMatch(/ABCD0001/);
      // A fresh 8 s timer has been armed by the restore path. Fire
      // it and confirm a page-1 refresh goes out — proves
      // convergence is not permanently disabled.
      expect(pendingScheduledCount()).toBe(1);
      const before = page1CallsAfterFailure;
      await fireScheduledRefresh();
      await waitFor(() => expect(page1CallsAfterFailure).toBeGreaterThan(before));
    } finally {
      f.restore();
    }
  });

  it('6. onLoadMore aborts an in-flight doRefresh to prevent pagination collapse', async () => {
    // Correctness regression: before the abort was added, a doRefresh
    // fetch that passed its `hasLoadedMoreRef` gate but was still
    // awaiting the server could resolve AFTER onLoadMore committed
    // page-2 state, overwriting `capsules` back to the page-1 list.
    // We detect the abort by inspecting whether the doRefresh fetch's
    // signal is aborted at onLoadMore time.
    let resolvePage1Refresh: ((r: Response) => void) | null = null;
    const abortObservations: boolean[] = [];
    const f = installFetch(({ url, method, cursor }) => {
      if (url.includes('/api/account/me')) return jsonResponse(defaultMe());
      if (url.includes('/api/account/capsules') && method === 'GET') {
        if (cursor) {
          return jsonResponse({
            capsules: [capsule('PAGE2A001')],
            hasMore: false,
            nextCursor: null,
            previewPending: [],
          });
        }
        // Record the index of this page-1 call. Third page-1 call
        // (post-timer doRefresh) stalls until we resolve it.
        return jsonResponse({
          capsules: [capsule('ABCD0001')],
          hasMore: true,
          nextCursor: 'CURSOR-ABCD',
          previewPending: ['ABCD0001'],
        });
      }
      return new Response('not mocked', { status: 500 });
    });
    // Override fetch to stall a SECOND page-1 call on demand — this
    // simulates a slow doRefresh that hasn't resolved yet when the
    // user clicks Load more.
    const fetchStub = globalThis.fetch;
    let page1Count = 0;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const urlStr = typeof input === 'string' ? input : input.toString();
      const parsed = new URL(urlStr, 'https://x.test');
      const method = (init?.method ?? 'GET').toUpperCase();
      const cursor = parsed.searchParams.get('cursor');
      if (urlStr.includes('/api/account/capsules') && method === 'GET' && !cursor) {
        page1Count++;
        if (page1Count === 2) {
          // Capture the signal for later assertion.
          const signal = init?.signal;
          return await new Promise<Response>((resolve) => {
            resolvePage1Refresh = (r) => {
              abortObservations.push(signal?.aborted ?? false);
              resolve(r);
            };
          });
        }
      }
      return fetchStub(input, init);
    }) as typeof fetch;
    try {
      await bootAccountApp({ controlScheduler: true });
      await waitFor(() =>
        expect(document.body.textContent).toMatch(/ABCD0001/),
      );
      // Initial load armed the 8 s follow-up. Fire it synchronously
      // via the controlled scheduler — doRefresh starts its fetch,
      // which stalls on our override. refreshInFlightRef.current now
      // points to the stalled ctrl.
      expect(pendingScheduledCount()).toBe(1);
      await fireScheduledRefresh();
      await waitFor(() => expect(page1Count).toBeGreaterThanOrEqual(2));
      // While the doRefresh fetch is stalled, click Load more.
      // onLoadMore must abort the in-flight refresh BEFORE awaiting
      // the page-2 fetch.
      const loadMore = await screen.findByTestId('account-uploads-load-more');
      await act(async () => { fireEvent.click(loadMore); });
      await waitFor(() =>
        expect(document.body.textContent).toMatch(/PAGE2A001/),
      );
      // Resolve the stalled refresh — by the time resolve runs,
      // signal.aborted must be true (observed via the mock).
      resolvePage1Refresh?.(jsonResponse({
        capsules: [capsule('ABCD0001')],
        hasMore: true,
        nextCursor: 'CURSOR-ABCD',
        previewPending: [],
      }));
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(abortObservations[0]).toBe(true);
      expect(document.body.textContent).toMatch(/PAGE2A001/);
    } finally {
      globalThis.fetch = fetchStub;
      f.restore();
    }
  });

  it('7. post-delete refreshCapsules resets hasLoadedMoreRef (auto-refresh re-enabled)', async () => {
    // Regression target: `refreshCapsules` must reset
    // `hasLoadedMoreRef.current = false` so that after a delete, the
    // user is back on page 1 and auto-refresh convergence is valid
    // again. A regression that removed that line would leave the
    // post-delete page silently without the follow-up loop even
    // when `previewPending` carries work.
    const shareCode = 'DELETE0001';
    let capsuleCall = 0;
    const f = installFetch(({ url, method, cursor }) => {
      if (url.includes('/api/account/me')) return jsonResponse(defaultMe());
      if (url.includes(`/api/account/capsules/${shareCode}`) && method === 'DELETE') {
        return new Response(
          JSON.stringify({ shareId: 'id-1', shareCode, alreadyDeleted: false, r2Deleted: true }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (url.includes('/api/account/capsules') && method === 'GET') {
        if (cursor) {
          return jsonResponse({
            capsules: [capsule('PAGE2XYZ')],
            hasMore: false,
            nextCursor: null,
            previewPending: [],
          });
        }
        capsuleCall++;
        if (capsuleCall === 1) {
          return jsonResponse({
            capsules: [capsule(shareCode)],
            hasMore: true,
            nextCursor: 'CURSOR-1',
            previewPending: [],
          });
        }
        // Post-delete refresh: previewPending must re-arm the timer
        // only if hasLoadedMoreRef was reset.
        return jsonResponse({
          capsules: [capsule('OTHER0001')],
          hasMore: false,
          nextCursor: null,
          previewPending: ['OTHER0001'],
        });
      }
      return new Response('not mocked', { status: 500 });
    });
    vi.stubGlobal('confirm', () => true);
    try {
      await bootAccountApp({ controlScheduler: true });
      await waitFor(() =>
        expect(document.body.textContent).toMatch(new RegExp(shareCode)),
      );
      // Click Load more to set hasLoadedMoreRef.current = true.
      const loadMore = await screen.findByTestId('account-uploads-load-more');
      await act(async () => { fireEvent.click(loadMore); });
      await waitFor(() =>
        expect(document.body.textContent).toMatch(/PAGE2XYZ/),
      );
      // Delete the row. refreshCapsules resets hasLoadedMoreRef AND
      // arms a fresh 8 s follow-up since the response carries
      // previewPending=['OTHER0001'].
      const btns = screen.getAllByRole('button');
      const deleteBtn = btns.find((b) =>
        b.getAttribute('aria-label')?.includes('Delete') && b.textContent === 'Delete',
      );
      expect(deleteBtn).toBeDefined();
      await act(async () => { fireEvent.click(deleteBtn!); });
      await waitFor(() => {
        const reconciliationCalls = f.calls.filter(
          (c) => c.url.includes('/api/account/capsules')
            && c.method === 'GET'
            && c.cursor === null,
        );
        expect(reconciliationCalls.length).toBeGreaterThanOrEqual(2);
      });
      // Fire the armed follow-up. A page-1 fetch MUST go out —
      // that's what proves `hasLoadedMoreRef` was reset.
      expect(pendingScheduledCount()).toBe(1);
      const before = f.calls.filter(
        (c) => c.url.includes('/api/account/capsules') && c.method === 'GET',
      ).length;
      await fireScheduledRefresh();
      await waitFor(() => {
        const after = f.calls.filter(
          (c) => c.url.includes('/api/account/capsules') && c.method === 'GET',
        ).length;
        expect(after).toBeGreaterThan(before);
      });
    } finally {
      f.restore();
      vi.unstubAllGlobals();
    }
  });

  it('10. Copy-link surfaces a failure banner when clipboard.writeText rejects', async () => {
    // Regression guard for SFH #2: the original implementation did
    // not await the clipboard Promise, so a denied-permission
    // rejection produced an unhandled rejection while the banner
    // cheerfully reported "Link copied to clipboard." Now the
    // failure path explicitly surfaces a distinct banner.
    const f = installFetch(({ url, method }) => {
      if (url.includes('/api/account/me')) return jsonResponse(defaultMe());
      if (url.includes('/api/account/capsules') && method === 'GET') {
        return jsonResponse({
          capsules: [capsule('CPCAP0001')],
          hasMore: false,
          nextCursor: null,
          previewPending: [],
        });
      }
      return new Response('not mocked', { status: 500 });
    });
    const originalClipboard = navigator.clipboard;
    Object.defineProperty(navigator, 'clipboard', {
      value: {
        writeText: vi.fn(() => Promise.reject(new Error('permission denied'))),
      },
      configurable: true,
    });
    try {
      await bootAccountApp();
      await waitFor(() =>
        expect(document.body.textContent).toMatch(/CPCAP0001/),
      );
      const copyBtn = screen.getByRole('button', {
        name: /Copy share link for CPCAP0001/i,
      });
      await act(async () => { fireEvent.click(copyBtn); });
      await waitFor(() =>
        expect(document.body.textContent).toMatch(
          /Could not copy link — your browser blocked clipboard access\./,
        ),
      );
    } finally {
      Object.defineProperty(navigator, 'clipboard', {
        value: originalClipboard,
        configurable: true,
      });
      f.restore();
    }
  });

  it('5. post-delete refresh restarts the 8 s follow-up when previewPending', async () => {
    const shareCode = 'DELETE0001';
    let capsuleCall = 0;
    const f = installFetch(({ url, method }) => {
      if (url.includes('/api/account/me')) return jsonResponse(defaultMe());
      if (url.includes(`/api/account/capsules/${shareCode}`) && method === 'DELETE') {
        return new Response(
          JSON.stringify({ shareId: 'id-1', shareCode, alreadyDeleted: false, r2Deleted: true }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (url.includes('/api/account/capsules') && method === 'GET') {
        capsuleCall++;
        if (capsuleCall === 1) {
          // Initial load — no pending.
          return jsonResponse({
            capsules: [capsule(shareCode), capsule('OTHER0001')],
            hasMore: false,
            nextCursor: null,
            previewPending: [],
          });
        }
        if (capsuleCall === 2) {
          // Post-delete reconciliation: delete succeeded AND reports
          // OTHER0001 is now being rebaked. This must restart the
          // 8 s follow-up loop.
          return jsonResponse({
            capsules: [capsule('OTHER0001')],
            hasMore: false,
            nextCursor: null,
            previewPending: ['OTHER0001'],
          });
        }
        return jsonResponse({
          capsules: [capsule('OTHER0001')],
          hasMore: false,
          nextCursor: null,
          previewPending: [],
        });
      }
      return new Response('not mocked', { status: 500 });
    });
    vi.stubGlobal('confirm', () => true);
    try {
      await bootAccountApp({ controlScheduler: true });
      await waitFor(() =>
        expect(document.body.textContent).toMatch(new RegExp(shareCode)),
      );
      const btns = screen.getAllByRole('button');
      const deleteBtn = btns.find((b) =>
        b.getAttribute('aria-label')?.includes('Delete') && b.textContent === 'Delete',
      );
      expect(deleteBtn).toBeDefined();
      await act(async () => { fireEvent.click(deleteBtn!); });
      await waitFor(() => {
        const calls = f.calls.filter(
          (c) => c.url.includes('/api/account/capsules')
            && c.method === 'GET'
            && c.cursor === null,
        );
        expect(calls.length).toBeGreaterThanOrEqual(2);
      });
      const reconciliationCount = f.calls.filter(
        (c) => c.url.includes('/api/account/capsules') && c.method === 'GET',
      ).length;
      // The post-delete response carried previewPending=['OTHER0001']
      // so refreshCapsules scheduled a fresh 8 s follow-up. Fire it.
      expect(pendingScheduledCount()).toBe(1);
      await fireScheduledRefresh();
      await waitFor(() => {
        const later = f.calls.filter(
          (c) => c.url.includes('/api/account/capsules') && c.method === 'GET',
        ).length;
        expect(later).toBeGreaterThan(reconciliationCount);
      });
    } finally {
      f.restore();
      vi.unstubAllGlobals();
    }
  });
});
