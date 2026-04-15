/**
 * Tests for `functions/policy-acceptance.ts`.
 *
 * Covers:
 *   1. `recordAge13PlusAcceptance` — UPSERT + best-effort audit.
 *   2. `findOrCreateUserWithPolicyAcceptance` — all four branches:
 *      (A) marker absent + new account → throws MissingAge13PlusError, NO rows.
 *      (B) marker absent + existing account → no acceptance, no rows changed.
 *      (C) marker present + new account → atomic batch writes 3 rows.
 *      (D) marker present + existing account → acceptance UPSERT only.
 *   3. `redirectToAuthError` — absolute URL via `new URL(..., request.url)`.
 *
 * Atomicity guard: induced batch failure on the new-user path leaves
 * NO partially-committed rows.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  recordAge13PlusAcceptance,
  findOrCreateUserWithPolicyAcceptance,
  redirectToAuthError,
  MissingAge13PlusError,
} from '../../functions/policy-acceptance';
import type { Env } from '../../functions/env';

interface FakeStmt {
  _binds: unknown[];
  bind: (...vs: unknown[]) => FakeStmt;
  run: () => Promise<{ success: boolean }>;
  first: <T = unknown>() => Promise<T | null>;
}

interface FakeDbRecorder {
  writes: Array<{ sql: string; binds: unknown[] }>;
  /** Set to non-null to make subsequent SELECTs on oauth_accounts return
   *  this user_id. Models the existing-account branches. */
  existingUserId: string | null;
  /** When true, every batch() call rejects — exercises the atomicity
   *  contract on the new-user path. */
  batchFails: boolean;
  /** When true, every audit recordAuditEvent INSERT throws — exercises
   *  the "audit failure does not throw" path. */
  auditFails: boolean;
}

function makeDb(): { db: Env['DB']; rec: FakeDbRecorder } {
  const rec: FakeDbRecorder = {
    writes: [],
    existingUserId: null,
    batchFails: false,
    auditFails: false,
  };
  const prepare = (sql: string): FakeStmt => {
    const stmt: FakeStmt = {
      _binds: [],
      bind(...vs: unknown[]) { stmt._binds = vs; return stmt; },
      async run() {
        if (rec.auditFails && sql.includes('capsule_share_audit')) {
          throw new Error('audit table down');
        }
        rec.writes.push({ sql, binds: stmt._binds });
        return { success: true };
      },
      async first<T = unknown>(): Promise<T | null> {
        if (sql.includes('FROM oauth_accounts')) {
          return rec.existingUserId
            ? ({ user_id: rec.existingUserId } as unknown as T)
            : null;
        }
        return null;
      },
    };
    return stmt;
  };
  const db = {
    prepare,
    async batch(stmts: FakeStmt[]) {
      if (rec.batchFails) {
        // D1 batches are atomic — a failure leaves nothing committed.
        // We model this by throwing WITHOUT recording any writes.
        throw new Error('batch failed');
      }
      for (const s of stmts) {
        await s.run();
      }
      return [];
    },
  } as unknown as Env['DB'];
  return { db, rec };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('recordAge13PlusAcceptance', () => {
  it('writes the UPSERT + emits the audit event', async () => {
    const { db, rec } = makeDb();
    await recordAge13PlusAcceptance(db, 'user-1', '2026-04-14.test');
    const upsert = rec.writes.find((w) => w.sql.includes('user_policy_acceptance'));
    expect(upsert).toBeDefined();
    expect(upsert!.binds[0]).toBe('user-1');
    expect(upsert!.binds[1]).toBe('2026-04-14.test');
    expect(upsert!.sql).toContain('ON CONFLICT');
    // Audit emission also happens.
    const audit = rec.writes.find((w) => w.sql.includes('capsule_share_audit'));
    expect(audit).toBeDefined();
  });

  it('audit failure does NOT throw — caller still resolves', async () => {
    const { db, rec } = makeDb();
    rec.auditFails = true;
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(
      recordAge13PlusAcceptance(db, 'user-1', '2026-04-14.test'),
    ).resolves.toBeUndefined();
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });
});

describe('findOrCreateUserWithPolicyAcceptance — branch matrix', () => {
  it('(A) marker absent + new account → throws MissingAge13PlusError, NO rows', async () => {
    const { db, rec } = makeDb();
    rec.existingUserId = null;
    await expect(
      findOrCreateUserWithPolicyAcceptance(db, {
        provider: 'google',
        providerAccountId: 'g123',
        email: null,
        emailVerified: false,
        displayName: null,
      }, { age13PlusConfirmed: false, policyVersion: '2026-04-14.test' }),
    ).rejects.toBeInstanceOf(MissingAge13PlusError);
    // Critical: no users / oauth_accounts / acceptance writes happened.
    expect(rec.writes.length).toBe(0);
  });

  it('(B) marker absent + existing account → no acceptance write, no row mutation', async () => {
    const { db, rec } = makeDb();
    rec.existingUserId = 'existing-user';
    const result = await findOrCreateUserWithPolicyAcceptance(db, {
      provider: 'google',
      providerAccountId: 'g123',
      email: null,
      emailVerified: false,
      displayName: null,
    }, { age13PlusConfirmed: false, policyVersion: '2026-04-14.test' });
    expect(result).toEqual({
      userId: 'existing-user',
      createdUser: false,
      acceptanceRecorded: false,
    });
    expect(rec.writes.length).toBe(0);
  });

  it('(C) marker present + new account → atomic batch writes users + oauth_accounts + acceptance', async () => {
    const { db, rec } = makeDb();
    rec.existingUserId = null;
    const result = await findOrCreateUserWithPolicyAcceptance(db, {
      provider: 'google',
      providerAccountId: 'g123',
      email: 'new@example.com',
      emailVerified: true,
      displayName: 'New User',
    }, { age13PlusConfirmed: true, policyVersion: '2026-04-14.test' });

    expect(result.createdUser).toBe(true);
    expect(result.acceptanceRecorded).toBe(true);
    expect(typeof result.userId).toBe('string');

    // All three INSERTs went through the batch.
    expect(rec.writes.find((w) => w.sql.includes('INSERT INTO users'))).toBeDefined();
    expect(rec.writes.find((w) => w.sql.includes('INSERT INTO oauth_accounts'))).toBeDefined();
    const acceptance = rec.writes.find((w) => w.sql.includes('user_policy_acceptance'));
    expect(acceptance).toBeDefined();
    expect(acceptance!.binds[0]).toBe(result.userId);
    expect(acceptance!.binds[1]).toBe('2026-04-14.test');
    // Audit also emitted out-of-batch.
    expect(rec.writes.find((w) => w.sql.includes('capsule_share_audit'))).toBeDefined();
  });

  it('(D) marker present + existing account → acceptance UPSERT only, no user/oauth writes', async () => {
    const { db, rec } = makeDb();
    rec.existingUserId = 'existing-user';
    const result = await findOrCreateUserWithPolicyAcceptance(db, {
      provider: 'github',
      providerAccountId: 'gh-456',
      email: null,
      emailVerified: false,
      displayName: 'Existing',
    }, { age13PlusConfirmed: true, policyVersion: '2026-04-14.test' });
    expect(result).toEqual({
      userId: 'existing-user',
      createdUser: false,
      acceptanceRecorded: true,
    });
    expect(rec.writes.find((w) => w.sql.includes('INSERT INTO users'))).toBeUndefined();
    expect(rec.writes.find((w) => w.sql.includes('INSERT INTO oauth_accounts'))).toBeUndefined();
    const acceptance = rec.writes.find((w) => w.sql.includes('user_policy_acceptance'));
    expect(acceptance).toBeDefined();
    expect(acceptance!.binds[0]).toBe('existing-user');
  });

  it('atomicity: batch failure on new-user path leaves NO partially-committed rows', async () => {
    const { db, rec } = makeDb();
    rec.existingUserId = null;
    rec.batchFails = true;
    await expect(
      findOrCreateUserWithPolicyAcceptance(db, {
        provider: 'google',
        providerAccountId: 'g999',
        email: null,
        emailVerified: false,
        displayName: null,
      }, { age13PlusConfirmed: true, policyVersion: '2026-04-14.test' }),
    ).rejects.toThrow(/batch failed/);
    // The batch failed atomically — no users / oauth_accounts / acceptance writes.
    expect(rec.writes.length).toBe(0);
  });
});

describe('redirectToAuthError', () => {
  it('returns a 302 with absolute URL constructed from request.url', () => {
    const request = new Request('https://atomdojo.test/auth/google/callback?code=abc');
    const res = redirectToAuthError(request, 'google', 'acceptance_failed');
    expect(res.status).toBe(302);
    const loc = res.headers.get('Location');
    expect(loc).not.toBeNull();
    expect(loc).toContain('https://atomdojo.test/auth/error');
    expect(loc).toContain('reason=acceptance_failed');
    expect(loc).toContain('provider=google');
  });

  it('does NOT include a Set-Cookie header', () => {
    const request = new Request('https://atomdojo.test/auth/google/callback');
    const res = redirectToAuthError(request, 'google', 'acceptance_failed');
    expect(res.headers.get('Set-Cookie')).toBeNull();
  });
});
