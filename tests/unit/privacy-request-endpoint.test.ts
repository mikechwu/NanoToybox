/**
 * Tests for POST /api/privacy-request (Phase 7 Option B).
 *
 * Critical paths:
 *   - 401 invalid_nonce when nonce missing or wrong-kind / expired
 *   - 200 honeypot no-op when honeypot field is non-empty
 *   - 400 invalid_request for malformed body / unknown request_type
 *   - 400 message_too_long on >2000 chars (NOT a 413; new envelope)
 *   - 429 rate_limited when D1 quota exceeded
 *   - 200 ok with id on a clean submission; row inserted into D1
 *   - Optional auth: signed-in submission records user_id; signed-out leaves it null
 *   - Body-dedup: identical (contact, message) within 24h returns prior id
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { onRequestPost } from '../../functions/api/privacy-request';
import { onRequestGet as nonceGet } from '../../functions/api/privacy-request/nonce';
import { createPrivacyRequestIntent, createSignedIntent } from '../../functions/signed-intents';
import type { Env } from '../../functions/env';

const SECRET = 'test-secret-32-chars-for-privacy-request-tests';

const authMock = vi.hoisted(() => vi.fn<(...args: unknown[]) => Promise<string | null>>());
vi.mock('../../functions/auth-middleware', () => ({
  authenticateRequest: (...args: unknown[]) => authMock(...args),
}));

const checkQuotaMock = vi.hoisted(() => vi.fn());
const consumeQuotaMock = vi.hoisted(() => vi.fn());
vi.mock('../../src/share/rate-limit', async () => {
  const actual = await vi.importActual<typeof import('../../src/share/rate-limit')>(
    '../../src/share/rate-limit',
  );
  return {
    ...actual,
    checkPrivacyRequestQuota: (...args: unknown[]) => checkQuotaMock(...args),
    consumePrivacyRequestQuota: (...args: unknown[]) => consumeQuotaMock(...args),
  };
});

interface FakeRow {
  id?: string;
  contact_value?: string;
  message?: string;
  user_id?: string | null;
  created_at?: number;
}

function makeDb(opts: { existing?: FakeRow | null } = {}) {
  const inserts: Array<{ sql: string; binds: unknown[] }> = [];
  const prepare = (sql: string) => ({
    _binds: [] as unknown[],
    bind(...vs: unknown[]) { this._binds = vs; return this; },
    async run() { inserts.push({ sql, binds: this._binds }); return { success: true }; },
    async first<T = unknown>(): Promise<T | null> {
      if (sql.includes('FROM privacy_requests')) return (opts.existing ?? null) as unknown as T;
      return null;
    },
    async all<T = unknown>() { return { success: true, results: [] as T[] }; },
  });
  return {
    db: { prepare, async batch() { return []; } } as unknown as Env['DB'],
    inserts,
  };
}

function makeContext(args: {
  body?: unknown;
  contentLength?: string;
  ip?: string;
  env?: Partial<Env>;
  existing?: FakeRow | null;
}) {
  const headers = new Headers({ 'Content-Type': 'application/json' });
  if (args.contentLength) headers.set('Content-Length', args.contentLength);
  if (args.ip) headers.set('CF-Connecting-IP', args.ip);
  const request = new Request('https://example.test/api/privacy-request', {
    method: 'POST',
    headers,
    body: args.body !== undefined ? JSON.stringify(args.body) : '',
  });
  const { db, inserts } = makeDb({ existing: args.existing ?? null });
  const env = {
    DB: db,
    SESSION_SECRET: SECRET,
    ...args.env,
  } as unknown as Env;
  return { ctx: { request, env } as unknown as Parameters<typeof onRequestPost>[0], inserts };
}

beforeEach(() => {
  authMock.mockReset();
  authMock.mockResolvedValue(null);
  checkQuotaMock.mockReset();
  checkQuotaMock.mockResolvedValue({ allowed: true, currentCount: 0, limit: 5, retryAtSeconds: 0 });
  consumeQuotaMock.mockReset();
  consumeQuotaMock.mockResolvedValue(undefined);
});

describe('POST /api/privacy-request', () => {
  it('500 when SESSION_SECRET is missing', async () => {
    const { ctx } = makeContext({ env: { SESSION_SECRET: undefined }, body: {} });
    const res = await onRequestPost(ctx);
    expect(res.status).toBe(500);
  });

  it('400 when body is not JSON', async () => {
    const request = new Request('https://example.test/api/privacy-request', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{not json',
    });
    const { db } = makeDb();
    const env = { DB: db, SESSION_SECRET: SECRET } as unknown as Env;
    const res = await onRequestPost({ request, env } as unknown as Parameters<typeof onRequestPost>[0]);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('invalid_request');
  });

  it('200 honeypot no-op when honeypot field is filled', async () => {
    const nonce = await createPrivacyRequestIntent({ SESSION_SECRET: SECRET } as unknown as Env);
    const { ctx, inserts } = makeContext({
      body: {
        contact_value: 'a@b.com',
        request_type: 'access',
        message: 'm',
        nonce,
        honeypot: 'i-am-a-bot',
      },
    });
    const res = await onRequestPost(ctx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; id: string };
    expect(body.id).toBe('honeypot');
    expect(inserts.some((i) => i.sql.includes('INSERT INTO privacy_requests'))).toBe(false);
  });

  it('401 invalid_nonce when nonce missing', async () => {
    const { ctx } = makeContext({
      body: { contact_value: 'a@b.com', request_type: 'access', message: 'm' },
    });
    const res = await onRequestPost(ctx);
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('invalid_nonce');
  });

  it('401 invalid_nonce when nonce kind is wrong', async () => {
    const wrongKind = await createSignedIntent(SECRET, { kind: 'age_13_plus_intent' }, 60);
    const { ctx } = makeContext({
      body: { contact_value: 'a@b.com', request_type: 'access', message: 'm', nonce: wrongKind },
    });
    const res = await onRequestPost(ctx);
    expect(res.status).toBe(401);
  });

  it('400 invalid_request for unknown request_type', async () => {
    const nonce = await createPrivacyRequestIntent({ SESSION_SECRET: SECRET } as unknown as Env);
    const { ctx } = makeContext({
      body: { contact_value: 'a@b.com', request_type: 'nope', message: 'm', nonce },
    });
    const res = await onRequestPost(ctx);
    expect(res.status).toBe(400);
  });

  it('400 message_too_long with the structured envelope (not 413, no "capsule" wording)', async () => {
    const nonce = await createPrivacyRequestIntent({ SESSION_SECRET: SECRET } as unknown as Env);
    const { ctx } = makeContext({
      body: {
        contact_value: 'a@b.com',
        request_type: 'access',
        message: 'x'.repeat(2001),
        nonce,
      },
    });
    const res = await onRequestPost(ctx);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; maxChars: number; actualChars: number; message: string };
    expect(body.error).toBe('message_too_long');
    expect(body.maxChars).toBe(2000);
    expect(body.actualChars).toBe(2001);
    expect(body.message).not.toMatch(/capsule/i); // guards against accidental publish-flow copy reuse
  });

  it('429 rate_limited when checkPrivacyRequestQuota returns allowed=false', async () => {
    checkQuotaMock.mockResolvedValueOnce({
      allowed: false,
      currentCount: 5,
      limit: 5,
      retryAtSeconds: Math.floor(Date.now() / 1000) + 60,
    });
    const nonce = await createPrivacyRequestIntent({ SESSION_SECRET: SECRET } as unknown as Env);
    const { ctx } = makeContext({
      ip: '10.0.0.1',
      body: { contact_value: 'a@b.com', request_type: 'deletion', message: 'm', nonce },
    });
    const res = await onRequestPost(ctx);
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toMatch(/^\d+$/);
  });

  it('200 ok inserts a row with the request payload (signed-out → user_id null)', async () => {
    const nonce = await createPrivacyRequestIntent({ SESSION_SECRET: SECRET } as unknown as Env);
    const { ctx, inserts } = makeContext({
      ip: '10.0.0.1',
      body: { contact_value: 'a@b.com', request_type: 'deletion', message: 'please delete', nonce },
    });
    const res = await onRequestPost(ctx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; id: string };
    expect(body.ok).toBe(true);
    expect(body.id).toMatch(/^[0-9a-f-]{36}$/i);
    const insert = inserts.find((i) => i.sql.includes('INSERT INTO privacy_requests'));
    expect(insert).toBeTruthy();
    // Bind layout: id, created_at, user_id, contact_value, request_type, message, ip_hash
    expect(insert!.binds[2]).toBeNull();
    expect(insert!.binds[3]).toBe('a@b.com');
    expect(insert!.binds[4]).toBe('deletion');
    expect(insert!.binds[5]).toBe('please delete');
    expect(typeof insert!.binds[6]).toBe('string'); // ipHash present
  });

  it('signed-in submission records the session user_id', async () => {
    authMock.mockResolvedValue('user-42');
    const nonce = await createPrivacyRequestIntent({ SESSION_SECRET: SECRET } as unknown as Env);
    const { ctx, inserts } = makeContext({
      ip: '10.0.0.1',
      body: { contact_value: 'a@b.com', request_type: 'access', message: 'hi', nonce },
    });
    const res = await onRequestPost(ctx);
    expect(res.status).toBe(200);
    const insert = inserts.find((i) => i.sql.includes('INSERT INTO privacy_requests'))!;
    expect(insert.binds[2]).toBe('user-42');
  });

  it('body-dedup returns the prior id without writing a second row', async () => {
    const nonce = await createPrivacyRequestIntent({ SESSION_SECRET: SECRET } as unknown as Env);
    const { ctx, inserts } = makeContext({
      ip: '10.0.0.1',
      existing: { id: 'prior-id', contact_value: 'a@b.com', message: 'same' },
      body: { contact_value: 'a@b.com', request_type: 'access', message: 'same', nonce },
    });
    const res = await onRequestPost(ctx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; id: string; deduped: boolean };
    expect(body.id).toBe('prior-id');
    expect(body.deduped).toBe(true);
    expect(inserts.some((i) => i.sql.includes('INSERT INTO privacy_requests'))).toBe(false);
  });
});

describe('GET /api/privacy-request/nonce', () => {
  it('issues a token whose kind verifies as privacy_request_intent', async () => {
    const env = { SESSION_SECRET: SECRET } as unknown as Env;
    const request = new Request('https://example.test/api/privacy-request/nonce');
    const res = await nonceGet({ request, env } as unknown as Parameters<typeof nonceGet>[0]);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { nonce: string; ttlSeconds: number };
    expect(body.ttlSeconds).toBe(600);
    expect(typeof body.nonce).toBe('string');
    expect(body.nonce).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  });

  it('500 when SESSION_SECRET missing', async () => {
    const env = {} as unknown as Env;
    const request = new Request('https://example.test/api/privacy-request/nonce');
    const res = await nonceGet({ request, env } as unknown as Parameters<typeof nonceGet>[0]);
    expect(res.status).toBe(500);
  });
});
