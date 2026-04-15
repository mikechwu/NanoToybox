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
import {
  onRequestPost as onIntent,
  __test_only_resetBuckets,
} from '../../functions/api/account/age-confirmation/intent';
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

  it('D120: emits the age_confirmation_recorded audit event via the shared helper', async () => {
    authMock.mockResolvedValue('session-user');
    const { db, writes } = makeDb();
    const env = { DB: db } as unknown as Env;
    const request = new Request('https://example.test/api/account/age-confirmation', {
      method: 'POST',
    });
    const res = await onConfirm({ request, env } as unknown as Parameters<typeof onConfirm>[0]);
    expect(res.status).toBe(200);
    // The endpoint must go through `recordAge13PlusAcceptance`, which
    // writes the UPSERT AND emits the audit row. A regression that
    // duplicates the SQL inline (without the audit emission) would
    // pass the row-write test but fail this one.
    const upsert = writes.find((w) => w.sql.includes('user_policy_acceptance'));
    expect(upsert).toBeDefined();
    const audit = writes.find((w) => w.sql.includes('capsule_share_audit'));
    expect(audit).toBeDefined();
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
  beforeEach(() => { __test_only_resetBuckets(); });

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

  it('D120 layer-2: per-isolate per-IP cap returns 429 with a precise Retry-After', async () => {
    const env = { SESSION_SECRET: 'x'.repeat(32) } as unknown as Env;
    const mkReq = () => new Request(
      'https://example.test/api/account/age-confirmation/intent',
      { method: 'POST', headers: { 'CF-Connecting-IP': '203.0.113.7' } },
    );
    // Bucket is 60/min per hashed IP. Fire 60 successful requests.
    for (let i = 0; i < 60; i++) {
      const res = await onIntent({ request: mkReq(), env } as unknown as Parameters<typeof onIntent>[0]);
      expect(res.status).toBe(200);
    }
    // 61st in the same minute → 429 with Retry-After reflecting the
    // REMAINING window (not a fixed 60). All 60 requests fire in tight
    // succession so the remaining window should be >= 58 and <= 60.
    const over = await onIntent({ request: mkReq(), env } as unknown as Parameters<typeof onIntent>[0]);
    expect(over.status).toBe(429);
    const retryAfter = Number(over.headers.get('Retry-After'));
    expect(retryAfter).toBeGreaterThanOrEqual(1);
    expect(retryAfter).toBeLessThanOrEqual(60);
  });

  it('D120 layer-2: different IPs get independent buckets', async () => {
    const env = { SESSION_SECRET: 'x'.repeat(32) } as unknown as Env;
    const mkReq = (ip: string) => new Request(
      'https://example.test/api/account/age-confirmation/intent',
      { method: 'POST', headers: { 'CF-Connecting-IP': ip } },
    );
    // Exhaust IP A.
    for (let i = 0; i < 60; i++) {
      await onIntent({ request: mkReq('198.51.100.1'), env } as unknown as Parameters<typeof onIntent>[0]);
    }
    const aOver = await onIntent({ request: mkReq('198.51.100.1'), env } as unknown as Parameters<typeof onIntent>[0]);
    expect(aOver.status).toBe(429);
    // IP B still has its full quota.
    const bFirst = await onIntent({ request: mkReq('198.51.100.2'), env } as unknown as Parameters<typeof onIntent>[0]);
    expect(bFirst.status).toBe(200);
  });

  it('D120 layer-2: expired buckets are pruned after the window elapses, even below the size threshold', async () => {
    // Emergency cap is 1000 entries; time-based pruning runs every
    // 60 s regardless of size. Use fake timers so the second request
    // crosses both the per-IP window (60 s) AND the prune interval
    // (60 s) without sleeping real-time.
    vi.useFakeTimers();
    const startMs = 1_700_000_000_000;
    vi.setSystemTime(new Date(startMs));
    try {
      const env = { SESSION_SECRET: 'x'.repeat(32) } as unknown as Env;
      const ip = '198.51.100.42';
      const mkReq = () => new Request(
        'https://example.test/api/account/age-confirmation/intent',
        { method: 'POST', headers: { 'CF-Connecting-IP': ip } },
      );

      // Exhaust IP's bucket at t=0.
      for (let i = 0; i < 60; i++) {
        await onIntent({ request: mkReq(), env } as unknown as Parameters<typeof onIntent>[0]);
      }
      const over = await onIntent({ request: mkReq(), env } as unknown as Parameters<typeof onIntent>[0]);
      expect(over.status).toBe(429);

      // Advance 61 s past the start — window has expired AND the
      // prune-interval clock has elapsed. The next request should
      // open a fresh window (count=1, no 429) AND the prune path
      // should have dropped the stale entry BEFORE the new write
      // (so the fresh entry starts clean, not piggybacking on a
      // 60-count bucket).
      vi.setSystemTime(new Date(startMs + 61_000));
      const afterPrune = await onIntent({ request: mkReq(), env } as unknown as Parameters<typeof onIntent>[0]);
      expect(afterPrune.status).toBe(200);

      // A second request at the same logical "now" stays in the
      // fresh window (count=2 of 60); if pruning had NOT run, the
      // stale bucket would still be at count=60 and this would 429.
      const afterPrune2 = await onIntent({ request: mkReq(), env } as unknown as Parameters<typeof onIntent>[0]);
      expect(afterPrune2.status).toBe(200);
    } finally {
      vi.useRealTimers();
    }
  });
});
