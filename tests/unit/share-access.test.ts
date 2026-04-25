/**
 * Helper-level tests for src/share/share-access.ts.
 *
 * Exercises the conditional-update behavior, missing-`meta` fallback,
 * warn-once invariant, error pass-through, and storage-format pin.
 *
 * Tests #1-#7 + #11 mirror the named cases in
 * .reports/2026-04-24-last-accessed-write-on-read-refinement-plan.md
 * (Slice 3 — helper-level).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  LAST_ACCESSED_WRITE_WINDOW_MS,
  computeShareAccessStaleBeforeIso,
  recordShareAccessIfStale,
  shouldRecordShareAccess,
  _recordShareAccessIfStaleForTesting,
  _resetD1ShapeUnknownWarnedForTesting,
} from '../../src/share/share-access';
import type { D1Database } from '../../src/share/d1-types';

interface CapturedCall {
  sql: string;
  binds: unknown[];
}

interface FakeOptions {
  /** Result returned by run(). Defaults to `{ success: true, meta: { changes: 1 } }`. */
  runResult?: unknown;
  /** When set, run() rejects with this error instead of resolving. */
  runError?: unknown;
}

function makeFakeDb(opts: FakeOptions = {}): { db: D1Database; calls: CapturedCall[] } {
  const calls: CapturedCall[] = [];
  const db: D1Database = {
    prepare(sql: string) {
      const stmt = {
        _binds: [] as unknown[],
        bind(...vs: unknown[]) {
          this._binds = vs;
          return this as unknown as ReturnType<D1Database['prepare']>;
        },
        async run() {
          calls.push({ sql, binds: this._binds.slice() });
          if (opts.runError !== undefined) throw opts.runError;
          return (opts.runResult ?? { success: true, meta: { changes: 1 } }) as { success: boolean };
        },
        async first() {
          throw new Error('first() not used by share-access helper');
        },
        async all() {
          throw new Error('all() not used by share-access helper');
        },
      };
      return stmt as unknown as ReturnType<D1Database['prepare']>;
    },
    async batch() {
      throw new Error('batch() not used by share-access helper');
    },
  };
  return { db, calls };
}

const SHARE_ID = 'share-id-1';
const NOW_ISO = '2026-04-24T12:00:00.000Z';

beforeEach(() => {
  _resetD1ShapeUnknownWarnedForTesting();
});

describe('recordShareAccessIfStale — write semantics', () => {
  // #1: NULL row → written; bind order locked.
  it('updates a row with last_accessed_at = NULL and binds [nowIso, shareId, staleBeforeIso]', async () => {
    const { db, calls } = makeFakeDb({ runResult: { success: true, meta: { changes: 1 } } });
    const result = await recordShareAccessIfStale(db, SHARE_ID, NOW_ISO);
    expect(result).toEqual({ written: true });
    expect(calls).toHaveLength(1);
    expect(calls[0].sql).toContain('UPDATE capsule_share SET last_accessed_at = ?');
    expect(calls[0].sql).toContain('last_accessed_at IS NULL OR last_accessed_at < ?');
    expect(calls[0].binds).toEqual([
      NOW_ISO,
      SHARE_ID,
      new Date(Date.parse(NOW_ISO) - LAST_ACCESSED_WRITE_WINDOW_MS).toISOString(),
    ]);
  });

  // #2: stale (older than window) → written.
  it('updates when meta.changes = 1 (D1 reports a row was updated)', async () => {
    const { db } = makeFakeDb({ runResult: { success: true, meta: { changes: 1 } } });
    const result = await recordShareAccessIfStale(db, SHARE_ID, NOW_ISO);
    expect(result.written).toBe(true);
  });

  // #3: fresh (inside window) → not written.
  it('does not report a write when meta.changes = 0 (threshold not crossed)', async () => {
    const { db } = makeFakeDb({ runResult: { success: true, meta: { changes: 0 } } });
    const result = await recordShareAccessIfStale(db, SHARE_ID, NOW_ISO);
    expect(result.written).toBe(false);
  });

  // #4: concurrent-delete race produces the same shape as #3 — helper does not distinguish.
  it('reports written=false when meta.changes = 0 due to concurrent delete (indistinguishable from #3)', async () => {
    const { db } = makeFakeDb({ runResult: { success: true, meta: { changes: 0 } } });
    const result = await recordShareAccessIfStale(db, SHARE_ID, NOW_ISO);
    expect(result.written).toBe(false);
  });

  // #5: D1 throws → helper rejects (does not swallow).
  it('rejects with the original error when D1.run() throws', async () => {
    const boom = new Error('D1 unavailable');
    const { db } = makeFakeDb({ runError: boom });
    await expect(recordShareAccessIfStale(db, SHARE_ID, NOW_ISO)).rejects.toBe(boom);
  });

  // #6: windowMs = 0 — strict, NOT unconditional. Pins both sides of the boundary.
  it('windowMs=0 updates only when nowIso advances past the stored timestamp (strict, not unconditional)', async () => {
    const T0 = '2026-04-24T12:00:00.000Z';
    const T1 = '2026-04-24T12:00:00.001Z';

    // Two-call stateful fake: first SELECT returns NULL; first UPDATE writes T0;
    // second UPDATE applies the WHERE predicate (last_accessed_at < staleBeforeIso).
    let stored: string | null = null;
    const calls: CapturedCall[] = [];
    const db: D1Database = {
      prepare(sql: string) {
        const stmt = {
          _binds: [] as unknown[],
          bind(...vs: unknown[]) { this._binds = vs; return this as unknown as ReturnType<D1Database['prepare']>; },
          async run() {
            calls.push({ sql, binds: this._binds.slice() });
            const [bindNow, , bindStaleBefore] = this._binds as [string, string, string];
            // Mirror the SQL predicate: stored IS NULL OR stored < staleBefore.
            const matches = stored === null || stored < bindStaleBefore;
            if (matches) {
              stored = bindNow;
              return { success: true, meta: { changes: 1 } } as { success: boolean };
            }
            return { success: true, meta: { changes: 0 } } as { success: boolean };
          },
          async first() { throw new Error('unused'); },
          async all() { throw new Error('unused'); },
        };
        return stmt as unknown as ReturnType<D1Database['prepare']>;
      },
      async batch() { throw new Error('unused'); },
    };

    // First call from NULL — writes regardless of windowMs.
    const r1 = await _recordShareAccessIfStaleForTesting(db, SHARE_ID, T0, 0);
    expect(r1).toEqual({ written: true });
    expect(stored).toBe(T0);

    // Second call with same instant — windowMs=0 collapses to `< T0`, no update.
    const r2 = await _recordShareAccessIfStaleForTesting(db, SHARE_ID, T0, 0);
    expect(r2).toEqual({ written: false });
    expect(stored).toBe(T0);

    // Third call advances by 1ms — windowMs=0 collapses to `< T1`, T0 < T1 → updates.
    const r3 = await _recordShareAccessIfStaleForTesting(db, SHARE_ID, T1, 0);
    expect(r3).toEqual({ written: true });
    expect(stored).toBe(T1);
  });
});

describe('recordShareAccessIfStale — missing-meta fallback', () => {
  // #7: result with no .meta → written:false + single warn-once log.
  it('returns written:false and warns once per isolate when result has no .meta field', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { db } = makeFakeDb({ runResult: { success: true } });
      const r1 = await recordShareAccessIfStale(db, SHARE_ID, NOW_ISO);
      expect(r1).toEqual({ written: false });

      // Second call in the same isolate must NOT emit a duplicate warning.
      const r2 = await recordShareAccessIfStale(db, SHARE_ID, NOW_ISO);
      expect(r2).toEqual({ written: false });

      const sharedAccessWarns = warnSpy.mock.calls
        .map((c) => String(c[0]))
        .filter((m) => m.includes('[share-access] d1-shape-unknown'));
      expect(sharedAccessWarns).toHaveLength(1);
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe('storage format pin (test #11)', () => {
  // Pins the production storage format: every value the helper writes
  // to D1 (the `last_accessed_at` column) and every value it compares
  // against (`staleBeforeIso`) MUST be millisecond-width ISO. Captures
  // the actual SQL binds the helper produces for a real call — so a
  // future regression that drops millisecond precision in either
  // position fails this test loudly. NOT a tautology on toISOString().
  it('the helper binds millisecond-width ISO strings for both nowIso and staleBeforeIso', async () => {
    const ms = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
    const { db, calls } = makeFakeDb({ runResult: { success: true, meta: { changes: 1 } } });
    const nowIso = new Date().toISOString();
    await recordShareAccessIfStale(db, SHARE_ID, nowIso);
    expect(calls).toHaveLength(1);
    const [boundNow, boundShareId, boundStaleBefore] = calls[0].binds as [string, string, string];
    expect(boundNow).toMatch(ms);
    expect(boundStaleBefore).toMatch(ms);
    expect(boundShareId).toBe(SHARE_ID);
    // The two bound timestamps are exactly LAST_ACCESSED_WRITE_WINDOW_MS apart.
    expect(Date.parse(boundNow) - Date.parse(boundStaleBefore)).toBe(
      LAST_ACCESSED_WRITE_WINDOW_MS,
    );
  });
});

describe('LAST_ACCESSED_WRITE_WINDOW_MS', () => {
  it('is exactly one hour', () => {
    expect(LAST_ACCESSED_WRITE_WINDOW_MS).toBe(60 * 60 * 1000);
  });
});

describe('computeShareAccessStaleBeforeIso', () => {
  it('returns nowIso minus LAST_ACCESSED_WRITE_WINDOW_MS as a millisecond-width ISO', () => {
    const nowIso = '2026-04-24T12:00:00.000Z';
    const expected = new Date(Date.parse(nowIso) - LAST_ACCESSED_WRITE_WINDOW_MS).toISOString();
    expect(computeShareAccessStaleBeforeIso(nowIso)).toBe(expected);
    expect(computeShareAccessStaleBeforeIso(nowIso)).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
    );
  });

  // Defensive: a malformed nowIso must throw a NAMED error rather than
  // produce a corrupt bind value. The route gate calls this synchronously
  // outside the helper's `.catch(...)` chain, so a silent
  // `RangeError: Invalid time value` would surface as an unlogged 500.
  it('throws a named [share-access] error for an unparseable nowIso', () => {
    expect(() => computeShareAccessStaleBeforeIso('garbage')).toThrow(/\[share-access\] invalid nowIso/);
    expect(() => computeShareAccessStaleBeforeIso('')).toThrow(/\[share-access\] invalid nowIso/);
  });

  it('shouldRecordShareAccess inherits the named-error contract', () => {
    expect(() => shouldRecordShareAccess(null, 'garbage')).toThrow(/\[share-access\] invalid nowIso/);
  });
});

describe('shouldRecordShareAccess (route-level gate)', () => {
  const nowIso = '2026-04-24T12:00:00.000Z';
  const staleBeforeIso = computeShareAccessStaleBeforeIso(nowIso);

  it('returns true for null lastAccessedAt', () => {
    expect(shouldRecordShareAccess(null, nowIso)).toBe(true);
  });

  it('returns true when lastAccessedAt is strictly older than the window', () => {
    const old = new Date(Date.parse(staleBeforeIso) - 1).toISOString();
    expect(shouldRecordShareAccess(old, nowIso)).toBe(true);
  });

  it('returns false when lastAccessedAt equals staleBeforeIso (strict-less-than)', () => {
    expect(shouldRecordShareAccess(staleBeforeIso, nowIso)).toBe(false);
  });

  it('returns false when lastAccessedAt is inside the window', () => {
    const recent = new Date(Date.parse(nowIso) - 60_000).toISOString();
    expect(shouldRecordShareAccess(recent, nowIso)).toBe(false);
  });

  // Drift-protection: the route gate and the helper SQL must agree on
  // which rows are stale. Walk through a parametric set of stored
  // timestamps and verify that the gate's "true" answers correspond
  // exactly to the helper writing the row, and "false" answers
  // correspond exactly to the helper reporting written:false.
  it('matches the helper SQL predicate on the same snapshot', async () => {
    const cases: Array<{ stored: string | null; expectGate: boolean }> = [
      { stored: null, expectGate: true },
      { stored: new Date(Date.parse(staleBeforeIso) - 1).toISOString(), expectGate: true },
      { stored: staleBeforeIso, expectGate: false },
      { stored: new Date(Date.parse(nowIso) - 1).toISOString(), expectGate: false },
    ];
    for (const { stored, expectGate } of cases) {
      expect(shouldRecordShareAccess(stored, nowIso)).toBe(expectGate);

      // Helper-side parity: simulate the SQL on a stateful fake. The
      // helper's `written` outcome must match the gate's verdict on
      // the same stored snapshot.
      let row: string | null = stored;
      const db: D1Database = {
        prepare() {
          const stmt = {
            _binds: [] as unknown[],
            bind(...vs: unknown[]) { this._binds = vs; return this as unknown as ReturnType<D1Database['prepare']>; },
            async run() {
              const [bindNow, , bindStaleBefore] = this._binds as [string, string, string];
              const matches = row === null || row < bindStaleBefore;
              if (matches) {
                row = bindNow;
                return { success: true, meta: { changes: 1 } } as { success: boolean };
              }
              return { success: true, meta: { changes: 0 } } as { success: boolean };
            },
            async first() { throw new Error('unused'); },
            async all() { throw new Error('unused'); },
          };
          return stmt as unknown as ReturnType<D1Database['prepare']>;
        },
        async batch() { throw new Error('unused'); },
      };
      const result = await recordShareAccessIfStale(db, SHARE_ID, nowIso);
      expect(result.written).toBe(expectGate);
    }
  });
});
