/**
 * Tests for the guest publish per-IP quota helpers in
 * src/share/rate-limit.ts. Uses an in-memory D1 stub keyed on
 * (ip_hash, bucket_start).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  checkGuestPublishQuota,
  consumeGuestPublishQuota,
  pruneExpiredGuestPublishQuotaBuckets,
  resolveGuestPublishQuota,
  DEFAULT_GUEST_PUBLISH_QUOTA,
} from '../../src/share/rate-limit';
import type { D1Database } from '../../src/share/d1-types';

type Row = { ip_hash: string; bucket_start: number; count: number };

function makeFakeDb() {
  const rows: Row[] = [];
  const db = {
    prepare(sql: string) {
      const statement = {
        _sql: sql,
        _binds: [] as unknown[],
        bind(...args: unknown[]) {
          statement._binds = args;
          return statement;
        },
        async first<T>(): Promise<T | null> {
          if (sql.includes('SELECT COALESCE(SUM(count)')) {
            const [ipHash, ...keys] = statement._binds as [string, ...number[]];
            const set = new Set(keys);
            let total = 0;
            for (const r of rows) {
              if (r.ip_hash === ipHash && set.has(r.bucket_start)) total += r.count;
            }
            return { total } as unknown as T;
          }
          return null;
        },
        async run() {
          if (sql.includes('INSERT INTO guest_publish_quota_window')) {
            const [ipHash, bucketStart] = statement._binds as [string, number];
            const existing = rows.find((r) => r.ip_hash === ipHash && r.bucket_start === bucketStart);
            if (existing) existing.count += 1;
            else rows.push({ ip_hash: ipHash, bucket_start: bucketStart, count: 1 });
            return { success: true };
          }
          if (sql.includes('DELETE FROM guest_publish_quota_window')) {
            const [cutoff] = statement._binds as [number];
            for (let i = rows.length - 1; i >= 0; i--) {
              if (rows[i].bucket_start < cutoff) rows.splice(i, 1);
            }
            return { success: true };
          }
          return { success: true };
        },
      };
      return statement;
    },
  };
  return { db: db as unknown as D1Database, rows };
}

describe('guest publish quota helpers', () => {
  let fixture: ReturnType<typeof makeFakeDb>;
  beforeEach(() => { fixture = makeFakeDb(); });

  it('allows the first publish and denies after the cap', async () => {
    const now = new Date('2026-04-23T00:00:00.000Z');
    const config = DEFAULT_GUEST_PUBLISH_QUOTA;

    // Five allowed consumes.
    for (let i = 0; i < config.maxPerWindow; i++) {
      const check = await checkGuestPublishQuota(fixture.db, 'ip-hash-1', config, now);
      expect(check.allowed).toBe(true);
      expect(check.limit).toBe(config.maxPerWindow);
      await consumeGuestPublishQuota(fixture.db, 'ip-hash-1', config, now);
    }

    // Sixth is blocked.
    const blocked = await checkGuestPublishQuota(fixture.db, 'ip-hash-1', config, now);
    expect(blocked.allowed).toBe(false);
    expect(blocked.currentCount).toBe(config.maxPerWindow);
  });

  it('keys independently across IP hashes', async () => {
    const now = new Date('2026-04-23T00:00:00.000Z');
    const config = DEFAULT_GUEST_PUBLISH_QUOTA;
    for (let i = 0; i < config.maxPerWindow; i++) {
      await consumeGuestPublishQuota(fixture.db, 'ip-a', config, now);
    }
    expect((await checkGuestPublishQuota(fixture.db, 'ip-a', config, now)).allowed).toBe(false);
    // Different hash must still have a clean window.
    expect((await checkGuestPublishQuota(fixture.db, 'ip-b', config, now)).allowed).toBe(true);
  });

  it('pruneExpiredGuestPublishQuotaBuckets drops old rows', async () => {
    const t0 = new Date('2026-04-20T00:00:00.000Z');
    const t2 = new Date('2026-04-24T00:00:00.000Z'); // 4 days later > 24h window
    await consumeGuestPublishQuota(fixture.db, 'ip-a', DEFAULT_GUEST_PUBLISH_QUOTA, t0);
    expect(fixture.rows.length).toBe(1);
    await pruneExpiredGuestPublishQuotaBuckets(fixture.db, DEFAULT_GUEST_PUBLISH_QUOTA, t2);
    expect(fixture.rows.length).toBe(0);
  });

  it('resolveGuestPublishQuota honors numeric overrides', () => {
    const cfg = resolveGuestPublishQuota({
      GUEST_PUBLISH_QUOTA_MAX: '12',
      GUEST_PUBLISH_QUOTA_WINDOW_SECONDS: '600',
    });
    expect(cfg.maxPerWindow).toBe(12);
    expect(cfg.windowSeconds).toBe(600);
  });

  it('resolveGuestPublishQuota ignores non-numeric overrides', () => {
    const cfg = resolveGuestPublishQuota({ GUEST_PUBLISH_QUOTA_MAX: 'nope' });
    expect(cfg.maxPerWindow).toBe(DEFAULT_GUEST_PUBLISH_QUOTA.maxPerWindow);
  });
});
