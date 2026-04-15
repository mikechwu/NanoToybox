/**
 * Tests for the OAuth callbacks' acceptance-write wiring (D120).
 *
 * Verifies the wiring between the OAuth state payload, the new
 * `findOrCreateUserWithPolicyAcceptance` helper, and the failure-path
 * redirect to `/auth/error`. The helper itself is unit-tested in
 * `policy-acceptance.test.ts`; this file proves that the callback
 * actually invokes it with the right arguments and bails to the
 * error page on failure (no Set-Cookie ever).
 *
 * Three scenarios per provider:
 *   1. State carries `age13PlusConfirmed:true` + new account → 302 with
 *      Set-Cookie (session created), helper called with marker=true.
 *   2. State carries the marker + DB batch fails → 302 to /auth/error
 *      with NO Set-Cookie header.
 *   3. State omits the marker + new account → MissingAge13PlusError
 *      → 302 to /auth/error with NO Set-Cookie header.
 *
 * The provider HTTP fetches (token exchange + userinfo) are mocked so
 * the callback executes from token exchange through to the helper.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { onRequestGet as googleCallback } from '../../functions/auth/google/callback';
import { onRequestGet as githubCallback } from '../../functions/auth/github/callback';
import { createOAuthState } from '../../functions/oauth-state';
import type { Env } from '../../functions/env';

const SECRET = 'x'.repeat(32);

function envWith(extra: Partial<Env> = {}): Env {
  return {
    SESSION_SECRET: SECRET,
    GOOGLE_CLIENT_ID: 'gid',
    GOOGLE_CLIENT_SECRET: 'gsec',
    GITHUB_CLIENT_ID: 'ghid',
    GITHUB_CLIENT_SECRET: 'ghsec',
    ...extra,
  } as unknown as Env;
}

interface FakeStmt {
  _binds: unknown[];
  bind(...vs: unknown[]): FakeStmt;
  run(): Promise<{ success: boolean }>;
  first<T = unknown>(): Promise<T | null>;
}

interface FakeDb extends Record<string, unknown> {
  prepare: (sql: string) => FakeStmt;
  batch: (stmts: FakeStmt[]) => Promise<unknown[]>;
  __writes: Array<{ sql: string; binds: unknown[] }>;
  __existingUserId: string | null;
  __batchFails: boolean;
}

function makeDb(): FakeDb {
  const writes: Array<{ sql: string; binds: unknown[] }> = [];
  let existingUserId: string | null = null;
  let batchFails = false;
  const prepare = (sql: string): FakeStmt => {
    const stmt: FakeStmt = {
      _binds: [],
      bind(...vs: unknown[]) { stmt._binds = vs; return stmt; },
      async run() {
        writes.push({ sql, binds: stmt._binds });
        return { success: true };
      },
      async first<T = unknown>(): Promise<T | null> {
        if (sql.includes('FROM oauth_accounts')) {
          return existingUserId ? ({ user_id: existingUserId } as unknown as T) : null;
        }
        return null;
      },
    };
    return stmt;
  };
  const db = {
    prepare,
    async batch(stmts: FakeStmt[]) {
      if (batchFails) throw new Error('induced batch failure');
      for (const s of stmts) await s.run();
      return [];
    },
    __writes: writes,
    get __existingUserId() { return existingUserId; },
    set __existingUserId(v: string | null) { existingUserId = v; },
    get __batchFails() { return batchFails; },
    set __batchFails(v: boolean) { batchFails = v; },
  } as unknown as FakeDb;
  return db;
}

/** Mock provider HTTP fetches — token exchange + userinfo. */
function mockProviderFetch(provider: 'google' | 'github'): typeof fetch {
  const original = globalThis.fetch;
  globalThis.fetch = vi.fn(async (input) => {
    const url = String(input);
    if (provider === 'google') {
      if (url.includes('oauth2.googleapis.com/token')) {
        return new Response(JSON.stringify({ access_token: 'tok' }), {
          status: 200, headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.includes('googleapis.com/oauth2/v2/userinfo')) {
        return new Response(JSON.stringify({
          id: 'g-1', email: 'a@b.c', verified_email: true, name: 'Alice',
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
    } else {
      if (url.includes('github.com/login/oauth/access_token')) {
        return new Response(JSON.stringify({ access_token: 'tok' }), {
          status: 200, headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.includes('api.github.com/user')) {
        return new Response(JSON.stringify({
          id: 12345, login: 'alice', name: 'Alice', email: 'a@b.c',
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
    }
    return new Response('not mocked', { status: 500 });
  }) as typeof fetch;
  return original;
}

beforeEach(() => { vi.restoreAllMocks(); });
afterEach(() => { vi.restoreAllMocks(); });

describe('Google callback — D120 acceptance wiring', () => {
  it('happy path: state carries age13PlusConfirmed=true + new account → session cookie set + acceptance row written', async () => {
    const db = makeDb();
    const env = envWith({ DB: db as unknown as Env['DB'] });
    const state = await createOAuthState(env, 'google', '/lab/', {
      age13PlusConfirmed: true,
      agePolicyVersion: '2026-04-14.test',
    });
    const original = mockProviderFetch('google');
    try {
      const url = `https://atomdojo.test/auth/google/callback?code=auth-code&state=${encodeURIComponent(state)}`;
      const res = await googleCallback({
        request: new Request(url),
        env,
      } as unknown as Parameters<typeof googleCallback>[0]);
      expect(res.status).toBe(302);
      // Session cookie set on the success path.
      expect(res.headers.get('Set-Cookie')).not.toBeNull();
      // All three INSERTs went through the batch.
      expect(db.__writes.find((w) => w.sql.includes('INSERT INTO users'))).toBeDefined();
      expect(db.__writes.find((w) => w.sql.includes('INSERT INTO oauth_accounts'))).toBeDefined();
      const acceptance = db.__writes.find((w) => w.sql.includes('user_policy_acceptance'));
      expect(acceptance).toBeDefined();
      expect(acceptance!.binds[1]).toBe('2026-04-14.test');
    } finally {
      globalThis.fetch = original;
    }
  });

  it('marker absent + new account → 302 to /auth/error, NO Set-Cookie, NO rows written', async () => {
    const db = makeDb();
    const env = envWith({ DB: db as unknown as Env['DB'] });
    // Mint state WITHOUT the marker (legacy / in-flight state shape).
    const state = await createOAuthState(env, 'google', '/lab/');
    const original = mockProviderFetch('google');
    try {
      const url = `https://atomdojo.test/auth/google/callback?code=auth-code&state=${encodeURIComponent(state)}`;
      const res = await googleCallback({
        request: new Request(url),
        env,
      } as unknown as Parameters<typeof googleCallback>[0]);
      expect(res.status).toBe(302);
      const loc = res.headers.get('Location');
      expect(loc).toContain('/auth/error');
      expect(loc).toContain('reason=acceptance_failed');
      expect(loc).toContain('provider=google');
      // CRITICAL: the acceptance-failure path MUST NOT set a session cookie.
      expect(res.headers.get('Set-Cookie')).toBeNull();
      // No account-linked rows committed.
      expect(db.__writes.find((w) => w.sql.includes('INSERT INTO users'))).toBeUndefined();
      expect(db.__writes.find((w) => w.sql.includes('INSERT INTO oauth_accounts'))).toBeUndefined();
    } finally {
      globalThis.fetch = original;
    }
  });

  it('marker present but DB batch fails → 302 to /auth/error, NO Set-Cookie', async () => {
    const db = makeDb();
    db.__batchFails = true;
    const env = envWith({ DB: db as unknown as Env['DB'] });
    const state = await createOAuthState(env, 'google', '/lab/', {
      age13PlusConfirmed: true,
    });
    const original = mockProviderFetch('google');
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const url = `https://atomdojo.test/auth/google/callback?code=auth-code&state=${encodeURIComponent(state)}`;
      const res = await googleCallback({
        request: new Request(url),
        env,
      } as unknown as Parameters<typeof googleCallback>[0]);
      expect(res.status).toBe(302);
      expect(res.headers.get('Location')).toContain('/auth/error?reason=acceptance_failed');
      expect(res.headers.get('Set-Cookie')).toBeNull();
    } finally {
      globalThis.fetch = original;
      errSpy.mockRestore();
    }
  });

  it('marker absent + EXISTING account → session created, no acceptance row written (publish-428 backstop covers)', async () => {
    const db = makeDb();
    db.__existingUserId = 'existing-user';
    const env = envWith({ DB: db as unknown as Env['DB'] });
    const state = await createOAuthState(env, 'google', '/lab/');
    const original = mockProviderFetch('google');
    try {
      const url = `https://atomdojo.test/auth/google/callback?code=auth-code&state=${encodeURIComponent(state)}`;
      const res = await googleCallback({
        request: new Request(url),
        env,
      } as unknown as Parameters<typeof googleCallback>[0]);
      expect(res.status).toBe(302);
      expect(res.headers.get('Set-Cookie')).not.toBeNull();
      expect(db.__writes.find((w) => w.sql.includes('user_policy_acceptance'))).toBeUndefined();
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe('GitHub callback — D120 acceptance wiring', () => {
  it('happy path: state carries marker → session cookie + acceptance row', async () => {
    const db = makeDb();
    const env = envWith({ DB: db as unknown as Env['DB'] });
    const state = await createOAuthState(env, 'github', '/lab/', {
      age13PlusConfirmed: true,
    });
    const original = mockProviderFetch('github');
    try {
      const url = `https://atomdojo.test/auth/github/callback?code=auth-code&state=${encodeURIComponent(state)}`;
      const res = await githubCallback({
        request: new Request(url),
        env,
      } as unknown as Parameters<typeof githubCallback>[0]);
      expect(res.status).toBe(302);
      expect(res.headers.get('Set-Cookie')).not.toBeNull();
      expect(db.__writes.find((w) => w.sql.includes('user_policy_acceptance'))).toBeDefined();
    } finally {
      globalThis.fetch = original;
    }
  });

  it('marker absent + new account → /auth/error, no cookie, no rows', async () => {
    const db = makeDb();
    const env = envWith({ DB: db as unknown as Env['DB'] });
    const state = await createOAuthState(env, 'github', '/lab/');
    const original = mockProviderFetch('github');
    try {
      const url = `https://atomdojo.test/auth/github/callback?code=auth-code&state=${encodeURIComponent(state)}`;
      const res = await githubCallback({
        request: new Request(url),
        env,
      } as unknown as Parameters<typeof githubCallback>[0]);
      expect(res.status).toBe(302);
      expect(res.headers.get('Location')).toContain('/auth/error?reason=acceptance_failed');
      expect(res.headers.get('Location')).toContain('provider=github');
      expect(res.headers.get('Set-Cookie')).toBeNull();
      expect(db.__writes.find((w) => w.sql.includes('INSERT INTO users'))).toBeUndefined();
    } finally {
      globalThis.fetch = original;
    }
  });
});
