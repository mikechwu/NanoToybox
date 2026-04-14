/**
 * Handler-level tests for functions/api/admin/sweep/sessions.ts.
 *
 * Covers:
 *   - admin gate
 *   - DELETE runs on sessions with matching WHERE clause shape
 *   - pruneExpiredQuotaBuckets is invoked
 *   - session_swept audit event is written
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { onRequestPost } from '../../functions/api/admin/sweep/sessions';
import type { Env } from '../../functions/env';

const recordMock = vi.hoisted(() => vi.fn<(...args: unknown[]) => Promise<string>>());
vi.mock('../../src/share/audit', async () => {
  const actual = await vi.importActual<typeof import('../../src/share/audit')>('../../src/share/audit');
  return {
    ...actual,
    recordAuditEvent: (...args: unknown[]) => recordMock(...args),
  };
});

const pruneMock = vi.hoisted(() => vi.fn<(...args: unknown[]) => Promise<void>>());
vi.mock('../../src/share/rate-limit', async () => {
  const actual = await vi.importActual<typeof import('../../src/share/rate-limit')>('../../src/share/rate-limit');
  return {
    ...actual,
    pruneExpiredQuotaBuckets: (...args: unknown[]) => pruneMock(...args),
  };
});

// ── D1 mock that captures executed SQL + binds ─────────────────────────────

function makeDb() {
  const statements: Array<{ sql: string; binds: unknown[] }> = [];
  const prepare = (sql: string) => ({
    _binds: [] as unknown[],
    bind(...values: unknown[]) {
      this._binds = values;
      return this;
    },
    async run() {
      statements.push({ sql, binds: this._binds });
      return { success: true, meta: { changes: 3 } } as unknown as { success: boolean };
    },
    async first<T = unknown>(): Promise<T | null> { return null; },
    async all<T = unknown>() { return { success: true, results: [] as T[] }; },
  });
  const db = {
    prepare,
    async batch() { return []; },
    _statements: statements,
  };
  return db as unknown as Env['DB'] & { _statements: typeof statements };
}

function makeContext(opts: { hostname?: string; env?: Partial<Env> } = {}) {
  const hostname = opts.hostname ?? 'localhost';
  const request = new Request(`http://${hostname}/api/admin/sweep/sessions`, {
    method: 'POST',
  });
  const env: Env = {
    DB: makeDb(),
    R2_BUCKET: undefined as unknown as Env['R2_BUCKET'],
    DEV_ADMIN_ENABLED: 'true',
    ...opts.env,
  };
  return { request, env, params: {} } as unknown as Parameters<typeof onRequestPost>[0];
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('admin session sweep', () => {
  beforeEach(() => {
    recordMock.mockReset();
    recordMock.mockResolvedValue('audit-id');
    pruneMock.mockReset();
    pruneMock.mockResolvedValue(undefined);
  });
  afterEach(() => vi.clearAllMocks());

  it('returns 404 when admin gate denies', async () => {
    const res = await onRequestPost(
      makeContext({ env: { DEV_ADMIN_ENABLED: undefined } }),
    );
    expect(res.status).toBe(404);
    expect(pruneMock).not.toHaveBeenCalled();
    expect(recordMock).not.toHaveBeenCalled();
  });

  it('issues DELETE FROM sessions with absolute-expiry OR idle-expiry WHERE clause', async () => {
    const ctx = makeContext();
    const res = await onRequestPost(ctx);
    expect(res.status).toBe(200);

    const statements = (ctx.env.DB as unknown as { _statements: Array<{ sql: string; binds: unknown[] }> })._statements;
    const deleteStmt = statements.find((s) => s.sql.startsWith('DELETE FROM sessions'));
    expect(deleteStmt).toBeDefined();
    // Both expiry axes must be in the WHERE clause — swapping OR for AND
    // would cause the sweeper to silently clean nothing.
    expect(deleteStmt!.sql).toMatch(/expires_at\s*<\s*\?\s+OR\s+last_seen_at\s*<\s*\?/i);
    // Two timestamp binds: now (for expires_at) and idleCutoff (now - 30d).
    expect(deleteStmt!.binds.length).toBe(2);
    const [nowIso, idleCutoffIso] = deleteStmt!.binds as [string, string];
    expect(new Date(nowIso).getTime()).toBeGreaterThan(new Date(idleCutoffIso).getTime());
    const diffMs = new Date(nowIso).getTime() - new Date(idleCutoffIso).getTime();
    // 30 days ± 1 second slack for test timing
    expect(diffMs).toBeGreaterThan(30 * 24 * 60 * 60 * 1000 - 1000);
    expect(diffMs).toBeLessThan(30 * 24 * 60 * 60 * 1000 + 1000);
  });

  it('invokes pruneExpiredQuotaBuckets (keeps quota table lean)', async () => {
    await onRequestPost(makeContext());
    expect(pruneMock).toHaveBeenCalledTimes(1);
  });

  it('writes a session_swept audit event', async () => {
    await onRequestPost(makeContext());
    expect(recordMock).toHaveBeenCalledTimes(1);
    const input = recordMock.mock.calls[0][1] as unknown as Record<string, unknown>;
    expect(input.eventType).toBe('session_swept');
    expect(input.actor).toBe('sweeper');
    expect(input.severity).toBe('info');
  });

  it('returns a 200 payload with ranAt timestamp', async () => {
    const res = await onRequestPost(makeContext());
    expect(res.status).toBe(200);
    const payload = (await res.json()) as Record<string, unknown>;
    expect(payload.ok).toBe(true);
    expect(typeof payload.ranAt).toBe('string');
    expect(new Date(payload.ranAt as string).toString()).not.toBe('Invalid Date');
  });
});
