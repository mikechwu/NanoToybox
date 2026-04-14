/**
 * Handler-level tests for GET /api/auth/session.
 *
 * Focus: the response contract under the new 200-status-discriminator
 * model and the opportunistic cookie-clear path. Pin:
 *
 *   1. No-cache headers are always set.
 *   2. Signed-in response returns 200 + user fields + no Set-Cookie.
 *   3. Signed-out response WITH a session cookie presented → Set-Cookie
 *      clears the cookie (self-healing).
 *   4. Signed-out response WITHOUT a session cookie → no Set-Cookie.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { onRequestGet } from '../../functions/api/auth/session';
import type { Env } from '../../functions/env';

// Mock the auth-middleware: we control what authenticateRequest returns,
// but keep the real hasSessionCookie + clearSessionCookie so the cookie-
// clear behavior under test runs through the production codepath.
const authMock = vi.hoisted(() => vi.fn<() => Promise<string | null>>());
vi.mock('../../functions/auth-middleware', async () => {
  const actual = await vi.importActual<typeof import('../../functions/auth-middleware')>('../../functions/auth-middleware');
  return {
    ...actual,
    authenticateRequest: (...args: unknown[]) => authMock(...args as Parameters<typeof authMock>),
  };
});

// ── D1 fixture (only needs `first` for the users SELECT in the signed-in path) ──

type UserRow = { id: string; display_name: string | null; created_at: string } | null;

function makeFakeD1(next: UserRow) {
  return {
    prepare() {
      return {
        bind() {
          return {
            first: async () => next,
          };
        },
      };
    },
  };
}

function makeEnv(user: UserRow): Env {
  return {
    DB: makeFakeD1(user) as unknown as Env['DB'],
    R2_BUCKET: undefined as unknown as Env['R2_BUCKET'],
  } as Env;
}

function makeContext(request: Request, env: Env) {
  return { request, env } as unknown as Parameters<typeof onRequestGet>[0];
}

function makeRequest(cookie?: string) {
  const headers = new Headers();
  if (cookie) headers.set('Cookie', cookie);
  return new Request('https://atomdojo.test/api/auth/session', {
    method: 'GET', headers,
  });
}

/** Plain-HTTP localhost request matching the `wrangler pages dev` flow.
 *  Under HTTP the middleware uses the `atomdojo_session_dev` cookie name
 *  (the prod `__Host-` prefix requires Secure + HTTPS, so it's meaningless
 *  on plain HTTP). Self-heal must target the dev cookie on this path. */
function makeDevHttpRequest(cookie?: string) {
  const headers = new Headers();
  if (cookie) headers.set('Cookie', cookie);
  return new Request('http://localhost:8788/api/auth/session', {
    method: 'GET', headers,
  });
}

function clearCookieHeaders(res: Response): string[] {
  const all: string[] = [];
  // Headers.getSetCookie is available on modern runtimes; fall back to
  // iterating the header list entries if the polyfill lacks it.
  const getter = (res.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie;
  if (typeof getter === 'function') return getter.call(res.headers);
  res.headers.forEach((value, key) => {
    if (key.toLowerCase() === 'set-cookie') all.push(value);
  });
  return all;
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('GET /api/auth/session — response contract', () => {
  beforeEach(() => { authMock.mockReset(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('always sets no-cache headers', async () => {
    authMock.mockResolvedValue(null);
    const res = await onRequestGet(makeContext(makeRequest(), makeEnv(null)));
    expect(res.headers.get('Cache-Control')).toBe('no-store, private');
    expect(res.headers.get('Pragma')).toBe('no-cache');
    expect(res.headers.get('Vary')).toBe('Cookie');
  });

  it('signed-in: returns 200 with user fields and no Set-Cookie', async () => {
    authMock.mockResolvedValue('u1');
    const env = makeEnv({
      id: 'u1',
      display_name: 'Alice',
      created_at: '2026-01-01T00:00:00Z',
    });
    const res = await onRequestGet(makeContext(makeRequest('__Host-atomdojo_session=live'), env));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      status: 'signed-in',
      userId: 'u1',
      displayName: 'Alice',
      createdAt: '2026-01-01T00:00:00Z',
    });
    expect(clearCookieHeaders(res)).toEqual([]);
  });

  it('signed-out WITH a stale session cookie: 200 + Set-Cookie clears it', async () => {
    authMock.mockResolvedValue(null);
    const res = await onRequestGet(
      makeContext(makeRequest('__Host-atomdojo_session=stale-sid'), makeEnv(null)),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'signed-out' });
    const setCookies = clearCookieHeaders(res);
    expect(setCookies.length).toBe(1);
    const cookie = setCookies[0];
    // Cleared by setting an empty value with Max-Age=0.
    expect(cookie).toContain('__Host-atomdojo_session=');
    expect(cookie).toContain('Max-Age=0');
  });

  it('signed-out WITHOUT any session cookie: 200 + NO Set-Cookie', async () => {
    authMock.mockResolvedValue(null);
    const res = await onRequestGet(makeContext(makeRequest(), makeEnv(null)));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'signed-out' });
    expect(clearCookieHeaders(res)).toEqual([]);
  });

  it('signed-out with a non-session cookie only: 200 + NO Set-Cookie', async () => {
    authMock.mockResolvedValue(null);
    const res = await onRequestGet(
      makeContext(makeRequest('some-other=thing'), makeEnv(null)),
    );
    expect(clearCookieHeaders(res)).toEqual([]);
  });

  it('authenticated userId but missing user row: 200 signed-out + cookie-clear (race guard)', async () => {
    // Defensive path: middleware returned a userId but users SELECT returns
    // null (vanishingly rare race). Treat as signed-out and still clear.
    authMock.mockResolvedValue('u-vanished');
    const res = await onRequestGet(
      makeContext(makeRequest('__Host-atomdojo_session=live'), makeEnv(null)),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'signed-out' });
    expect(clearCookieHeaders(res).length).toBe(1);
  });

  it('M1: user-row-missing branch logs with [auth.session.user-missing] prefix', async () => {
    // A typo regression in the users SELECT would silently return null for
    // every user and sign everyone out. The defensive log surfaces it.
    authMock.mockResolvedValue('u-AAAAAAAA-long-id');
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    await onRequestGet(
      makeContext(makeRequest('__Host-atomdojo_session=live'), makeEnv(null)),
    );
    const msg = err.mock.calls.map((c) => String(c[0])).join('\n');
    expect(msg).toContain('[auth.session.user-missing]');
    // Short id prefix only — never logs the full userId.
    expect(msg).toContain('u-AAAAAA');
    expect(msg).not.toContain('u-AAAAAAAA-long-id');
    err.mockRestore();
  });

  // ── Dev-cookie self-heal path (plain-HTTP local OAuth fallback) ──
  // On plain HTTP the `__Host-` prefix is unusable (requires Secure), so
  // the middleware uses `atomdojo_session_dev`. Self-heal must target
  // the right cookie for the request's protocol — otherwise the dev
  // cookie would accumulate stale state and leak into repeated probes.

  it('HTTP + stale atomdojo_session_dev cookie: signed-out + Set-Cookie clears the dev cookie', async () => {
    authMock.mockResolvedValue(null);
    const res = await onRequestGet(
      makeContext(makeDevHttpRequest('atomdojo_session_dev=stale-dev-sid'), makeEnv(null)),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'signed-out' });
    const setCookies = clearCookieHeaders(res);
    expect(setCookies.length).toBe(1);
    const cookie = setCookies[0];
    // Dev cookie cleared (no __Host- prefix, no Secure flag).
    expect(cookie).toContain('atomdojo_session_dev=');
    expect(cookie).not.toContain('__Host-');
    expect(cookie).not.toMatch(/;\s*Secure/);
    expect(cookie).toContain('Max-Age=0');
  });

  it('HTTP + only __Host- cookie (wrong protocol for it): no self-heal fires', async () => {
    // A `__Host-` cookie on plain HTTP is a protocol mismatch — the
    // middleware never treats it as a session. Self-heal must also
    // respect the protocol: no Set-Cookie should fire, otherwise we'd
    // generate noise on every dev probe carrying an unrelated prod-prefixed
    // cookie (e.g. leftover from a previous HTTPS session in the same
    // browser profile).
    authMock.mockResolvedValue(null);
    const res = await onRequestGet(
      makeContext(
        makeDevHttpRequest('__Host-atomdojo_session=strayed-from-https'),
        makeEnv(null),
      ),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'signed-out' });
    expect(clearCookieHeaders(res)).toEqual([]);
  });
});
