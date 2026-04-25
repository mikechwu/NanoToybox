/**
 * Route regression tests for GET /api/capsules/:code.
 *
 * Covers the integration between the route's freshness gate
 * (`shouldRecordShareAccess`), the `recordShareAccessIfStale` helper,
 * and Cloudflare Pages' `context.waitUntil` semantics.
 *
 * Cases #8–#13 from
 * .reports/2026-04-24-last-accessed-write-on-read-refinement-plan.md
 * (Slice 3 — route-level):
 *   #8  inaccessible row → 404, no UPDATE
 *   #9  accessible row → 200, exactly one UPDATE
 *   #10 helper rejection → 200 + console.error
 *   #11 two reads inside window → exactly ONE UPDATE issued (route gate
 *       short-circuits the second read)
 *   #12 fresh row on a single read → no waitUntil, no UPDATE
 *   #13 stale row on a single read → exactly one waitUntil + UPDATE
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { onRequestGet } from '../../functions/api/capsules/[code]';
import type { CapsuleShareRow } from '../../src/share/share-record';

const SHARE_CODE = '7M4K2D8Q9T1V';
const SHARE_ID = 'capsule-id-1';

function makeRow(over: Partial<CapsuleShareRow> = {}): CapsuleShareRow {
  return {
    id: SHARE_ID,
    share_code: SHARE_CODE,
    status: 'ready',
    owner_user_id: 'u',
    object_key: 'capsules/x/capsule.atomdojo',
    format: 'atomdojo-history',
    version: 1,
    kind: 'capsule',
    app_version: '0.1.0',
    sha256: 'abc',
    size_bytes: 100,
    frame_count: 60,
    atom_count: 32,
    max_atom_count: 32,
    duration_ps: 1.0,
    has_appearance: 0,
    has_interaction: 0,
    title: null,
    preview_status: 'pending',
    preview_poster_key: null,
    preview_motion_key: null,
    created_at: new Date('2026-04-13T00:00:00.000Z').toISOString(),
    uploaded_at: new Date('2026-04-13T00:00:00.000Z').toISOString(),
    published_at: new Date('2026-04-13T00:00:00.000Z').toISOString(),
    last_accessed_at: null,
    rejection_reason: null,
    preview_scene_v1: null,
    share_mode: 'account',
    expires_at: null,
    ...over,
  };
}

interface CapturedCall {
  sql: string;
  binds: unknown[];
}

/**
 * Stateful fake DB. Mirrors the contract pinned in the plan (Slice 3,
 * route test #11):
 *   1. Holds a single in-memory row (mutable `last_accessed_at`).
 *   2. SELECT returns the row by reference.
 *   3. Conditional UPDATE applies the WHERE predicate
 *      (`last_accessed_at IS NULL OR last_accessed_at < ?`) and mutates
 *      the row only when the predicate matches.
 *   4. `executedUpdateCount` increments only when meta.changes === 1.
 */
function makeStatefulDb(initial: CapsuleShareRow | null) {
  const calls: CapturedCall[] = [];
  let row: CapsuleShareRow | null = initial ? { ...initial } : null;
  let executedUpdateCount = 0;

  const db = {
    prepare(sql: string) {
      const stmt = {
        _binds: [] as unknown[],
        bind(...vs: unknown[]) { this._binds = vs; return stmt; },
        async first<T = unknown>(): Promise<T | null> {
          calls.push({ sql, binds: this._binds.slice() });
          if (sql.includes('SELECT * FROM capsule_share')) {
            return (row as unknown as T) ?? null;
          }
          return null;
        },
        async run() {
          calls.push({ sql, binds: this._binds.slice() });
          if (sql.startsWith('UPDATE capsule_share SET last_accessed_at')) {
            const [bindNow, bindId, bindStaleBefore] = this._binds as [string, string, string];
            if (!row || row.id !== bindId) {
              return { success: true, meta: { changes: 0 } };
            }
            const matches = row.last_accessed_at === null || row.last_accessed_at < bindStaleBefore;
            if (matches) {
              row.last_accessed_at = bindNow;
              executedUpdateCount += 1;
              return { success: true, meta: { changes: 1 } };
            }
            return { success: true, meta: { changes: 0 } };
          }
          return { success: true };
        },
      };
      return stmt;
    },
  };

  return {
    db,
    calls,
    snapshotRow: () => (row ? { ...row } : null),
    setRow: (next: CapsuleShareRow | null) => { row = next ? { ...next } : null; },
    executedUpdateCount: () => executedUpdateCount,
  };
}

/** Stateful fake DB whose UPDATE rejects, simulating a D1 outage. */
function makeRejectingUpdateDb(initial: CapsuleShareRow, err: Error) {
  let row: CapsuleShareRow | null = { ...initial };
  const db = {
    prepare(sql: string) {
      const stmt = {
        _binds: [] as unknown[],
        bind(...vs: unknown[]) { this._binds = vs; return stmt; },
        async first<T = unknown>(): Promise<T | null> {
          if (sql.includes('SELECT * FROM capsule_share')) {
            return (row as unknown as T) ?? null;
          }
          return null;
        },
        async run() {
          if (sql.startsWith('UPDATE capsule_share SET last_accessed_at')) {
            throw err;
          }
          return { success: true };
        },
      };
      return stmt;
    },
  };
  return { db };
}

interface MakeContextOpts {
  db: unknown;
  flag?: string;
}

function makeContext(opts: MakeContextOpts) {
  const waitUntilPromises: Promise<unknown>[] = [];
  const ctx = {
    env: {
      DB: opts.db,
      CAPSULE_PREVIEW_DYNAMIC_FALLBACK: opts.flag,
    },
    request: new Request(`https://example.com/api/capsules/${SHARE_CODE}`),
    params: { code: SHARE_CODE },
    waitUntil: (p: Promise<unknown>) => { waitUntilPromises.push(p); },
    next: () => new Response(),
    data: {},
  };
  return { ctx: ctx as unknown as Parameters<typeof onRequestGet>[0], waitUntilPromises };
}

let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  errorSpy.mockRestore();
});

describe('GET /api/capsules/:code — route regressions', () => {
  // #8: inaccessible row → 404, no UPDATE issued.
  it('returns 404 for an inaccessible row and does not issue an UPDATE', async () => {
    const fake = makeStatefulDb(makeRow({ status: 'rejected' }));
    const { ctx, waitUntilPromises } = makeContext({ db: fake.db });
    const res = await onRequestGet(ctx);
    expect(res.status).toBe(404);
    await Promise.all(waitUntilPromises);
    const updates = fake.calls.filter((c) => c.sql.startsWith('UPDATE capsule_share'));
    expect(updates).toHaveLength(0);
  });

  // #9: accessible row, helper resolves → 200 metadata, exactly one UPDATE call, no console.error.
  it('returns 200 with metadata and triggers exactly one UPDATE when accessible', async () => {
    const fake = makeStatefulDb(makeRow());
    const { ctx, waitUntilPromises } = makeContext({ db: fake.db });
    const res = await onRequestGet(ctx);
    expect(res.status).toBe(200);
    const body = await res.json() as { shareCode: string };
    expect(body.shareCode).toBe(SHARE_CODE);

    await Promise.all(waitUntilPromises);
    const updates = fake.calls.filter((c) => c.sql.startsWith('UPDATE capsule_share'));
    expect(updates).toHaveLength(1);
    expect(fake.executedUpdateCount()).toBe(1);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  // #10: helper rejects → 200 metadata (response unaffected), console.error called once with prefix.
  it('returns 200 even when the access-recording UPDATE rejects, and logs a [capsule-meta] error', async () => {
    const boom = new Error('D1 unavailable');
    const fake = makeRejectingUpdateDb(makeRow(), boom);
    const { ctx, waitUntilPromises } = makeContext({ db: fake.db });
    const res = await onRequestGet(ctx);
    expect(res.status).toBe(200);

    await Promise.all(waitUntilPromises);
    const matchingErrors = errorSpy.mock.calls
      .map((c) => String(c[0]))
      .filter((m) => m.startsWith('[capsule-meta] last_accessed_at update failed'));
    expect(matchingErrors).toHaveLength(1);
    expect(matchingErrors[0]).toContain(SHARE_ID);
    expect(matchingErrors[0]).toContain('D1 unavailable');
  });

  // #11: two consecutive reads inside the window → exactly ONE UPDATE
  // statement is even issued. The route-level freshness gate
  // short-circuits the second request BEFORE scheduling waitUntil, so
  // the helper's conditional SQL is never sent to D1 on the repeat
  // read. This is the bot/unfurler regression motivated in
  // §"Problem Statement" — and the layered defense documented in
  // functions/api/capsules/[code].ts.
  it('two consecutive reads inside the window issue exactly one UPDATE statement (route gate short-circuits the second)', async () => {
    const fake = makeStatefulDb(makeRow({ last_accessed_at: null }));

    // First request — gate sees NULL → schedules waitUntil; helper writes.
    {
      const { ctx, waitUntilPromises } = makeContext({ db: fake.db });
      const res = await onRequestGet(ctx);
      expect(res.status).toBe(200);
      await Promise.all(waitUntilPromises);
    }

    // Second request — gate sees fresh stored timestamp → does NOT
    // schedule waitUntil. No UPDATE prepare/run happens at all.
    {
      const { ctx, waitUntilPromises } = makeContext({ db: fake.db });
      const res = await onRequestGet(ctx);
      expect(res.status).toBe(200);
      expect(waitUntilPromises).toHaveLength(0);
      await Promise.all(waitUntilPromises);
    }

    // Exactly one UPDATE attempt total across both reads (was 2 before
    // the route-level gate was added). One mutation, one write query.
    const updateAttempts = fake.calls.filter((c) => c.sql.startsWith('UPDATE capsule_share'));
    expect(updateAttempts).toHaveLength(1);
    expect(fake.executedUpdateCount()).toBe(1);
    expect(fake.snapshotRow()?.last_accessed_at).not.toBeNull();
  });

  // #12 (route-level): a single read against a fresh row must NOT
  // schedule any background work. Pins the route-level gate so a
  // future refactor cannot re-introduce write-on-read by reverting to
  // unconditional waitUntil.
  it('does not schedule waitUntil or issue any UPDATE when the row is fresh inside the window', async () => {
    const recent = new Date(Date.now() - 60 * 1000).toISOString(); // 1 minute ago
    const fake = makeStatefulDb(makeRow({ last_accessed_at: recent }));
    const { ctx, waitUntilPromises } = makeContext({ db: fake.db });

    const res = await onRequestGet(ctx);
    expect(res.status).toBe(200);
    expect(waitUntilPromises).toHaveLength(0);

    const updateAttempts = fake.calls.filter((c) => c.sql.startsWith('UPDATE capsule_share'));
    expect(updateAttempts).toHaveLength(0);
    // Stored timestamp must be unchanged.
    expect(fake.snapshotRow()?.last_accessed_at).toBe(recent);
  });

  // #13 (route-level): a single read against a stale row MUST schedule
  // waitUntil and issue exactly one UPDATE. Symmetric to #12 — pins
  // the gate from over-firing.
  it('schedules exactly one UPDATE when the row is stale beyond the window', async () => {
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(); // 2 hours ago
    const fake = makeStatefulDb(makeRow({ last_accessed_at: old }));
    const { ctx, waitUntilPromises } = makeContext({ db: fake.db });

    const res = await onRequestGet(ctx);
    expect(res.status).toBe(200);
    expect(waitUntilPromises).toHaveLength(1);
    await Promise.all(waitUntilPromises);

    const updateAttempts = fake.calls.filter((c) => c.sql.startsWith('UPDATE capsule_share'));
    expect(updateAttempts).toHaveLength(1);
    expect(fake.executedUpdateCount()).toBe(1);
  });
});
