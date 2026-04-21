/**
 * Handler-level tests for
 * functions/api/admin/backfill-preview-scenes.ts (ADR D138 Lane A).
 *
 * Covers:
 *   - admin gate (404 on unauthorized)
 *   - flag pass-through to the backfillPreviewScenes library
 *   - success: HTTP 200 + BackfillSummary body
 *   - partial failure: HTTP 200, audit severity='warning'
 *   - pure failure: HTTP 500, audit severity='critical'
 *   - audit-event contract (eventType + severity + details_json shape)
 *   - dryRun flag forwarding
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { onRequestPost } from '../../functions/api/admin/backfill-preview-scenes';
import type { Env } from '../../functions/env';

const recordMock = vi.hoisted(() => vi.fn<(...args: unknown[]) => Promise<string>>());
vi.mock('../../src/share/audit', async () => {
  const actual = await vi.importActual<typeof import('../../src/share/audit')>(
    '../../src/share/audit',
  );
  return {
    ...actual,
    recordAuditEvent: (...args: unknown[]) => recordMock(...args),
  };
});

const backfillMock = vi.hoisted(() =>
  vi.fn<(...args: unknown[]) => Promise<{
    scanned: number;
    updated: number;
    skipped: number;
    failed: Array<{ id: string; reason: string }>;
  }>>(),
);
vi.mock('../../scripts/backfill-preview-scenes', () => ({
  backfillPreviewScenes: (...args: unknown[]) => backfillMock(...args),
}));

function makeDb() {
  const prepare = (_sql: string) => ({
    bind: (..._binds: unknown[]) => ({
      async run() { return { success: true } as unknown; },
      async first<T = unknown>(): Promise<T | null> { return null; },
      async all<T = unknown>() { return { success: true, results: [] as T[] }; },
    }),
  });
  return { prepare, async batch() { return []; } } as unknown as Env['DB'];
}

function makeR2() {
  return {
    async get(_key: string) { return null; },
  } as unknown as Env['R2_BUCKET'];
}

function makeContext(opts: {
  hostname?: string;
  env?: Partial<Env>;
  body?: unknown;
  headers?: Record<string, string>;
} = {}) {
  const hostname = opts.hostname ?? 'localhost';
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...opts.headers,
  };
  const request = new Request(`http://${hostname}/api/admin/backfill-preview-scenes`, {
    method: 'POST',
    headers,
    body: opts.body === undefined ? '{}' : JSON.stringify(opts.body),
  });
  const env: Env = {
    DB: makeDb(),
    R2_BUCKET: makeR2(),
    DEV_ADMIN_ENABLED: 'true',
    ...opts.env,
  };
  return { request, env, params: {} } as unknown as Parameters<typeof onRequestPost>[0];
}

describe('POST /api/admin/backfill-preview-scenes', () => {
  beforeEach(() => {
    recordMock.mockReset();
    recordMock.mockResolvedValue('audit-id');
    backfillMock.mockReset();
  });
  afterEach(() => vi.clearAllMocks());

  it('returns 404 when unauthorized (no localhost, no X-Cron-Secret)', async () => {
    const res = await onRequestPost(
      makeContext({
        hostname: 'atomdojo.pages.dev',
        env: { DEV_ADMIN_ENABLED: undefined },
      }),
    );
    expect(res.status).toBe(404);
    expect(backfillMock).not.toHaveBeenCalled();
    expect(recordMock).not.toHaveBeenCalled();
  });

  it('returns 404 on wrong cron secret from non-localhost', async () => {
    const res = await onRequestPost(
      makeContext({
        hostname: 'atomdojo.pages.dev',
        env: { DEV_ADMIN_ENABLED: undefined, CRON_SECRET: 'right' },
        headers: { 'X-Cron-Secret': 'wrong' },
      }),
    );
    expect(res.status).toBe(404);
    expect(backfillMock).not.toHaveBeenCalled();
  });

  it('authorized cron-secret request forwards flags + bindings to the library', async () => {
    backfillMock.mockResolvedValue({
      scanned: 5, updated: 5, skipped: 0, failed: [],
    });
    const ctx = makeContext({
      hostname: 'atomdojo.pages.dev',
      env: { DEV_ADMIN_ENABLED: undefined, CRON_SECRET: 's3cret' },
      headers: { 'X-Cron-Secret': 's3cret' },
      body: { force: true, pageSize: 50, verbose: true, dryRun: false },
    });
    const res = await onRequestPost(ctx);
    expect(res.status).toBe(200);
    expect(backfillMock).toHaveBeenCalledTimes(1);
    const libOpts = backfillMock.mock.calls[0][0] as Record<string, unknown>;
    expect(libOpts.force).toBe(true);
    expect(libOpts.pageSize).toBe(50);
    expect(libOpts.verbose).toBe(true);
    // Both rev constants must be forwarded so the backfill
    // predicate can classify stale rows by EITHER shape. The
    // literal floors below match `CURRENT_THUMB_REV` /
    // `CURRENT_SCENE_REV` at the time of this test — bump both in
    // lockstep when the constants move; the JSDoc above each
    // constant carries the history.
    expect(libOpts.currentThumbRev).toBe(15);
    expect(libOpts.currentSceneRev).toBe(2);
    // `db` and `r2` MUST also be forwarded — the library cannot run
    // without them. A regression that drops them from the options
    // bundle would still pass the other assertions; lock them down.
    expect(libOpts.db).toBeDefined();
    expect(libOpts.r2).toBeDefined();
  });

  it('localhost + DEV_ADMIN_ENABLED=true bypasses cron-secret (actor=admin)', async () => {
    backfillMock.mockResolvedValue({
      scanned: 0, updated: 0, skipped: 0, failed: [],
    });
    const res = await onRequestPost(
      makeContext({
        hostname: 'localhost',
        env: { DEV_ADMIN_ENABLED: 'true' },
      }),
    );
    expect(res.status).toBe(200);
    expect(backfillMock).toHaveBeenCalledTimes(1);
    const auditInput = recordMock.mock.calls[0][1] as Record<string, unknown>;
    expect(auditInput.actor).toBe('admin');
  });

  it('success returns BackfillSummary as JSON with HTTP 200', async () => {
    backfillMock.mockResolvedValue({
      scanned: 5, updated: 5, skipped: 0, failed: [],
    });
    const res = await onRequestPost(makeContext());
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body).toEqual({
      scanned: 5, updated: 5, skipped: 0, failed: [],
    });
  });

  it('partial failure stays HTTP 200 with warning audit severity', async () => {
    backfillMock.mockResolvedValue({
      scanned: 5, updated: 4, skipped: 0,
      failed: [{ id: 'x', reason: 'bad' }],
    });
    const res = await onRequestPost(makeContext());
    expect(res.status).toBe(200);
    expect(recordMock).toHaveBeenCalledTimes(1);
    const auditInput = recordMock.mock.calls[0][1] as Record<string, unknown>;
    expect(auditInput.eventType).toBe('preview_backfill_run');
    expect(auditInput.severity).toBe('warning');
  });

  it('pure failure returns HTTP 500 with critical audit severity', async () => {
    backfillMock.mockResolvedValue({
      scanned: 5, updated: 0, skipped: 0,
      failed: [
        { id: 'x', reason: 'bad' },
        { id: 'y', reason: 'bad' },
      ],
    });
    const res = await onRequestPost(makeContext());
    expect(res.status).toBe(500);
    const auditInput = recordMock.mock.calls[0][1] as Record<string, unknown>;
    expect(auditInput.eventType).toBe('preview_backfill_run');
    expect(auditInput.severity).toBe('critical');
  });

  it('audit event details_json shape matches the documented contract', async () => {
    backfillMock.mockResolvedValue({
      scanned: 5, updated: 4, skipped: 1,
      failed: [{ id: 'x', reason: 'bad' }],
    });
    await onRequestPost(
      makeContext({
        body: { force: true, pageSize: 50, verbose: false, dryRun: false },
      }),
    );
    const auditInput = recordMock.mock.calls[0][1] as Record<string, unknown>;
    expect(auditInput.eventType).toBe('preview_backfill_run');
    const details = auditInput.details as Record<string, unknown>;
    expect(details).toEqual({
      dryRun: false,
      force: true,
      pageSize: 50,
      currentThumbRev: 15,
      currentSceneRev: 2,
      scanned: 5,
      updated: 4,
      skipped: 1,
      failedCount: 1,
    });
  });

  it('dryRun=true forwards the flag and records it in details_json', async () => {
    backfillMock.mockResolvedValue({
      scanned: 3, updated: 3, skipped: 0, failed: [],
    });
    const res = await onRequestPost(
      makeContext({ body: { dryRun: true, verbose: true } }),
    );
    expect(res.status).toBe(200);
    const auditInput = recordMock.mock.calls[0][1] as Record<string, unknown>;
    const details = auditInput.details as Record<string, unknown>;
    expect(details.dryRun).toBe(true);
  });
});
