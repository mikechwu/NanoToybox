/**
 * Tests for src/share/audit.ts.
 *
 * Covers: event recording, IP hashing (stable + salt-dependent + not the
 * raw IP), de-dup lookup, day-key formatting, usage counter upsert.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  dayKey,
  getClientIp,
  hashIp,
  hasRecentAuditEvent,
  incrementUsageCounter,
  recordAuditEvent,
} from '../../src/share/audit';
import type { D1Database } from '../../src/share/d1-types';

// ── Mock D1 ─────────────────────────────────────────────────────────────────

interface AuditRow {
  id: string;
  share_id: string | null;
  share_code: string | null;
  event_type: string;
  actor: string;
  severity: string;
  reason: string | null;
  ip_hash: string | null;
  user_agent: string | null;
  created_at: string;
  details_json: string | null;
}

interface CounterRow {
  metric: string;
  day: string;
  count: number;
}

function makeMockDb() {
  const auditRows: AuditRow[] = [];
  const counterRows: CounterRow[] = [];

  const mockStatement = {
    _sql: '',
    _binds: [] as unknown[],
    bind(...values: unknown[]) {
      this._binds = values;
      return this as unknown as ReturnType<D1Database['prepare']>;
    },
    async run() {
      const sql = this._sql;
      if (sql.startsWith('INSERT INTO capsule_share_audit')) {
        const [id, shareId, shareCode, eventType, actor, severity, reason, ipHash, userAgent, createdAt, detailsJson] =
          this._binds as [string, string | null, string | null, string, string, string, string | null, string | null, string | null, string, string | null];
        auditRows.push({
          id, share_id: shareId, share_code: shareCode, event_type: eventType, actor,
          severity, reason, ip_hash: ipHash, user_agent: userAgent, created_at: createdAt,
          details_json: detailsJson,
        });
      } else if (sql.startsWith('INSERT INTO usage_counter')) {
        const [metric, day, delta] = this._binds as [string, string, number];
        const existing = counterRows.find((r) => r.metric === metric && r.day === day);
        if (existing) existing.count += delta;
        else counterRows.push({ metric, day, count: delta });
      }
      return { success: true };
    },
    async first<T = unknown>(): Promise<T | null> {
      const sql = this._sql;
      if (sql.startsWith('SELECT 1 AS hit FROM capsule_share_audit')) {
        const [shareCode, ipHash, eventType, cutoff] = this._binds as [string, string, string, string];
        const hit = auditRows.some(
          (r) =>
            r.share_code === shareCode &&
            r.ip_hash === ipHash &&
            r.event_type === eventType &&
            r.created_at >= cutoff,
        );
        return hit ? ({ hit: 1 } as T) : null;
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
    _audit: auditRows,
    _counters: counterRows,
  } as unknown as D1Database & { _audit: AuditRow[]; _counters: CounterRow[] };

  return db;
}

// ── dayKey ──────────────────────────────────────────────────────────────────

describe('dayKey', () => {
  it('returns YYYY-MM-DD in UTC', () => {
    expect(dayKey(new Date('2026-04-13T15:30:00Z'))).toBe('2026-04-13');
    expect(dayKey(new Date('2026-04-13T23:59:59Z'))).toBe('2026-04-13');
    expect(dayKey(new Date('2026-04-14T00:00:00Z'))).toBe('2026-04-14');
  });
});

// ── hashIp ──────────────────────────────────────────────────────────────────

describe('hashIp', () => {
  it('returns 64-char lowercase hex', async () => {
    const h = await hashIp('1.2.3.4', 'salt');
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is stable for the same (ip, salt)', async () => {
    const a = await hashIp('10.0.0.1', 'secret');
    const b = await hashIp('10.0.0.1', 'secret');
    expect(a).toBe(b);
  });

  it('differs when the salt changes', async () => {
    const a = await hashIp('10.0.0.1', 'saltA');
    const b = await hashIp('10.0.0.1', 'saltB');
    expect(a).not.toBe(b);
  });

  it('differs when the IP changes', async () => {
    const a = await hashIp('10.0.0.1', 'salt');
    const b = await hashIp('10.0.0.2', 'salt');
    expect(a).not.toBe(b);
  });

  it('never contains the raw IP as a substring', async () => {
    const h = await hashIp('192.168.1.42', 'salt');
    expect(h).not.toContain('192');
    expect(h).not.toContain('168');
    expect(h).not.toContain('42');
  });

  it('throws if the salt is empty (prevents accidental unsalted hashes)', async () => {
    await expect(hashIp('1.2.3.4', '')).rejects.toThrow(/salt/i);
  });
});

// ── getClientIp ─────────────────────────────────────────────────────────────

describe('getClientIp', () => {
  it('prefers CF-Connecting-IP', () => {
    const req = new Request('https://x/', {
      headers: { 'CF-Connecting-IP': '1.1.1.1', 'X-Forwarded-For': '2.2.2.2' },
    });
    expect(getClientIp(req)).toBe('1.1.1.1');
  });

  it('falls back to first X-Forwarded-For value', () => {
    const req = new Request('https://x/', {
      headers: { 'X-Forwarded-For': '3.3.3.3, 4.4.4.4' },
    });
    expect(getClientIp(req)).toBe('3.3.3.3');
  });

  it('returns empty string when no header is present', () => {
    const req = new Request('https://x/');
    expect(getClientIp(req)).toBe('');
  });
});

// ── recordAuditEvent ───────────────────────────────────────────────────────

describe('recordAuditEvent', () => {
  it('inserts a row with the expected shape + truncated user agent', async () => {
    const db = makeMockDb();
    const longUa = 'a'.repeat(1000);
    const id = await recordAuditEvent(db, {
      shareId: 'sh1',
      shareCode: '7M4K2D8Q9T1V',
      eventType: 'abuse_report',
      actor: 'anonymous',
      severity: 'info',
      reason: 'spam',
      ipHash: 'deadbeef',
      userAgent: longUa,
      details: { note: 'x' },
    });
    expect(id).toMatch(/^[0-9a-f-]+$/i);

    const rows = (db as unknown as { _audit: Array<{ user_agent: string; details_json: string | null; severity: string }> })._audit;
    expect(rows.length).toBe(1);
    expect(rows[0].user_agent?.length).toBe(500); // truncated
    expect(rows[0].details_json).toBe('{"note":"x"}');
    expect(rows[0].severity).toBe('info');
  });

  it('defaults severity to "info" when not specified', async () => {
    const db = makeMockDb();
    await recordAuditEvent(db, {
      eventType: 'publish_rejected_quota',
      actor: 'u1',
    });
    const rows = (db as unknown as { _audit: Array<{ severity: string }> })._audit;
    expect(rows[0].severity).toBe('info');
  });

  it('truncates a very long reason to MAX_AUDIT_REASON_LENGTH (defensive)', async () => {
    // The helper must truncate defensively so a forgetful caller cannot
    // blow up the audit-row size. Call sites previously sliced manually;
    // after centralization the helper is the single truncation point.
    const db = makeMockDb();
    const longReason = 'z'.repeat(2000);
    await recordAuditEvent(db, {
      eventType: 'abuse_report',
      actor: 'anonymous',
      reason: longReason,
    });
    const rows = (db as unknown as { _audit: Array<{ reason: string | null }> })._audit;
    expect(rows[0].reason?.length).toBe(500);
  });

  it('leaves a short reason untouched', async () => {
    const db = makeMockDb();
    await recordAuditEvent(db, {
      eventType: 'abuse_report',
      actor: 'anonymous',
      reason: 'spam',
    });
    const rows = (db as unknown as { _audit: Array<{ reason: string | null }> })._audit;
    expect(rows[0].reason).toBe('spam');
  });
});

// ── hasRecentAuditEvent ────────────────────────────────────────────────────

describe('hasRecentAuditEvent', () => {
  it('returns true for matching (code, ipHash, eventType) within window', async () => {
    const db = makeMockDb();
    await recordAuditEvent(db, {
      shareCode: 'ABC',
      eventType: 'abuse_report',
      actor: 'anonymous',
      ipHash: 'hashA',
    });
    const hit = await hasRecentAuditEvent(db, {
      shareCode: 'ABC',
      ipHash: 'hashA',
      eventType: 'abuse_report',
    });
    expect(hit).toBe(true);
  });

  it('returns false for different ipHash', async () => {
    const db = makeMockDb();
    await recordAuditEvent(db, {
      shareCode: 'ABC',
      eventType: 'abuse_report',
      actor: 'anonymous',
      ipHash: 'hashA',
    });
    const hit = await hasRecentAuditEvent(db, {
      shareCode: 'ABC',
      ipHash: 'hashB',
      eventType: 'abuse_report',
    });
    expect(hit).toBe(false);
  });

  it('returns false for events older than the window', async () => {
    const db = makeMockDb();
    await recordAuditEvent(
      db,
      {
        shareCode: 'ABC',
        eventType: 'abuse_report',
        actor: 'anonymous',
        ipHash: 'h',
      },
      new Date('2026-04-01T00:00:00Z'),
    );
    const hit = await hasRecentAuditEvent(
      db,
      {
        shareCode: 'ABC',
        ipHash: 'h',
        eventType: 'abuse_report',
        windowSeconds: 60, // 1 minute
      },
      new Date('2026-04-13T00:00:00Z'),
    );
    expect(hit).toBe(false);
  });
});

// ── incrementUsageCounter ──────────────────────────────────────────────────

describe('incrementUsageCounter', () => {
  it('creates a row on first increment', async () => {
    const db = makeMockDb();
    await incrementUsageCounter(db, 'publish_success', new Date('2026-04-13T12:00:00Z'));
    const rows = (db as unknown as { _counters: CounterRow[] })._counters;
    expect(rows).toEqual([{ metric: 'publish_success', day: '2026-04-13', count: 1 }]);
  });

  it('accumulates on subsequent increments for the same (metric, day)', async () => {
    const db = makeMockDb();
    const ts = new Date('2026-04-13T12:00:00Z');
    await incrementUsageCounter(db, 'publish_success', ts);
    await incrementUsageCounter(db, 'publish_success', ts);
    await incrementUsageCounter(db, 'publish_success', ts, 5);
    const rows = (db as unknown as { _counters: CounterRow[] })._counters;
    expect(rows[0].count).toBe(7);
  });

  it('creates a separate row for a new day', async () => {
    const db = makeMockDb();
    await incrementUsageCounter(db, 'publish_success', new Date('2026-04-13T23:59:00Z'));
    await incrementUsageCounter(db, 'publish_success', new Date('2026-04-14T00:01:00Z'));
    const rows = (db as unknown as { _counters: CounterRow[] })._counters;
    expect(rows.length).toBe(2);
  });
});
