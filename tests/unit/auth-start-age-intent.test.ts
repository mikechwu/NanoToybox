/**
 * Tests for functions/auth/{google,github}/start.ts — server-authoritative
 * 13+ enforcement (plan Phase B).
 *
 * Non-authenticated callers MUST carry a valid `ageIntent` query nonce.
 * Missing / expired / HMAC-invalid → 400. An already-signed-in user
 * (live session cookie) bypasses the check.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { onRequestGet as googleStart } from '../../functions/auth/google/start';
import { onRequestGet as githubStart } from '../../functions/auth/github/start';
import { createAgeIntent, createSignedIntent } from '../../functions/signed-intents';
import type { Env } from '../../functions/env';

const authMock = vi.hoisted(() => vi.fn<(...args: unknown[]) => Promise<string | null>>());
vi.mock('../../functions/auth-middleware', () => ({
  authenticateRequest: (...args: unknown[]) => authMock(...args),
}));

const SECRET = 'test-secret-32-chars-for-auth-tests';

function env(extra: Partial<Env> = {}): Env {
  return {
    GOOGLE_CLIENT_ID: 'gid',
    GOOGLE_CLIENT_SECRET: 'gsec',
    GITHUB_CLIENT_ID: 'ghid',
    GITHUB_CLIENT_SECRET: 'ghsec',
    SESSION_SECRET: SECRET,
    ...extra,
  } as unknown as Env;
}

function makeReq(url: string): Parameters<typeof googleStart>[0] {
  const request = new Request(url);
  return { request, env: env() } as unknown as Parameters<typeof googleStart>[0];
}

beforeEach(() => {
  authMock.mockReset();
});

describe('auth/google/start — age-gate enforcement', () => {
  it('400 when no ageIntent and no session', async () => {
    authMock.mockResolvedValue(null);
    const res = await googleStart({
      request: new Request('https://example.test/auth/google/start'),
      env: env(),
    } as unknown as Parameters<typeof googleStart>[0]);
    expect(res.status).toBe(400);
  });

  it('400 when ageIntent is HMAC-invalid', async () => {
    authMock.mockResolvedValue(null);
    const res = await googleStart({
      request: new Request('https://example.test/auth/google/start?ageIntent=garbage.sig'),
      env: env(),
    } as unknown as Parameters<typeof googleStart>[0]);
    expect(res.status).toBe(400);
  });

  it('400 when ageIntent carries the wrong kind', async () => {
    authMock.mockResolvedValue(null);
    const wrongKind = await createSignedIntent(SECRET, { kind: 'some_other_intent' }, 300);
    const res = await googleStart({
      request: new Request(`https://example.test/auth/google/start?ageIntent=${wrongKind}`),
      env: env(),
    } as unknown as Parameters<typeof googleStart>[0]);
    expect(res.status).toBe(400);
  });

  it('302 when ageIntent is valid and user is signed-out', async () => {
    authMock.mockResolvedValue(null);
    const token = await createAgeIntent(env());
    const res = await googleStart({
      request: new Request(`https://example.test/auth/google/start?ageIntent=${token}`),
      env: env(),
    } as unknown as Parameters<typeof googleStart>[0]);
    expect(res.status).toBe(302);
    expect(res.headers.get('Location') ?? '').toContain('accounts.google.com');
  });

  it('302 with no ageIntent when the user already has a live session (bypass)', async () => {
    authMock.mockResolvedValue('existing-user');
    const res = await googleStart({
      request: new Request('https://example.test/auth/google/start'),
      env: env(),
    } as unknown as Parameters<typeof googleStart>[0]);
    expect(res.status).toBe(302);
  });
});

describe('auth/github/start — age-gate enforcement (identical contract)', () => {
  it('400 when no ageIntent and no session', async () => {
    authMock.mockResolvedValue(null);
    const res = await githubStart({
      request: new Request('https://example.test/auth/github/start'),
      env: env(),
    } as unknown as Parameters<typeof githubStart>[0]);
    expect(res.status).toBe(400);
  });

  it('302 when ageIntent is valid', async () => {
    authMock.mockResolvedValue(null);
    const token = await createAgeIntent(env());
    const res = await githubStart({
      request: new Request(`https://example.test/auth/github/start?ageIntent=${token}`),
      env: env(),
    } as unknown as Parameters<typeof githubStart>[0]);
    expect(res.status).toBe(302);
    expect(res.headers.get('Location') ?? '').toContain('github.com');
  });
});
