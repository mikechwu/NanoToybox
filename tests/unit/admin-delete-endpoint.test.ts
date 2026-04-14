/**
 * Handler-level tests for functions/api/admin/capsules/[code]/delete.ts.
 *
 * Covers the moderation-delete contract:
 *   - admin gate (both success + denied paths)
 *   - fresh delete: status flipped + R2 delete + audit event
 *   - already-deleted retry: R2 re-attempted, audit records retry
 *   - R2 failure: critical-severity audit with r2Error, returns response
 *     with r2Deleted=false (status still flipped)
 *   - 404 for unknown share code
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { onRequestPost } from '../../functions/api/admin/capsules/[code]/delete';
import type { Env } from '../../functions/env';

// ── Audit mock (we assert payload shape) ───────────────────────────────────

const recordMock = vi.hoisted(() => vi.fn<(...args: unknown[]) => Promise<string>>());
vi.mock('../../src/share/audit', async () => {
  const actual = await vi.importActual<typeof import('../../src/share/audit')>('../../src/share/audit');
  return {
    ...actual,
    recordAuditEvent: (...args: unknown[]) => recordMock(...args),
  };
});

// ── Mock D1 + R2 ───────────────────────────────────────────────────────────

interface Row {
  id: string;
  status: string;
  object_key: string;
}

function makeDb(selectRow: Row | null) {
  const updates: Array<{ sql: string; binds: unknown[] }> = [];
  const prepare = (sql: string) => ({
    _binds: [] as unknown[],
    bind(...values: unknown[]) {
      this._binds = values;
      return this;
    },
    async run() {
      updates.push({ sql, binds: this._binds });
      return { success: true };
    },
    async first<T = unknown>(): Promise<T | null> {
      return selectRow as unknown as T;
    },
    async all<T = unknown>() {
      return { success: true, results: [] as T[] };
    },
  });
  const db = {
    prepare,
    async batch() { return []; },
    _updates: updates,
  };
  return db as unknown as Env['DB'] & { _updates: typeof updates };
}

function makeR2(opts: { deleteShouldFail?: boolean } = {}) {
  const deletedKeys: string[] = [];
  const bucket = {
    async delete(key: string) {
      if (opts.deleteShouldFail) throw new Error('r2 boom');
      deletedKeys.push(key);
    },
    async get() { return null; },
    async put() { return undefined; },
    async list() { return { objects: [], truncated: false, delimitedPrefixes: [] }; },
    _deletedKeys: deletedKeys,
  };
  return bucket as unknown as Env['R2_BUCKET'] & { _deletedKeys: string[] };
}

function makeContext(args: {
  code: string;
  env?: Partial<Env>;
  row: Row | null;
  r2?: Env['R2_BUCKET'] & { _deletedKeys: string[] };
  body?: string;
  hostname?: string;
}) {
  const hostname = args.hostname ?? 'localhost';
  const request = new Request(`http://${hostname}/api/admin/capsules/${args.code}/delete`, {
    method: 'POST',
    headers: { 'User-Agent': 'curl/admin' },
    body: args.body ?? '',
  });
  const r2 = args.r2 ?? makeR2();
  const env: Env = {
    DB: makeDb(args.row),
    R2_BUCKET: r2,
    DEV_ADMIN_ENABLED: 'true',
    ...args.env,
  };
  return {
    request,
    env,
    params: { code: args.code },
  } as unknown as Parameters<typeof onRequestPost>[0];
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('admin delete endpoint', () => {
  beforeEach(() => {
    recordMock.mockReset();
    recordMock.mockResolvedValue('audit-id');
  });
  afterEach(() => vi.clearAllMocks());

  it('returns 404 when admin gate denies (no DEV_ADMIN_ENABLED)', async () => {
    const res = await onRequestPost(
      makeContext({
        code: '7M4K2D8Q9T1V',
        row: { id: 'sh-1', status: 'ready', object_key: 'capsules/sh-1/capsule.atomdojo' },
        env: { DEV_ADMIN_ENABLED: 'false' },
      }),
    );
    expect(res.status).toBe(404);
    expect(recordMock).not.toHaveBeenCalled();
  });

  it('returns 404 for unknown share code', async () => {
    const res = await onRequestPost(
      makeContext({ code: '7M4K2D8Q9T1V', row: null }),
    );
    expect(res.status).toBe(404);
    expect(recordMock).not.toHaveBeenCalled();
  });

  it('fresh delete: flips status, deletes R2 blob, writes warning audit', async () => {
    const r2 = makeR2();
    const ctx = makeContext({
      code: '7M4K2D8Q9T1V',
      row: { id: 'sh-1', status: 'ready', object_key: 'capsules/sh-1/capsule.atomdojo' },
      r2,
      body: JSON.stringify({ reason: 'spam' }),
    });
    const res = await onRequestPost(ctx);
    expect(res.status).toBe(200);
    const payload = (await res.json()) as Record<string, unknown>;
    expect(payload).toMatchObject({
      shareCode: '7M4K2D8Q9T1V',
      status: 'deleted',
      alreadyDeleted: false,
      r2Deleted: true,
    });

    // R2 delete invoked for the correct key
    expect(r2._deletedKeys).toEqual(['capsules/sh-1/capsule.atomdojo']);

    // Status-flip UPDATE went through (one of the D1 updates contains the UPDATE)
    const updates = (ctx.env.DB as unknown as { _updates: Array<{ sql: string }> })._updates;
    expect(updates.some((u) => u.sql.includes("UPDATE capsule_share SET status = 'deleted'"))).toBe(true);

    // Audit event written with the expected shape
    expect(recordMock).toHaveBeenCalledTimes(1);
    const input = recordMock.mock.calls[0][1] as unknown as Record<string, unknown>;
    expect(input.eventType).toBe('moderation_delete');
    expect(input.severity).toBe('warning');
    expect(input.actor).toBe('admin');
    expect(input.reason).toBe('spam');
    expect((input.details as Record<string, unknown>).alreadyDeleted).toBe(false);
    expect((input.details as Record<string, unknown>).r2Deleted).toBe(true);
  });

  it('idempotent retry on already-deleted record: re-attempts R2 delete, still audits', async () => {
    const r2 = makeR2();
    const ctx = makeContext({
      code: '7M4K2D8Q9T1V',
      row: { id: 'sh-1', status: 'deleted', object_key: 'capsules/sh-1/capsule.atomdojo' },
      r2,
    });
    const res = await onRequestPost(ctx);
    expect(res.status).toBe(200);
    const payload = (await res.json()) as Record<string, unknown>;
    expect(payload.alreadyDeleted).toBe(true);
    expect(payload.r2Deleted).toBe(true);

    // R2 delete still invoked — idempotent retry is the whole point.
    expect(r2._deletedKeys).toEqual(['capsules/sh-1/capsule.atomdojo']);

    // No second UPDATE status = 'deleted' — status is already deleted.
    const updates = (ctx.env.DB as unknown as { _updates: Array<{ sql: string }> })._updates;
    expect(updates.some((u) => u.sql.includes("UPDATE capsule_share SET status = 'deleted'"))).toBe(false);

    // Audit records the retry path.
    const input = recordMock.mock.calls[0][1] as unknown as Record<string, unknown>;
    expect((input.details as Record<string, unknown>).alreadyDeleted).toBe(true);
  });

  it('R2 failure: returns critical audit with r2Error, payload still reports status=deleted', async () => {
    const r2 = makeR2({ deleteShouldFail: true });
    const res = await onRequestPost(
      makeContext({
        code: '7M4K2D8Q9T1V',
        row: { id: 'sh-1', status: 'ready', object_key: 'capsules/sh-1/capsule.atomdojo' },
        r2,
      }),
    );
    expect(res.status).toBe(200);
    const payload = (await res.json()) as Record<string, unknown>;
    expect(payload.r2Deleted).toBe(false);
    expect(payload.r2Error).toBe('r2 boom');

    // Audit severity escalates — surfaces to ops dashboards.
    const input = recordMock.mock.calls[0][1] as unknown as Record<string, unknown>;
    expect(input.severity).toBe('critical');
    expect((input.details as Record<string, unknown>).r2Deleted).toBe(false);
    expect((input.details as Record<string, unknown>).r2Error).toBe('r2 boom');
  });

  it('accepts a malformed JSON body without crashing (admin endpoint tolerance)', async () => {
    const res = await onRequestPost(
      makeContext({
        code: '7M4K2D8Q9T1V',
        row: { id: 'sh-1', status: 'ready', object_key: 'k' },
        body: '{not-json',
      }),
    );
    expect(res.status).toBe(200);
  });
});
