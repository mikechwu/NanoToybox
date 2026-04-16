/**
 * @vitest-environment jsdom
 */
/**
 * Account page single-delete state machine tests.
 *
 * Locks the five truth-table branches from the capsule-delete
 * incident plan:
 *   - DELETE 200 + row absent → success
 *   - DELETE 500 + row absent → partial-success
 *   - DELETE 200 + refresh failed → unverified
 *   - DELETE 500 + refresh failed → failure + unrefreshed
 *   - DELETE 200 + row present → anomaly
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, screen, act, fireEvent, waitFor } from '@testing-library/react';

const CAPSULE_CODE = 'TESTCODE1234';

function makeCapsule(code = CAPSULE_CODE) {
  return {
    shareCode: code,
    createdAt: '2026-04-14T10:00:00Z',
    sizeBytes: 1024,
    frameCount: 10,
    atomCount: 4,
    title: null,
    kind: 'capsule',
    status: 'ready',
    previewStatus: 'none',
  };
}

function stubFetch(opts: {
  deleteStatus?: number;
  refreshReturns?: 'empty' | 'with-capsule' | 'error';
}) {
  const { deleteStatus = 200, refreshReturns = 'empty' } = opts;
  let capsuleListCallCount = 0;
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();

    if (url.includes('/api/account/me')) {
      return new Response(JSON.stringify({
        userId: 'user-1', displayName: 'Test', createdAt: '2026-01-01T00:00:00Z',
        provider: 'google', ageConfirmedAt: '2026-04-14T00:00:00Z', policyVersion: '2026-04-14.2',
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    if (url.includes(`/api/account/capsules/${CAPSULE_CODE}`) && init?.method === 'DELETE') {
      return new Response(
        deleteStatus < 400
          ? JSON.stringify({ shareId: 'id-1', shareCode: CAPSULE_CODE, alreadyDeleted: false, r2Deleted: true })
          : 'Internal Server Error',
        { status: deleteStatus },
      );
    }

    if (url.includes('/api/account/capsules')) {
      capsuleListCallCount++;
      if (capsuleListCallCount === 1) {
        // Initial load — always return the capsule.
        return new Response(JSON.stringify({
          capsules: [makeCapsule()], hasMore: false, nextCursor: null,
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      // Reconciliation fetch — controlled by opts.
      if (refreshReturns === 'error') {
        return new Response('Service Unavailable', { status: 503 });
      }
      if (refreshReturns === 'empty') {
        return new Response(JSON.stringify({
          capsules: [], hasMore: false, nextCursor: null,
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      // 'with-capsule' — row still present after reconciliation.
      return new Response(JSON.stringify({
        capsules: [makeCapsule()], hasMore: false, nextCursor: null,
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    return new Response('not mocked', { status: 500 });
  }) as unknown as typeof fetch;
}

async function bootAccountApp() {
  const root = document.createElement('div');
  root.id = 'account-root';
  document.body.appendChild(root);
  await import('../../account/main');
}

async function clickDeleteOnCapsule() {
  vi.stubGlobal('confirm', () => true);
  // Wait for the page to reach ready state with the capsule list.
  await waitFor(() =>
    expect(document.body.textContent).toMatch(new RegExp(CAPSULE_CODE)),
  );
  // Find the delete button for our capsule by aria-label pattern.
  const btns = screen.getAllByRole('button');
  const deleteBtn = btns.find(b =>
    b.getAttribute('aria-label')?.includes('Delete') && b.textContent === 'Delete',
  );
  expect(deleteBtn).toBeDefined();
  act(() => { fireEvent.click(deleteBtn!); });
}

beforeEach(() => {
  document.body.innerHTML = '';
  vi.resetModules();
});

afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
});

describe('Account page — single-delete state machine', () => {
  it('DELETE 200 + row absent → "Deleted" success banner', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = stubFetch({ deleteStatus: 200, refreshReturns: 'empty' });
    try {
      await bootAccountApp();
      await clickDeleteOnCapsule();
      await waitFor(() =>
        expect(document.body.textContent).toMatch(new RegExp(`Deleted ${CAPSULE_CODE}`)),
      );
    } finally { globalThis.fetch = original; }
  });

  it('DELETE 500 + row absent → partial-success banner', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = stubFetch({ deleteStatus: 500, refreshReturns: 'empty' });
    try {
      await bootAccountApp();
      await clickDeleteOnCapsule();
      await waitFor(() =>
        expect(document.body.textContent).toMatch(/may have completed despite a server error/i),
      );
    } finally { globalThis.fetch = original; }
  });

  it('DELETE 200 + refresh failed → unverified banner', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = stubFetch({ deleteStatus: 200, refreshReturns: 'error' });
    try {
      await bootAccountApp();
      await clickDeleteOnCapsule();
      await waitFor(() =>
        expect(document.body.textContent).toMatch(/could not be refreshed.*reload to confirm/i),
      );
    } finally { globalThis.fetch = original; }
  });

  it('DELETE 500 + refresh failed → failure + unrefreshed banner', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = stubFetch({ deleteStatus: 500, refreshReturns: 'error' });
    try {
      await bootAccountApp();
      await clickDeleteOnCapsule();
      await waitFor(() => {
        const text = document.body.textContent ?? '';
        expect(text).toMatch(/Delete failed.*500/i);
        expect(text).toMatch(/could not be refreshed/i);
      });
    } finally { globalThis.fetch = original; }
  });

  it('DELETE 200 + row still present → anomaly banner', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = stubFetch({ deleteStatus: 200, refreshReturns: 'with-capsule' });
    try {
      await bootAccountApp();
      await clickDeleteOnCapsule();
      await waitFor(() =>
        expect(document.body.textContent).toMatch(/reported success but the capsule is still listed/i),
      );
    } finally { globalThis.fetch = original; }
  });
});
