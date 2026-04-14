/**
 * Tests for functions/api/admin/sweep/audit.ts — class-based retention sweeper.
 *
 * Covers:
 *   - Admin gate honored (404 when not allowed).
 *   - mode=scrub: nulls ip_hash / user_agent / (moderation_delete+abuse_report) reason;
 *     emits single `audit_swept` event with details.
 *   - mode=delete-abuse-reports: row-deletes abuse_report rows older than cutoff.
 *   - maxAgeDays param clamped and plumbed through.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { onRequestPost } from '../../functions/api/admin/sweep/audit';
import type { Env } from '../../functions/env';

const recordMock = vi.hoisted(() => vi.fn<(...args: unknown[]) => Promise<string>>());
vi.mock('../../src/share/audit', async () => {
  const actual = await vi.importActual<typeof import('../../src/share/audit')>('../../src/share/audit');
  return { ...actual, recordAuditEvent: (...args: unknown[]) => recordMock(...args) };
});

function makeDb(counts: Record<string, number> = {}) {
  const sqls: string[] = [];
  const binds: unknown[][] = [];
  const prepare = (sql: string) => ({
    _binds: [] as unknown[],
    bind(...v: unknown[]) { this._binds = v; return this; },
    async run() { sqls.push(sql); binds.push(this._binds); return { success: true }; },
    async first<T = unknown>(): Promise<T | null> {
      sqls.push(sql); binds.push(this._binds);
      if (sql.includes('COUNT(*)')) {
        // Return the count for whichever class matches this SELECT.
        if (sql.includes("event_type = 'abuse_report'")) return { n: counts.abuse ?? 0 } as unknown as T;
        return { n: counts.scrub ?? 0 } as unknown as T;
      }
      return null;
    },
    async all<T = unknown>() { return { success: true, results: [] as T[] }; },
  });
  return {
    db: { prepare, async batch() { return []; } } as unknown as Env['DB'],
    sqls,
    binds,
  };
}

function makeContext(args: { mode?: string; maxAgeDays?: string; hostname?: string; env?: Partial<Env>; counts?: Record<string, number> }) {
  const params = new URLSearchParams();
  if (args.mode) params.set('mode', args.mode);
  if (args.maxAgeDays) params.set('maxAgeDays', args.maxAgeDays);
  const qs = params.toString() ? `?${params.toString()}` : '';
  const hostname = args.hostname ?? 'localhost';
  const request = new Request(`http://${hostname}/api/admin/sweep/audit${qs}`, {
    method: 'POST',
  });
  const { db, sqls, binds } = makeDb(args.counts);
  const env: Env = {
    DB: db,
    R2_BUCKET: {} as unknown as Env['R2_BUCKET'],
    DEV_ADMIN_ENABLED: 'true',
    ...args.env,
  };
  return { ctx: { request, env } as unknown as Parameters<typeof onRequestPost>[0], sqls, binds };
}

beforeEach(() => {
  recordMock.mockReset();
  recordMock.mockResolvedValue('audit-id');
});

describe('audit sweep endpoint', () => {
  it('404 when admin gate denies', async () => {
    const { ctx } = makeContext({ env: { DEV_ADMIN_ENABLED: 'false' } });
    const res = await onRequestPost(ctx);
    expect(res.status).toBe(404);
    expect(recordMock).not.toHaveBeenCalled();
  });

  it('default mode=scrub: runs UPDATE, records audit_swept with scrubbed count', async () => {
    const { ctx, sqls } = makeContext({ counts: { scrub: 7 } });
    const res = await onRequestPost(ctx);
    expect(res.status).toBe(200);
    const payload = (await res.json()) as Record<string, unknown>;
    expect(payload.mode).toBe('scrub');
    expect(payload.scrubbed).toBe(7);
    expect(payload.maxAgeDays).toBe(180);
    // The UPDATE is present among the SQLs.
    expect(sqls.some((s) => s.includes('UPDATE capsule_share_audit'))).toBe(true);
    const input = recordMock.mock.calls[0][1] as Record<string, unknown>;
    expect(input.eventType).toBe('audit_swept');
    expect((input.details as Record<string, unknown>).mode).toBe('scrub');
    expect((input.details as Record<string, unknown>).scrubbed).toBe(7);
  });

  it('mode=delete-abuse-reports: DELETE for abuse_report, records deleted count', async () => {
    const { ctx, sqls } = makeContext({
      mode: 'delete-abuse-reports',
      counts: { abuse: 3 },
    });
    const res = await onRequestPost(ctx);
    const payload = (await res.json()) as Record<string, unknown>;
    expect(payload.mode).toBe('delete-abuse-reports');
    expect(payload.deleted).toBe(3);
    expect(sqls.some((s) => s.includes('DELETE FROM capsule_share_audit') && s.includes("'abuse_report'"))).toBe(true);
  });

  it('maxAgeDays clamps below 7 and above 3650', async () => {
    const low = await onRequestPost(makeContext({ maxAgeDays: '1' }).ctx);
    expect(((await low.json()) as Record<string, unknown>).maxAgeDays).toBe(7);
    const high = await onRequestPost(makeContext({ maxAgeDays: '999999' }).ctx);
    expect(((await high.json()) as Record<string, unknown>).maxAgeDays).toBe(3650);
  });
});
