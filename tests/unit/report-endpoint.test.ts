/**
 * Handler-level tests for functions/api/capsules/[code]/report.ts.
 *
 * Covers the plan's "abuse report persistence" launch requirement:
 *   - accessible record + first report → persisted
 *   - same IP within 24h → suppressed indistinguishably (still 200)
 *   - inaccessible status → 404 (no existence leak for deleted/rejected)
 *   - unknown share_code → 404
 *   - SESSION_SECRET missing → accept without de-dup (no 500)
 *   - UA forwarded to audit event
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { onRequestPost } from '../../functions/api/capsules/[code]/report';
import type { Env } from '../../functions/env';

// ── Mocks ──────────────────────────────────────────────────────────────────
//
// vi.fn signatures are declared with variadic `unknown[]` so `.mock.calls[n][1]`
// type-checks correctly under strict mode. Mock arguments are cast to
// `Record<string, unknown>` at inspection time.

const recordMock = vi.hoisted(() => vi.fn<(...args: unknown[]) => Promise<string>>());
const hasRecentMock = vi.hoisted(() => vi.fn<(...args: unknown[]) => Promise<boolean>>());
const getIpMock = vi.hoisted(() => vi.fn<(req: Request) => string>());

vi.mock('../../src/share/audit', async () => {
  const actual = await vi.importActual<typeof import('../../src/share/audit')>('../../src/share/audit');
  return {
    ...actual,
    recordAuditEvent: (...args: unknown[]) => recordMock(...args),
    hasRecentAuditEvent: (...args: unknown[]) => hasRecentMock(...args),
    getClientIp: (req: Request) => getIpMock(req),
  };
});

interface ShareRow {
  id: string;
  status: string;
}

function makeDb(row: ShareRow | null) {
  const stmt = {
    bind() { return stmt; },
    async first() { return row; },
    async run() { return { success: true }; },
    async all() { return { success: true, results: [] }; },
  };
  return { prepare: () => stmt, async batch() { return []; } } as unknown as Env['DB'];
}

function makeContext(args: {
  code: string;
  row: ShareRow | null;
  body?: string;
  headers?: Record<string, string>;
  sessionSecret?: string;
}) {
  const request = new Request(`http://localhost/api/capsules/${args.code}/report`, {
    method: 'POST',
    headers: args.headers ?? {},
    body: args.body ?? '',
  });
  const env = {
    DB: makeDb(args.row),
    R2_BUCKET: undefined as unknown as Env['R2_BUCKET'],
    SESSION_SECRET: args.sessionSecret,
  } as Env;
  return {
    request,
    env,
    params: { code: args.code },
  } as unknown as Parameters<typeof onRequestPost>[0];
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('report endpoint', () => {
  beforeEach(() => {
    recordMock.mockReset();
    hasRecentMock.mockReset();
    getIpMock.mockReset();
    recordMock.mockResolvedValue('audit-id');
    hasRecentMock.mockResolvedValue(false);
    getIpMock.mockReturnValue('10.0.0.1');
  });
  afterEach(() => vi.clearAllMocks());

  it('returns 404 for unknown share code', async () => {
    const res = await onRequestPost(
      makeContext({ code: '7M4K2D8Q9T1V', row: null, sessionSecret: 'salt' }),
    );
    expect(res.status).toBe(404);
    expect(recordMock).not.toHaveBeenCalled();
  });

  it('returns 404 for non-accessible (deleted) record — no existence leak', async () => {
    const res = await onRequestPost(
      makeContext({
        code: '7M4K2D8Q9T1V',
        row: { id: 'sh-1', status: 'deleted' },
        sessionSecret: 'salt',
      }),
    );
    expect(res.status).toBe(404);
    expect(recordMock).not.toHaveBeenCalled();
  });

  it('returns 404 for rejected records', async () => {
    const res = await onRequestPost(
      makeContext({
        code: '7M4K2D8Q9T1V',
        row: { id: 'sh-1', status: 'rejected' },
        sessionSecret: 'salt',
      }),
    );
    expect(res.status).toBe(404);
    expect(recordMock).not.toHaveBeenCalled();
  });

  it('returns 404 for invalid share code shape', async () => {
    const res = await onRequestPost(
      makeContext({ code: 'not-a-valid-code!', row: null, sessionSecret: 'salt' }),
    );
    expect(res.status).toBe(404);
    expect(recordMock).not.toHaveBeenCalled();
  });

  it('persists the report for an accessible record (first report from this IP)', async () => {
    const res = await onRequestPost(
      makeContext({
        code: '7M4K2D8Q9T1V',
        row: { id: 'sh-1', status: 'ready' },
        body: JSON.stringify({ reason: 'spam' }),
        headers: { 'User-Agent': 'Mozilla/5.0 test-browser' },
        sessionSecret: 'salt',
      }),
    );
    expect(res.status).toBe(200);
    const payload = (await res.json()) as { received: boolean };
    expect(payload.received).toBe(true);

    expect(recordMock).toHaveBeenCalledTimes(1);
    const input = recordMock.mock.calls[0][1] as unknown as Record<string, unknown>;
    expect(input.eventType).toBe('abuse_report');
    expect(input.actor).toBe('anonymous');
    expect(input.shareId).toBe('sh-1');
    expect(input.shareCode).toBe('7M4K2D8Q9T1V');
    expect(input.reason).toBe('spam');
    // UA forwarded
    expect(input.userAgent).toBe('Mozilla/5.0 test-browser');
    // IP was hashed (sha256 hex, 64 chars) — not the raw IP
    expect(input.ipHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('de-dups same-IP same-day report (still returns 200, does not re-record)', async () => {
    hasRecentMock.mockResolvedValue(true); // duplicate
    const res = await onRequestPost(
      makeContext({
        code: '7M4K2D8Q9T1V',
        row: { id: 'sh-1', status: 'ready' },
        body: JSON.stringify({ reason: 'still spam' }),
        sessionSecret: 'salt',
      }),
    );
    expect(res.status).toBe(200);
    const payload = (await res.json()) as { received: boolean };
    expect(payload.received).toBe(true);

    // Indistinguishable: same 200 response, but no second record.
    expect(recordMock).not.toHaveBeenCalled();
  });

  it('accepts report without de-dup when SESSION_SECRET is missing', async () => {
    const res = await onRequestPost(
      makeContext({
        code: '7M4K2D8Q9T1V',
        row: { id: 'sh-1', status: 'ready' },
        body: JSON.stringify({ reason: 'misconfig env' }),
        // sessionSecret intentionally undefined
      }),
    );
    expect(res.status).toBe(200);
    // De-dup lookup was skipped entirely.
    expect(hasRecentMock).not.toHaveBeenCalled();
    // Report still recorded — but without an ipHash, so de-dup will miss
    // subsequent duplicates from the same IP for that window.
    expect(recordMock).toHaveBeenCalledTimes(1);
    const input = recordMock.mock.calls[0][1] as unknown as Record<string, unknown>;
    expect(input.ipHash).toBeUndefined();
  });

  it('ignores a malformed JSON body and still accepts the report', async () => {
    const res = await onRequestPost(
      makeContext({
        code: '7M4K2D8Q9T1V',
        row: { id: 'sh-1', status: 'ready' },
        body: '{not-json',
        sessionSecret: 'salt',
      }),
    );
    expect(res.status).toBe(200);
    expect(recordMock).toHaveBeenCalledTimes(1);
    const input = recordMock.mock.calls[0][1] as unknown as Record<string, unknown>;
    expect(input.reason).toBeUndefined();
  });

  it('forwards a very long reason raw to recordAuditEvent (helper handles truncation)', async () => {
    // Truncation moved from call sites into recordAuditEvent itself
    // (see tests/unit/audit.test.ts for the defensive-truncation test).
    // The report endpoint now passes the reason through unchanged, so
    // the whole pipeline has a single truncation point and cannot drift.
    const longReason = 'z'.repeat(2000);
    await onRequestPost(
      makeContext({
        code: '7M4K2D8Q9T1V',
        row: { id: 'sh-1', status: 'ready' },
        body: JSON.stringify({ reason: longReason }),
        sessionSecret: 'salt',
      }),
    );
    const input = recordMock.mock.calls[0][1] as unknown as { reason: string };
    expect(input.reason.length).toBe(2000);
  });
});
