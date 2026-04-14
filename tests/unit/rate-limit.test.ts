/**
 * Tests for src/share/rate-limit.ts.
 *
 * Covers: bucket math, sliding-window sum, check-and-consume semantics,
 * retry-after computation, pruning.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  DEFAULT_PUBLISH_QUOTA,
  activeBuckets,
  bucketKey,
  checkPublishQuota,
  consumePublishQuota,
  pruneExpiredQuotaBuckets,
} from '../../src/share/rate-limit';
import type { D1Database } from '../../src/share/d1-types';
import type { PublishQuotaConfig } from '../../src/share/rate-limit';

/**
 * Test-only convenience that mirrors the (removed) legacy single-step
 * helper. The production publish endpoint does NOT use this pattern —
 * it uses checkPublishQuota + (later, on success) consumePublishQuota.
 * Kept here so the existing single-call tests stay readable.
 */
async function checkAndConsume(
  db: D1Database,
  userId: string,
  config: PublishQuotaConfig,
  now: Date,
) {
  const result = await checkPublishQuota(db, userId, config, now);
  if (!result.allowed) return result;
  await consumePublishQuota(db, userId, config, now);
  return { ...result, currentCount: result.currentCount + 1 };
}

// ── Bucket math ─────────────────────────────────────────────────────────────

describe('bucketKey', () => {
  it('buckets integer-divide unix seconds by bucketSeconds', () => {
    const cfg = { maxPerWindow: 10, windowSeconds: 3600, bucketSeconds: 600 };
    expect(bucketKey(0, cfg)).toBe(0);
    expect(bucketKey(599, cfg)).toBe(0);
    expect(bucketKey(600, cfg)).toBe(1);
    expect(bucketKey(1799, cfg)).toBe(2);
  });
});

describe('activeBuckets', () => {
  it('returns ceil(window/bucket) keys ending at current', () => {
    const cfg = { maxPerWindow: 10, windowSeconds: 3600, bucketSeconds: 600 };
    const keys = activeBuckets(1800, cfg); // current bucket = 3
    expect(keys).toEqual([3, 2, 1, 0, -1, -2]); // 6 buckets (3600/600)
  });

  it('defaults cover 24 hourly buckets for the 24h/1h default config', () => {
    const keys = activeBuckets(100 * 3600, DEFAULT_PUBLISH_QUOTA);
    expect(keys.length).toBe(24);
  });
});

// ── Mock D1 ─────────────────────────────────────────────────────────────────

type QuotaRow = { user_id: string; window_key: number; count: number };

function makeMockDb(opts: { initialRows?: QuotaRow[] } = {}) {
  const rows: QuotaRow[] = [...(opts.initialRows ?? [])];

  function findRow(userId: string, windowKey: number): QuotaRow | undefined {
    return rows.find((r) => r.user_id === userId && r.window_key === windowKey);
  }

  const mockStatement = {
    _sql: '',
    _binds: [] as unknown[],
    bind(...values: unknown[]) {
      this._binds = values;
      return this as unknown as ReturnType<D1Database['prepare']>;
    },
    async run() {
      if (this._sql.startsWith('INSERT INTO publish_quota_window')) {
        const [userId, windowKey] = this._binds as [string, number];
        const existing = findRow(userId, windowKey);
        if (existing) existing.count += 1;
        else rows.push({ user_id: userId, window_key: windowKey, count: 1 });
      } else if (this._sql.startsWith('DELETE FROM publish_quota_window WHERE window_key <')) {
        const [cutoff] = this._binds as [number];
        for (let i = rows.length - 1; i >= 0; i--) {
          if (rows[i].window_key < cutoff) rows.splice(i, 1);
        }
      }
      return { success: true };
    },
    async first<T = unknown>(): Promise<T | null> {
      if (this._sql.startsWith('SELECT COALESCE(SUM(count)')) {
        const [userId, ...keys] = this._binds as [string, ...number[]];
        const total = rows
          .filter((r) => r.user_id === userId && keys.includes(r.window_key))
          .reduce((sum, r) => sum + r.count, 0);
        return { total } as T;
      }
      return null;
    },
    async all<T = unknown>() {
      return { success: true, results: [] as T[] };
    },
  };

  const db = {
    prepare(sql: string) {
      const stmt = Object.create(mockStatement);
      stmt._sql = sql;
      stmt._binds = [];
      return stmt;
    },
    async batch() {
      return [];
    },
    _rows: rows,
  } as unknown as D1Database & { _rows: QuotaRow[] };

  return db;
}

// ── checkAndConsume ────────────────────────────────────────────

describe('checkAndConsume', () => {
  it('allows publishes under the limit and increments the current bucket', async () => {
    const db = makeMockDb();
    const cfg = { maxPerWindow: 3, windowSeconds: 3600, bucketSeconds: 600 };
    const now = new Date(600_000); // t=600s → bucket 1

    const r1 = await checkAndConsume(db, 'u1', cfg, now);
    expect(r1.allowed).toBe(true);
    expect(r1.currentCount).toBe(1);
    expect(r1.limit).toBe(3);

    const r2 = await checkAndConsume(db, 'u1', cfg, now);
    expect(r2.allowed).toBe(true);
    expect(r2.currentCount).toBe(2);

    const r3 = await checkAndConsume(db, 'u1', cfg, now);
    expect(r3.allowed).toBe(true);
    expect(r3.currentCount).toBe(3);

    // 4th should reject
    const r4 = await checkAndConsume(db, 'u1', cfg, now);
    expect(r4.allowed).toBe(false);
    expect(r4.currentCount).toBe(3); // not incremented
  });

  it('separates users — u1 hitting limit does not affect u2', async () => {
    const db = makeMockDb();
    const cfg = { maxPerWindow: 2, windowSeconds: 3600, bucketSeconds: 600 };
    const now = new Date(600_000);

    await checkAndConsume(db, 'u1', cfg, now);
    await checkAndConsume(db, 'u1', cfg, now);
    const u1Rejected = await checkAndConsume(db, 'u1', cfg, now);
    expect(u1Rejected.allowed).toBe(false);

    const u2Allowed = await checkAndConsume(db, 'u2', cfg, now);
    expect(u2Allowed.allowed).toBe(true);
  });

  it('sums across multiple active buckets in the sliding window', async () => {
    const db = makeMockDb();
    const cfg = { maxPerWindow: 3, windowSeconds: 1800, bucketSeconds: 600 };

    // t=0 bucket 0: one publish
    await checkAndConsume(db, 'u1', cfg, new Date(0));
    // t=600 bucket 1: one publish
    await checkAndConsume(db, 'u1', cfg, new Date(600_000));
    // t=1200 bucket 2: one publish — now at limit (3 across buckets [2,1,0])
    const r = await checkAndConsume(db, 'u1', cfg, new Date(1_200_000));
    expect(r.allowed).toBe(true);
    expect(r.currentCount).toBe(3);

    // Another at t=1200 should reject
    const r2 = await checkAndConsume(db, 'u1', cfg, new Date(1_200_000));
    expect(r2.allowed).toBe(false);
  });

  it('old buckets fall out of the window and free up quota', async () => {
    const db = makeMockDb();
    const cfg = { maxPerWindow: 1, windowSeconds: 600, bucketSeconds: 600 };

    // t=0 bucket 0: consume the only slot
    const a = await checkAndConsume(db, 'u1', cfg, new Date(0));
    expect(a.allowed).toBe(true);

    // t=0 again — over quota
    const b = await checkAndConsume(db, 'u1', cfg, new Date(0));
    expect(b.allowed).toBe(false);

    // t=600 — bucket 0 falls outside window of size 1 (active = bucket 1 only)
    const c = await checkAndConsume(db, 'u1', cfg, new Date(600_000));
    expect(c.allowed).toBe(true);
    expect(c.currentCount).toBe(1);
  });

  it('returns a retryAtSeconds hint that equals oldest-bucket exit time', async () => {
    const db = makeMockDb();
    const cfg = { maxPerWindow: 1, windowSeconds: 600, bucketSeconds: 600 };

    await checkAndConsume(db, 'u1', cfg, new Date(0));
    const rejected = await checkAndConsume(db, 'u1', cfg, new Date(0));
    expect(rejected.allowed).toBe(false);
    // oldestBucket = 0 * 600 + 600 = 600
    expect(rejected.retryAtSeconds).toBe(600);
  });
});

// ── pruneExpiredQuotaBuckets ───────────────────────────────────────────────

describe('pruneExpiredQuotaBuckets', () => {
  it('deletes rows with window_key older than the active window', async () => {
    const db = makeMockDb({
      initialRows: [
        { user_id: 'u1', window_key: 0, count: 1 }, // old
        { user_id: 'u1', window_key: 10, count: 1 }, // old
        { user_id: 'u1', window_key: 99, count: 1 }, // active
      ],
    });
    const cfg = { maxPerWindow: 10, windowSeconds: 3600, bucketSeconds: 600 };
    // now = 100*600s → current bucket = 100, window span = 6 buckets, oldest = 94
    await pruneExpiredQuotaBuckets(db, cfg, new Date(100 * 600_000));
    const rows = (db as unknown as { _rows: { window_key: number }[] })._rows;
    expect(rows.every((r) => r.window_key >= 94)).toBe(true);
    expect(rows.length).toBe(1);
  });
});

// ── Split API: checkPublishQuota + consumePublishQuota ─────────────────────

describe('checkPublishQuota (read-only preflight)', () => {
  it('never writes to the quota table (pure read)', async () => {
    const db = makeMockDb();
    const cfg = { maxPerWindow: 3, windowSeconds: 3600, bucketSeconds: 600 };
    const now = new Date(600_000);

    // Call check multiple times without consume — count must stay 0.
    await checkPublishQuota(db, 'u1', cfg, now);
    await checkPublishQuota(db, 'u1', cfg, now);
    await checkPublishQuota(db, 'u1', cfg, now);

    const rows = (db as unknown as { _rows: QuotaRow[] })._rows;
    expect(rows.length).toBe(0);
  });

  it('returns allowed=true under limit, allowed=false at/over limit', async () => {
    const db = makeMockDb({
      initialRows: [{ user_id: 'u1', window_key: 1, count: 9 }],
    });
    const cfg = { maxPerWindow: 10, windowSeconds: 3600, bucketSeconds: 600 };
    const now = new Date(600_000);

    const under = await checkPublishQuota(db, 'u1', cfg, now);
    expect(under.allowed).toBe(true);
    expect(under.currentCount).toBe(9);

    // Push into the current bucket so count reaches the limit.
    (db as unknown as { _rows: QuotaRow[] })._rows[0].count = 10;
    const at = await checkPublishQuota(db, 'u1', cfg, now);
    expect(at.allowed).toBe(false);
    expect(at.currentCount).toBe(10);
  });
});

describe('consumePublishQuota', () => {
  it('inserts a new bucket row and increments on subsequent calls', async () => {
    const db = makeMockDb();
    const cfg = { maxPerWindow: 10, windowSeconds: 3600, bucketSeconds: 600 };
    const now = new Date(600_000); // bucket 1

    await consumePublishQuota(db, 'u1', cfg, now);
    await consumePublishQuota(db, 'u1', cfg, now);
    await consumePublishQuota(db, 'u1', cfg, now);

    const rows = (db as unknown as { _rows: QuotaRow[] })._rows;
    expect(rows.length).toBe(1);
    expect(rows[0]).toEqual({ user_id: 'u1', window_key: 1, count: 3 });
  });

  it('does not gate on the limit — always increments (caller has already gated)', async () => {
    const db = makeMockDb({
      initialRows: [{ user_id: 'u1', window_key: 1, count: 100 }], // way over limit
    });
    const cfg = { maxPerWindow: 10, windowSeconds: 3600, bucketSeconds: 600 };
    const now = new Date(600_000);

    await consumePublishQuota(db, 'u1', cfg, now);

    const rows = (db as unknown as { _rows: QuotaRow[] })._rows;
    expect(rows[0].count).toBe(101);
  });
});

describe('split-API interaction: failed attempts do not charge quota', () => {
  it('multiple check()s without consume() leave the count at 0', async () => {
    const db = makeMockDb();
    const cfg = { maxPerWindow: 3, windowSeconds: 3600, bucketSeconds: 600 };
    const now = new Date(600_000);

    // Simulate 5 failed publish attempts — each passes the preflight
    // but never reaches consume (e.g. body-size rejection).
    for (let i = 0; i < 5; i++) {
      const result = await checkPublishQuota(db, 'u1', cfg, now);
      expect(result.allowed).toBe(true);
    }

    // One successful attempt consumes.
    await consumePublishQuota(db, 'u1', cfg, now);

    // Net effect: 1 consumed, not 5. User's quota is not punished for
    // oversized payloads / invalid schemas.
    const rows = (db as unknown as { _rows: QuotaRow[] })._rows;
    expect(rows[0].count).toBe(1);
  });
});
