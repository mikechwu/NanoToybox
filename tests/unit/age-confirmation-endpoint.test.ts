/**
 * Tests for age-gate endpoints.
 *
 * - `/api/account/age-confirmation` (POST)
 *     - 401 when unauthenticated
 *     - Writes the row with user_id from session (ignores any body-provided user_id)
 *     - Idempotent (UPSERT semantics — second call no-rows-duplicated)
 *
 * - `/api/account/age-confirmation/intent` (POST)
 *     - Returns a token whose kind is 'age_13_plus_intent'
 *     - Rejects when SESSION_SECRET is missing
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { onRequestPost as onConfirm } from '../../functions/api/account/age-confirmation/index';
import { onRequestPost as onIntent } from '../../functions/api/account/age-confirmation/intent';
import { verifyAgeIntent } from '../../functions/signed-intents';
import type { Env } from '../../functions/env';

const authMock = vi.hoisted(() => vi.fn<(...args: unknown[]) => Promise<string | null>>());
vi.mock('../../functions/auth-middleware', () => ({
  authenticateRequest: (...args: unknown[]) => authMock(...args),
}));

beforeEach(() => {
  authMock.mockReset();
});

function makeDb() {
  const writes: Array<{ sql: string; binds: unknown[] }> = [];
  const prepare = (sql: string) => ({
    _binds: [] as unknown[],
    bind(...vs: unknown[]) { this._binds = vs; return this; },
    async run() { writes.push({ sql, binds: this._binds }); return { success: true }; },
    async first<T = unknown>(): Promise<T | null> { return null; },
    async all<T = unknown>() { return { success: true, results: [] as T[] }; },
  });
  return {
    db: { prepare, async batch() { return []; } } as unknown as Env['DB'],
    writes,
  };
}

describe('/api/account/age-confirmation (POST)', () => {
  it('401 when signed-out', async () => {
    authMock.mockResolvedValue(null);
    const { db } = makeDb();
    const env = { DB: db } as unknown as Env;
    const request = new Request('https://example.test/api/account/age-confirmation', {
      method: 'POST',
    });
    const res = await onConfirm({ request, env } as unknown as Parameters<typeof onConfirm>[0]);
    expect(res.status).toBe(401);
  });

  it('takes user_id from session, ignores body-provided user_id', async () => {
    authMock.mockResolvedValue('session-user');
    const { db, writes } = makeDb();
    const env = { DB: db } as unknown as Env;
    const request = new Request('https://example.test/api/account/age-confirmation', {
      method: 'POST',
      body: JSON.stringify({ user_id: 'attacker-user' }),
    });
    const res = await onConfirm({ request, env } as unknown as Parameters<typeof onConfirm>[0]);
    expect(res.status).toBe(200);
    const payload = (await res.json()) as Record<string, unknown>;
    expect(payload.userId).toBe('session-user');
    // Bound user_id is the session user, not the body user.
    expect(writes[0].binds[0]).toBe('session-user');
  });

  it('is idempotent (UPSERT — ON CONFLICT DO UPDATE)', async () => {
    authMock.mockResolvedValue('session-user');
    const { db, writes } = makeDb();
    const env = { DB: db } as unknown as Env;
    const mkReq = () =>
      new Request('https://example.test/api/account/age-confirmation', {
        method: 'POST',
      });
    await onConfirm({ request: mkReq(), env } as unknown as Parameters<typeof onConfirm>[0]);
    await onConfirm({ request: mkReq(), env } as unknown as Parameters<typeof onConfirm>[0]);
    // Both INSERTs use ON CONFLICT DO UPDATE — no separate branch.
    expect(writes.length).toBeGreaterThanOrEqual(2);
    expect(writes[0].sql).toContain('ON CONFLICT');
  });
});

describe('/api/account/age-confirmation/intent (POST)', () => {
  it('returns a token that verifies as kind=age_13_plus_intent', async () => {
    const env = { SESSION_SECRET: 'x'.repeat(32) } as unknown as Env;
    const request = new Request('https://example.test/api/account/age-confirmation/intent', {
      method: 'POST',
    });
    const res = await onIntent({ request, env } as unknown as Parameters<typeof onIntent>[0]);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ageIntent: string; ttlSeconds: number };
    expect(typeof body.ageIntent).toBe('string');
    expect(body.ttlSeconds).toBe(300);
    const payload = await verifyAgeIntent(env, body.ageIntent);
    expect(payload.kind).toBe('age_13_plus_intent');
  });

  it('500 when SESSION_SECRET is not configured', async () => {
    const env = {} as unknown as Env;
    const request = new Request('https://example.test/api/account/age-confirmation/intent', {
      method: 'POST',
    });
    const res = await onIntent({ request, env } as unknown as Parameters<typeof onIntent>[0]);
    expect(res.status).toBe(500);
  });
});
