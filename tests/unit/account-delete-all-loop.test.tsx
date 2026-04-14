/**
 * @vitest-environment jsdom
 */
/**
 * Regression: the Account page's bulk-delete loop must distinguish
 * "drained" (server reported `moreAvailable: false`) from "client-side
 * cap reached" (loop exited at MAX_BATCHES while server was still
 * reporting `moreAvailable: true`). A success-style summary on cap-hit
 * silently misleads power users into thinking destructive cleanup
 * finished when it did not.
 *
 * We import the AccountApp component dynamically because the source
 * also boots a `createRoot` at module top — guarded by the existence
 * of `#account-root`, so tests are safe — but we still want to render
 * via Testing Library against our own DOM root.
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, screen, act, fireEvent, waitFor } from '@testing-library/react';

// Account page main module exports nothing — it boots on import. We
// re-implement a tiny harness around AccountApp by importing it
// indirectly through a per-test fetch mock + DOM render. Easier: just
// dynamic-import after stubbing fetch.

interface DeleteAllResponse {
  totalAttempted: number;
  succeeded: number;
  failed: unknown[];
  moreAvailable?: boolean;
}

function stubFetch(deleteAllResponses: DeleteAllResponse[]) {
  let deleteCallIndex = 0;
  return vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('/api/account/me')) {
      return new Response(
        JSON.stringify({
          userId: 'user-1',
          displayName: 'Test User',
          createdAt: '2026-01-01T00:00:00Z',
          provider: 'google',
          ageConfirmedAt: '2026-04-14T00:00:00Z',
          policyVersion: '2026-04-14.2',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    if (url.includes('/api/account/capsules') && !url.includes('delete-all')) {
      // Single fake capsule so the Delete-all button enables.
      return new Response(
        JSON.stringify({
          capsules: [
            {
              shareCode: 'AAA',
              createdAt: '2026-04-14T10:00:00Z',
              sizeBytes: 1,
              frameCount: 0,
              atomCount: 0,
              title: null,
              kind: 'snapshot',
              status: 'ready',
              previewStatus: 'none',
            },
          ],
          pageSize: 50,
          hasMore: false,
          nextCursor: null,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    if (url.includes('/api/account/capsules/delete-all')) {
      const payload =
        deleteAllResponses[deleteCallIndex] ??
        deleteAllResponses[deleteAllResponses.length - 1];
      deleteCallIndex++;
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response('not mocked', { status: 500 });
  }) as unknown as typeof fetch;
}

async function bootAccountApp() {
  // The account/main.tsx module boots a createRoot when it sees
  // #account-root. We render under a known div, but the module also
  // mounts unconditionally on import — that's fine, both mounts happen
  // in our jsdom and Testing Library's `render` returns the second.
  const root = document.createElement('div');
  root.id = 'account-root';
  document.body.appendChild(root);
  // Force a fresh module evaluation in case the import is cached
  // across tests (each test sets its own fetch mock first).
  const mod = await import('../../account/main');
  // The module's default export is the React tree; but it actually
  // mounts side-effectfully. The mounted DOM is enough for assertions.
  return mod;
}

beforeEach(() => {
  document.body.innerHTML = '';
  vi.resetModules();
});

afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
});

describe('Account page — bulk delete loop cap-hit reporting', () => {
  it('renders the success summary when the server drains naturally', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = stubFetch([
      { totalAttempted: 5, succeeded: 5, failed: [], moreAvailable: false },
    ]);
    try {
      await bootAccountApp();
      // Open the confirm panel and click "Yes, delete all".
      await waitFor(() =>
        expect(screen.getByText(/Delete all uploaded capsules/i)).toBeTruthy(),
      );
      act(() => {
        fireEvent.click(screen.getByText(/Delete all uploaded capsules/i));
      });
      const confirm = await screen.findByTestId('account-delete-all-confirm');
      act(() => { fireEvent.click(confirm); });

      // Banner reports drained-style summary.
      await waitFor(() =>
        expect(document.body.textContent ?? '').toMatch(/Deleted 5 of 5/),
      );
      // No "Continue deleting" button.
      expect(screen.queryByText(/Continue deleting/i)).toBeNull();
    } finally {
      globalThis.fetch = original;
    }
  });

  it('reports cap-hit + offers Continue when 100th batch still has moreAvailable=true', async () => {
    const original = globalThis.fetch;
    // Every call returns moreAvailable:true so the loop hits MAX_BATCHES.
    globalThis.fetch = stubFetch([
      { totalAttempted: 200, succeeded: 200, failed: [], moreAvailable: true },
    ]);
    try {
      await bootAccountApp();
      await waitFor(() =>
        expect(screen.getByText(/Delete all uploaded capsules/i)).toBeTruthy(),
      );
      act(() => {
        fireEvent.click(screen.getByText(/Delete all uploaded capsules/i));
      });
      const confirm = await screen.findByTestId('account-delete-all-confirm');
      act(() => { fireEvent.click(confirm); });

      // Wait for the loop to run all 100 batches — they're synchronous
      // microtasks inside the mock, but React state updates batch.
      await waitFor(
        () => expect(document.body.textContent ?? '').toMatch(/More uploads remain/),
        { timeout: 10000 },
      );
      // The confirm button label flips to "Continue deleting"; we check
      // the testid (the same string also appears verbatim inside the
      // banner copy, which would make a getByText match ambiguous).
      expect(screen.getByTestId('account-delete-all-confirm').textContent).toMatch(/Continue deleting/);
      // Stop button replaces Cancel when the cap was hit. There is only
      // one button labelled exactly "Stop".
      expect(screen.getAllByRole('button').some((b) => b.textContent === 'Stop')).toBe(true);
      // The banner does NOT pretend the action completed.
      expect(document.body.textContent ?? '').not.toMatch(/Deleted 20000 of 20000\./);
    } finally {
      globalThis.fetch = original;
    }
  }, 30000);
});
