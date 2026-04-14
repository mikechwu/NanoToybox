/**
 * Tests for functions/api/account/delete.ts — authoritative cascade.
 *
 * Covers:
 *   - 401 when unauthenticated.
 *   - Cascade runs in order: sessions → quota → capsules → oauth → users tombstone.
 *   - Capsules invoke the shared delete core with actor='owner', reason='account_delete_cascade'.
 *   - Emits a single `account_delete` audit event with a summary.
 *   - Clears the session cookie on success.
 *   - Partial capsule failure surfaces in the response without rolling back earlier steps.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { onRequestPost } from '../../functions/api/account/delete';
import type { Env } from '../../functions/env';

const authMock = vi.hoisted(() => vi.fn<(...args: unknown[]) => Promise<string | null>>());
vi.mock('../../functions/auth-middleware', async () => {
  const actual = await vi.importActual<typeof import('../../functions/auth-middleware')>(
    '../../functions/auth-middleware',
  );
  return { ...actual, authenticateRequest: (...args: unknown[]) => authMock(...args) };
});

const deleteMock = vi.hoisted(() => vi.fn());
vi.mock('../../src/share/capsule-delete', () => ({
  deleteCapsule: (...args: unknown[]) => deleteMock(...args),
}));

const recordMock = vi.hoisted(() => vi.fn<(...args: unknown[]) => Promise<string>>());
vi.mock('../../src/share/audit', async () => {
  const actual = await vi.importActual<typeof import('../../src/share/audit')>('../../src/share/audit');
  return { ...actual, recordAuditEvent: (...args: unknown[]) => recordMock(...args) };
});

function makeDb(ownedCodes: string[]) {
  const sqls: string[] = [];
  const prepare = (sql: string) => ({
    _binds: [] as unknown[],
    bind(...v: unknown[]) { this._binds = v; return this; },
    async run() { sqls.push(sql); return { success: true }; },
    async first<T = unknown>(): Promise<T | null> { sqls.push(sql); return null; },
    async all<T = unknown>() {
      sqls.push(sql);
      return {
        success: true,
        results: ownedCodes.map((c) => ({ share_code: c })) as unknown as T[],
      };
    },
  });
  return {
    db: { prepare, async batch() { return []; } } as unknown as Env['DB'],
    sqls,
  };
}

function makeContext(args: { userId: string | null; ownedCodes?: string[] }) {
  const { db, sqls } = makeDb(args.ownedCodes ?? []);
  const request = new Request('https://example.test/api/account/delete', {
    method: 'POST',
  });
  const env = { DB: db } as unknown as Env;
  return { ctx: { request, env } as unknown as Parameters<typeof onRequestPost>[0], sqls };
}

beforeEach(() => {
  authMock.mockReset();
  deleteMock.mockReset();
  recordMock.mockReset();
  recordMock.mockResolvedValue('audit-id');
});

describe('/api/account/delete', () => {
  it('401 when signed-out', async () => {
    authMock.mockResolvedValue(null);
    const { ctx } = makeContext({ userId: null });
    const res = await onRequestPost(ctx);
    expect(res.status).toBe(401);
  });

  it('runs the cascade in plan order', async () => {
    authMock.mockResolvedValue('user-1');
    deleteMock.mockResolvedValue({ r2Deleted: true });
    const { ctx, sqls } = makeContext({ userId: 'user-1', ownedCodes: ['AAA', 'BBB'] });
    const res = await onRequestPost(ctx);
    expect(res.status).toBe(200);
    const idxSessions = sqls.findIndex((s) => s.includes('DELETE FROM sessions'));
    const idxQuota = sqls.findIndex((s) => s.includes('DELETE FROM publish_quota_window'));
    const idxOauth = sqls.findIndex((s) => s.includes('DELETE FROM oauth_accounts'));
    const idxTombstone = sqls.findIndex((s) => s.includes('UPDATE users') && s.includes('deleted_at'));
    // Each step must run.
    expect(idxSessions).toBeGreaterThanOrEqual(0);
    expect(idxQuota).toBeGreaterThanOrEqual(0);
    expect(idxOauth).toBeGreaterThanOrEqual(0);
    expect(idxTombstone).toBeGreaterThanOrEqual(0);
    // Ordering: sessions + quota before oauth + tombstone.
    expect(idxSessions).toBeLessThan(idxOauth);
    expect(idxQuota).toBeLessThan(idxOauth);
    expect(idxOauth).toBeLessThan(idxTombstone);
    // Shared delete core invoked once per owned capsule with cascade reason.
    expect(deleteMock).toHaveBeenCalledTimes(2);
    const firstCapsuleOpts = deleteMock.mock.calls[0][2] as Record<string, unknown>;
    expect(firstCapsuleOpts.actor).toBe('owner');
    expect(firstCapsuleOpts.userId).toBe('user-1');
    expect(firstCapsuleOpts.reason).toBe('account_delete_cascade');
    // One account_delete audit event with details.
    expect(recordMock).toHaveBeenCalledTimes(1);
    const input = recordMock.mock.calls[0][1] as Record<string, unknown>;
    expect(input.eventType).toBe('account_delete');
    expect((input.details as Record<string, unknown>).capsuleCount).toBe(2);
    expect((input.details as Record<string, unknown>).succeeded).toBe(2);
    // Cookie-clear header is appended.
    expect(res.headers.get('Set-Cookie') ?? '').toMatch(/Max-Age=0/i);
  });

  it('returns ok:false when the account_delete audit write itself throws (no silent success)', async () => {
    authMock.mockResolvedValue('user-1');
    deleteMock.mockResolvedValue({ r2Deleted: true });
    // Audit insert throws — the rest of the cascade still ran, but the
    // chain-of-custody record is missing. The response MUST flag this
    // as a failure (`ok: false`) and surface it in `steps.audit`.
    recordMock.mockRejectedValueOnce(new Error('d1 audit down'));
    const { ctx } = makeContext({ userId: 'user-1', ownedCodes: [] });
    const res = await onRequestPost(ctx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; steps: Record<string, string> };
    expect(body.ok).toBe(false);
    expect(body.steps.audit).toMatch(/d1 audit down/);
    // The pre-audit steps are still recorded as ok.
    expect(body.steps.sessions).toBe('ok');
    expect(body.steps.user).toBe('ok');
  });

  it('partial capsule failure surfaces without rolling back earlier steps', async () => {
    authMock.mockResolvedValue('user-1');
    // First capsule R2-fails; second succeeds.
    deleteMock
      .mockResolvedValueOnce({ r2Deleted: false, r2Error: 'r2 boom' })
      .mockResolvedValueOnce({ r2Deleted: true });
    const { ctx } = makeContext({ userId: 'user-1', ownedCodes: ['AAA', 'BBB'] });
    const res = await onRequestPost(ctx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ok).toBe(false);
    expect(body.succeeded).toBe(1);
    expect((body.failed as unknown[]).length).toBe(1);
    // Audit event records critical severity on partial failure.
    const input = recordMock.mock.calls[0][1] as Record<string, unknown>;
    expect(input.severity).toBe('critical');
  });
});
