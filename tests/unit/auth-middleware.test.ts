/**
 * Tests for the canonical authenticateRequest contract.
 *
 * Focus: the orphan-session gap. /api/auth/session treats a session whose
 * users row is missing as signed-out, but authenticateRequest used to
 * validate purely from the sessions table and therefore could accept an
 * orphan cookie as authorized for protected actions. The LEFT JOIN + user-
 * existence guard fixed that. These tests pin the new contract:
 *
 *   1. Valid session with valid user → userId returned.
 *   2. Missing session row → null.
 *   3. Orphan session (user row deleted) → null AND the orphan is deleted
 *      from the sessions table (side effect).
 *   4. Expired session → null.
 *   5. Idle-expired session → null.
 *   6. Missing cookie / missing cookie name → null.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { authenticateRequest, hasSessionCookie } from '../../functions/auth-middleware';
import type { Env } from '../../functions/env';

// ── Minimal D1-shaped fixture ──────────────────────────────────────────────

type FirstResult = {
  user_id: string;
  expires_at: string;
  last_seen_at: string;
  user_row_id: string | null;
} | null;

/** Build a fake D1 where each prepare().bind().first() call returns the next
 *  queued result, and each run() resolves with an empty summary. Tracks the
 *  SQL + bind args so tests can assert the orphan DELETE side effect fired. */
function makeFakeD1() {
  const calls: Array<{ sql: string; binds: unknown[] }> = [];
  const firstQueue: FirstResult[] = [];
  const runCalls: Array<{ sql: string; binds: unknown[] }> = [];
  const api = {
    prepare(sql: string) {
      const record = { sql, binds: [] as unknown[] };
      calls.push(record);
      const stmt = {
        bind(...binds: unknown[]) {
          record.binds = binds;
          return stmt;
        },
        async first<T>() {
          const next = firstQueue.shift();
          return next as T | null;
        },
        async run() {
          runCalls.push({ sql, binds: record.binds });
          return { success: true, meta: {} };
        },
      };
      return stmt;
    },
    // For tests that want to queue SELECT results.
    __queueFirst(result: FirstResult) { firstQueue.push(result); },
    __calls: calls,
    __runCalls: runCalls,
  };
  return api;
}

function makeRequest(cookie?: string) {
  const headers = new Headers();
  if (cookie) headers.set('Cookie', cookie);
  return new Request('https://atomdojo.test/api/capsules/publish', {
    method: 'POST', headers,
  });
}

function makeEnv(db: ReturnType<typeof makeFakeD1>): Env {
  return {
    DB: db as unknown as Env['DB'],
    R2_BUCKET: undefined as unknown as Env['R2_BUCKET'],
    // AUTH_DEV_USER_ID intentionally unset so the dev-bypass branch does
    // NOT fire for these production-path tests.
  } as Env;
}

function isoFuture(ms: number): string {
  return new Date(Date.now() + ms).toISOString();
}

function isoPast(ms: number): string {
  return new Date(Date.now() - ms).toISOString();
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('authenticateRequest — orphan-session handling', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it('returns userId for a valid session whose user row still exists', async () => {
    const db = makeFakeD1();
    db.__queueFirst({
      user_id: 'u1',
      expires_at: isoFuture(60_000),
      last_seen_at: new Date().toISOString(),
      user_row_id: 'u1', // JOIN returned a row — user exists.
    });
    const req = makeRequest('__Host-atomdojo_session=s1');
    const userId = await authenticateRequest(req, makeEnv(db));
    expect(userId).toBe('u1');
    // No DELETE side effect on the happy path.
    expect(db.__runCalls.some((c) => /DELETE FROM sessions/i.test(c.sql))).toBe(false);
  });

  it('returns null AND deletes the orphan session when the user row is missing', async () => {
    const db = makeFakeD1();
    db.__queueFirst({
      user_id: 'u-deleted',
      expires_at: isoFuture(60_000),
      last_seen_at: new Date().toISOString(),
      user_row_id: null, // LEFT JOIN returned null — user was deleted.
    });
    const req = makeRequest('__Host-atomdojo_session=orphan-sid');
    const userId = await authenticateRequest(req, makeEnv(db));
    expect(userId).toBeNull();

    // The orphan row is cleaned up so subsequent requests skip the join.
    // The delete is fire-and-forget, so give it a tick to land.
    await new Promise((r) => setTimeout(r, 0));
    const deleteCall = db.__runCalls.find((c) => /DELETE FROM sessions/i.test(c.sql));
    expect(deleteCall).toBeDefined();
    expect(deleteCall?.binds).toEqual(['orphan-sid']);
  });

  it('returns null when the session row itself is missing (no DELETE side effect)', async () => {
    const db = makeFakeD1();
    db.__queueFirst(null);
    const req = makeRequest('__Host-atomdojo_session=unknown-sid');
    const userId = await authenticateRequest(req, makeEnv(db));
    expect(userId).toBeNull();
    expect(db.__runCalls.some((c) => /DELETE FROM sessions/i.test(c.sql))).toBe(false);
  });

  it('returns null for an expired session (expires_at in the past)', async () => {
    const db = makeFakeD1();
    db.__queueFirst({
      user_id: 'u1',
      expires_at: isoPast(60_000),
      last_seen_at: isoPast(30_000),
      user_row_id: 'u1',
    });
    const req = makeRequest('__Host-atomdojo_session=expired');
    const userId = await authenticateRequest(req, makeEnv(db));
    expect(userId).toBeNull();
  });

  it('returns null for an idle-expired session (last_seen_at > 30d ago)', async () => {
    const db = makeFakeD1();
    db.__queueFirst({
      user_id: 'u1',
      expires_at: isoFuture(60_000),
      // 31 days ago — past the 30-day idle TTL.
      last_seen_at: isoPast(31 * 24 * 60 * 60 * 1000),
      user_row_id: 'u1',
    });
    const req = makeRequest('__Host-atomdojo_session=idle');
    const userId = await authenticateRequest(req, makeEnv(db));
    expect(userId).toBeNull();
  });

  it('returns null when the request has no Cookie header', async () => {
    const db = makeFakeD1();
    const userId = await authenticateRequest(makeRequest(), makeEnv(db));
    expect(userId).toBeNull();
    // Never reached D1.
    expect(db.__calls.length).toBe(0);
  });

  it('returns null when the session cookie is absent from a present Cookie header', async () => {
    const db = makeFakeD1();
    const userId = await authenticateRequest(
      makeRequest('other-cookie=whatever'),
      makeEnv(db),
    );
    expect(userId).toBeNull();
    expect(db.__calls.length).toBe(0);
  });
});

// ── hasSessionCookie protocol-scoping ──────────────────────────────────────
//
// The helper picks the cookie name by request protocol (__Host-atomdojo_session
// on https, atomdojo_session_dev on plain http). The session endpoint's
// self-heal path relies on this being strict: a `__Host-` cookie carried on
// plain HTTP must NOT count as "has a session cookie" (and vice versa) —
// otherwise we'd emit stray Set-Cookie clears on protocol-mismatched state.

describe('hasSessionCookie — protocol scoping', () => {
  function req(url: string, cookie?: string): Request {
    const headers = new Headers();
    if (cookie) headers.set('Cookie', cookie);
    return new Request(url, { method: 'GET', headers });
  }

  it('https + __Host-atomdojo_session → true', () => {
    expect(hasSessionCookie(
      req('https://atomdojo.test/api/auth/session', '__Host-atomdojo_session=abc'),
    )).toBe(true);
  });

  it('http://localhost + atomdojo_session_dev → true', () => {
    expect(hasSessionCookie(
      req('http://localhost:8788/api/auth/session', 'atomdojo_session_dev=abc'),
    )).toBe(true);
  });

  it('https + atomdojo_session_dev only → false (wrong cookie for protocol)', () => {
    expect(hasSessionCookie(
      req('https://atomdojo.test/api/auth/session', 'atomdojo_session_dev=abc'),
    )).toBe(false);
  });

  it('http://localhost + __Host- cookie only → false (wrong cookie for protocol)', () => {
    expect(hasSessionCookie(
      req('http://localhost:8788/api/auth/session', '__Host-atomdojo_session=abc'),
    )).toBe(false);
  });

  it('no Cookie header → false', () => {
    expect(hasSessionCookie(req('https://atomdojo.test/api/auth/session'))).toBe(false);
  });

  it('Cookie header present but no session cookie → false', () => {
    expect(hasSessionCookie(
      req('https://atomdojo.test/api/auth/session', 'unrelated=1; other=2'),
    )).toBe(false);
  });
});

// ── Audit fix H5: orphan DELETE dedupe + distinctive logging ────────────────

describe('authenticateRequest — orphan DELETE dedupe + logging (H5)', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it('logs with the [auth.orphan-delete-failed] prefix when DELETE fails', async () => {
    // Build a DB where first() returns an orphan row, but run() rejects.
    let firstCallCount = 0;
    let runCallCount = 0;
    const db = {
      prepare(sql: string) {
        const stmt = {
          _sql: sql,
          _binds: [] as unknown[],
          bind(...binds: unknown[]) { this._binds = binds; return this; },
          async first() {
            firstCallCount++;
            return {
              user_id: 'u-deleted',
              expires_at: isoFuture(60_000),
              last_seen_at: new Date().toISOString(),
              user_row_id: null,
            };
          },
          async run() {
            runCallCount++;
            throw new Error('D1 region unreachable');
          },
        };
        return stmt;
      },
    };
    const req = makeRequest('__Host-atomdojo_session=dedupe-test-sid-AAA');
    const userId = await authenticateRequest(req, {
      DB: db as unknown as Env['DB'],
      R2_BUCKET: undefined as unknown as Env['R2_BUCKET'],
    } as Env);
    expect(userId).toBeNull();
    // Wait for the fire-and-forget DELETE to reject.
    await new Promise((r) => setTimeout(r, 10));
    expect(runCallCount).toBe(1);
    const errMsg = (console.error as ReturnType<typeof vi.spyOn>).mock.calls
      .map((c: unknown[]) => String(c[0])).join('\n');
    expect(errMsg).toMatch(/\[auth\.orphan-delete-failed\]/);
    // Log includes a short sid prefix, NOT the full session id.
    expect(errMsg).toContain('dedupe-t');
    expect(errMsg).not.toContain('dedupe-test-sid-AAA');
    // `first` was consulted once.
    expect(firstCallCount).toBe(1);
  });

  it('dedupes the DELETE for the same orphan sessionId within one isolate lifetime', async () => {
    // Two consecutive requests with the SAME orphan session id should
    // result in at most ONE run() call to D1 (dedupe in-memory).
    let runCallCount = 0;
    const db = {
      prepare(sql: string) {
        const stmt = {
          _sql: sql,
          _binds: [] as unknown[],
          bind(...binds: unknown[]) { this._binds = binds; return this; },
          async first() {
            return {
              user_id: 'u-deleted',
              expires_at: isoFuture(60_000),
              last_seen_at: new Date().toISOString(),
              user_row_id: null,
            };
          },
          async run() {
            runCallCount++;
            // Return a pending promise so the dedupe set doesn't clear
            // between the two calls via rejection handling.
            return new Promise(() => { /* never resolves */ });
          },
        };
        return stmt;
      },
    };
    const env = {
      DB: db as unknown as Env['DB'],
      R2_BUCKET: undefined as unknown as Env['R2_BUCKET'],
    } as Env;
    // Use a distinct session id so this test doesn't collide with others'
    // dedupe set entries (module-scoped Set persists across tests).
    const sid = `dedupe-concurrent-${Math.random()}`;
    await authenticateRequest(makeRequest(`__Host-atomdojo_session=${sid}`), env);
    await authenticateRequest(makeRequest(`__Host-atomdojo_session=${sid}`), env);
    // Only ONE DELETE fired — the second request saw the sid in the dedupe set.
    expect(runCallCount).toBe(1);
  });
});
