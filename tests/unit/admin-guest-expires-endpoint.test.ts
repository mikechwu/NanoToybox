/**
 * Handler-level tests for functions/api/admin/sweep/guest-expires.ts.
 *
 * Covers the cron-invoked sweep: selects expired guest rows, routes
 * each through the shared `deleteCapsule` core with actor='cron', and
 * returns the summary envelope that the cron-sweeper Worker expects.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { onRequestPost } from '../../functions/api/admin/sweep/guest-expires';
import type { Env } from '../../functions/env';

const deleteMock = vi.hoisted(() =>
  vi.fn<() => Promise<{ alreadyDeleted: boolean; r2Deleted: boolean; r2Error?: string; shareId: string; shareCode: string } | null>>(),
);
vi.mock('../../src/share/capsule-delete', async () => {
  const actual = await vi.importActual<typeof import('../../src/share/capsule-delete')>(
    '../../src/share/capsule-delete',
  );
  return { ...actual, deleteCapsule: (...args: unknown[]) => deleteMock(...args as []) };
});

// ── D1 stub that returns a configurable list of expired guest rows ──

interface ExpiredRow {
  share_code: string;
  id: string;
  expires_at: string | null;
}

function makeEnv(rows: ExpiredRow[]): Env {
  const env = {
    DB: {
      prepare: () => ({
        bind: () => ({
          async all() { return { success: true, results: rows }; },
          async first() { return null; },
          async run() { return { success: true }; },
        }),
      }),
    } as unknown as Env['DB'],
    R2_BUCKET: undefined as unknown as Env['R2_BUCKET'],
    CRON_SECRET: 'admin-token',
  } as Env;
  return env;
}

function makeRequest(secret = 'admin-token'): Request {
  return new Request('http://localhost/api/admin/sweep/guest-expires', {
    method: 'POST',
    headers: { 'X-Cron-Secret': secret },
  });
}

function makeContext(request: Request, env: Env) {
  return { request, env } as unknown as Parameters<typeof onRequestPost>[0];
}

describe('POST /api/admin/sweep/guest-expires', () => {
  beforeEach(() => { deleteMock.mockReset(); });

  it('returns 404 on wrong X-Cron-Secret (admin gate)', async () => {
    const env = makeEnv([]);
    const res = await onRequestPost(makeContext(makeRequest('wrong'), env));
    expect(res.status).toBe(404);
    expect(deleteMock).not.toHaveBeenCalled();
  });

  it('returns ok summary with zero scanned when no rows are expired', async () => {
    const env = makeEnv([]);
    const res = await onRequestPost(makeContext(makeRequest(), env));
    expect(res.status).toBe(200);
    const body = await res.json() as {
      ok: boolean; scanned: number; deleted: number; failed: number;
    };
    expect(body).toEqual({ ok: true, scanned: 0, deleted: 0, failed: 0, failedDetails: [] });
  });

  it('routes each expired row through deleteCapsule with actor="cron"', async () => {
    const rows: ExpiredRow[] = [
      { share_code: 'G1', id: 'id-g1', expires_at: '2026-04-20T00:00:00.000Z' },
      { share_code: 'G2', id: 'id-g2', expires_at: '2026-04-21T00:00:00.000Z' },
    ];
    const env = makeEnv(rows);
    deleteMock.mockResolvedValue({
      alreadyDeleted: false, r2Deleted: true, shareId: 'x', shareCode: 'y',
    });
    const res = await onRequestPost(makeContext(makeRequest(), env));
    expect(res.status).toBe(200);
    expect(deleteMock).toHaveBeenCalledTimes(2);
    // Each invocation passes actor='cron', userId=null, reason='guest_expired'.
    for (const call of deleteMock.mock.calls) {
      const opts = call[2] as Record<string, unknown>;
      expect(opts.actor).toBe('cron');
      expect(opts.userId).toBeNull();
      expect(opts.reason).toBe('guest_expired');
    }
    const body = await res.json() as { scanned: number; deleted: number; failed: number };
    expect(body.scanned).toBe(2);
    expect(body.deleted).toBe(2);
    expect(body.failed).toBe(0);
  });

  it('reports R2-delete failures in the summary without aborting the sweep', async () => {
    const rows: ExpiredRow[] = [
      { share_code: 'G1', id: 'id-g1', expires_at: '2026-04-20T00:00:00.000Z' },
      { share_code: 'G2', id: 'id-g2', expires_at: '2026-04-21T00:00:00.000Z' },
    ];
    const env = makeEnv(rows);
    deleteMock
      .mockResolvedValueOnce({ alreadyDeleted: false, r2Deleted: false, r2Error: 'r2 boom', shareId: 'x', shareCode: 'G1' })
      .mockResolvedValueOnce({ alreadyDeleted: false, r2Deleted: true, shareId: 'x', shareCode: 'G2' });
    const res = await onRequestPost(makeContext(makeRequest(), env));
    expect(res.status).toBe(200);
    const body = await res.json() as {
      scanned: number; deleted: number; failed: number;
      failedDetails: Array<{ shareCode: string; reason: string }>;
    };
    expect(body.scanned).toBe(2);
    expect(body.deleted).toBe(1);
    expect(body.failed).toBe(1);
    expect(body.failedDetails[0]).toMatchObject({ shareCode: 'G1' });
  });

  it('still returns a summary (does not 404) when no rows match — covers flag-off tail case', async () => {
    // Even with GUEST_PUBLISH_ENABLED absent, the endpoint must return a
    // normal sweep envelope, not a 404. A 404 would turn a benign
    // "nothing to clean up" state into a cron-sweeper retry storm.
    const env = makeEnv([]);
    delete (env as unknown as Record<string, unknown>).GUEST_PUBLISH_ENABLED;
    const res = await onRequestPost(makeContext(makeRequest(), env));
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean };
    expect(body.ok).toBe(true);
  });
});
