/**
 * Handler-level tests for functions/api/capsules/guest-publish.ts.
 *
 * Exercises the ordering contract: feature-flag → age attestation →
 * Turnstile token → quota → size → Siteverify → persist → consume →
 * audit + counter. Uses mocks so the capsule parsing / R2 puts stay
 * local to the test process.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { onRequestPost } from '../../functions/api/capsules/guest-publish';
import type { Env } from '../../functions/env';

// ── Mocks ────────────────────────────────────────────────────────────

const verifyMock = vi.hoisted(() =>
  vi.fn<() => Promise<{ ok: true } | { ok: false; reason: string; errorCodes?: string[] }>>(),
);
vi.mock('../../src/share/turnstile', async () => {
  const actual = await vi.importActual<typeof import('../../src/share/turnstile')>(
    '../../src/share/turnstile',
  );
  return { ...actual, verifyTurnstileToken: (...args: unknown[]) => verifyMock(...args as []) };
});

const checkQuotaMock = vi.hoisted(() =>
  vi.fn<
    () => Promise<{ allowed: boolean; currentCount: number; limit: number; retryAtSeconds: number }>
  >(),
);
const consumeQuotaMock = vi.hoisted(() => vi.fn<() => Promise<void>>());
vi.mock('../../src/share/rate-limit', async () => {
  const actual = await vi.importActual<typeof import('../../src/share/rate-limit')>(
    '../../src/share/rate-limit',
  );
  return {
    ...actual,
    checkGuestPublishQuota: (...args: unknown[]) => checkQuotaMock(...args as []),
    consumeGuestPublishQuota: (...args: unknown[]) => consumeQuotaMock(...args as []),
  };
});

const auditMock = vi.hoisted(() => vi.fn<() => Promise<string>>());
vi.mock('../../src/share/audit', async () => {
  const actual = await vi.importActual<typeof import('../../src/share/audit')>(
    '../../src/share/audit',
  );
  return {
    ...actual,
    recordAuditEvent: (...args: unknown[]) => auditMock(...args as []),
    incrementUsageCounter: vi.fn(async () => undefined),
  };
});

// ── Fixture helpers ──────────────────────────────────────────────────

function minimalValidCapsule(): string {
  return JSON.stringify({
    format: 'atomdojo-history',
    version: 1,
    kind: 'capsule',
    producer: { app: 'lab', appVersion: '0.1.0', exportedAt: '2026-04-23T00:00:00Z' },
    simulation: {
      units: { time: 'ps', length: 'angstrom' },
      maxAtomCount: 2,
      durationPs: 1,
      frameCount: 2,
      indexingModel: 'dense-prefix',
    },
    atoms: { atoms: [{ id: 0, element: 'C' }, { id: 1, element: 'C' }] },
    bondPolicy: { policyId: 'default-carbon-v1', cutoff: 1.85, minDist: 0.5 },
    timeline: {
      denseFrames: [
        { frameId: 0, timePs: 0, n: 2, atomIds: [0, 1], positions: [0, 0, 0, 1, 0, 0] },
        { frameId: 1, timePs: 1, n: 2, atomIds: [0, 1], positions: [0, 0, 0, 1.1, 0, 0] },
      ],
    },
  });
}

function makeEnv(overrides: Partial<Env> = {}): Env {
  const r2Puts: string[] = [];
  const r2Deletes: string[] = [];
  const env = {
    DB: {
      prepare: () => ({
        bind: () => ({
          run: async () => ({ success: true }),
          first: async () => null,
          all: async () => ({ success: true, results: [] }),
        }),
      }),
      batch: async () => [],
    } as unknown as Env['DB'],
    R2_BUCKET: {
      put: async (key: string) => { r2Puts.push(key); return {}; },
      delete: async (key: string) => { r2Deletes.push(key); },
      get: async () => null,
      list: async () => ({ objects: [], truncated: false, delimitedPrefixes: [] }),
    } as unknown as Env['R2_BUCKET'],
    SESSION_SECRET: 'test-salt',
    GUEST_PUBLISH_ENABLED: 'on',
    TURNSTILE_SECRET_KEY: 'test-turnstile-secret',
    TURNSTILE_SITE_KEY: 'test-site-key',
    ...overrides,
  } as Env;
  return env;
}

function makeRequest(body: string, headers: Record<string, string> = {}): Request {
  return new Request('http://localhost/api/capsules/guest-publish', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'CF-Connecting-IP': '198.51.100.9',
      ...headers,
    },
    body,
  });
}

function makeContext(request: Request, env: Env) {
  return { request, env, waitUntil: (_p: Promise<unknown>) => {} } as unknown as Parameters<typeof onRequestPost>[0];
}

describe('guest-publish endpoint', () => {
  beforeEach(() => {
    verifyMock.mockReset();
    checkQuotaMock.mockReset();
    consumeQuotaMock.mockReset();
    consumeQuotaMock.mockResolvedValue(undefined);
    auditMock.mockReset();
    auditMock.mockResolvedValue('audit-id');
    checkQuotaMock.mockResolvedValue({
      allowed: true, currentCount: 0, limit: 5, retryAtSeconds: 0,
    });
  });

  it('returns 404 when GUEST_PUBLISH_ENABLED is off (default)', async () => {
    const env = makeEnv({ GUEST_PUBLISH_ENABLED: 'off' });
    const res = await onRequestPost(makeContext(makeRequest(minimalValidCapsule(), {
      'X-Age-Attested': '1',
      'X-Turnstile-Token': 'tok',
    }), env));
    expect(res.status).toBe(404);
    expect(verifyMock).not.toHaveBeenCalled();
  });

  it('returns 400 age_attestation_required when X-Age-Attested is missing', async () => {
    const env = makeEnv();
    const res = await onRequestPost(makeContext(makeRequest(minimalValidCapsule(), {
      'X-Turnstile-Token': 'tok',
    }), env));
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('age_attestation_required');
    expect(verifyMock).not.toHaveBeenCalled();
  });

  it('returns 400 age_attestation_required for a non-"1" value', async () => {
    const env = makeEnv();
    const res = await onRequestPost(makeContext(makeRequest(minimalValidCapsule(), {
      'X-Age-Attested': 'true',
      'X-Turnstile-Token': 'tok',
    }), env));
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('age_attestation_required');
  });

  it('returns 400 turnstile_missing when X-Turnstile-Token is absent', async () => {
    const env = makeEnv();
    const res = await onRequestPost(makeContext(makeRequest(minimalValidCapsule(), {
      'X-Age-Attested': '1',
    }), env));
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('turnstile_missing');
    expect(verifyMock).not.toHaveBeenCalled();
  });

  it('returns 500 server_not_configured when TURNSTILE_SECRET_KEY is missing', async () => {
    const env = makeEnv({ TURNSTILE_SECRET_KEY: undefined });
    const res = await onRequestPost(makeContext(makeRequest(minimalValidCapsule(), {
      'X-Age-Attested': '1',
      'X-Turnstile-Token': 'tok',
    }), env));
    expect(res.status).toBe(500);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('server_not_configured');
    // Turnstile / quota never touched when a prerequisite is missing.
    expect(verifyMock).not.toHaveBeenCalled();
    expect(checkQuotaMock).not.toHaveBeenCalled();
  });

  it('returns 500 server_not_configured when SESSION_SECRET is missing (fail-closed, audit P1 #2)', async () => {
    const env = makeEnv({ SESSION_SECRET: undefined });
    const res = await onRequestPost(makeContext(makeRequest(minimalValidCapsule(), {
      'X-Age-Attested': '1',
      'X-Turnstile-Token': 'tok',
    }), env));
    expect(res.status).toBe(500);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('server_not_configured');
    // The old graceful-degrade branch would have proceeded to verify
    // Turnstile + quota as if everything were fine. New behavior: no
    // downstream work happens when quota identity can't be derived.
    expect(verifyMock).not.toHaveBeenCalled();
    expect(checkQuotaMock).not.toHaveBeenCalled();
  });

  it('returns 500 server_not_configured when CF-Connecting-IP is absent (fail-closed)', async () => {
    const env = makeEnv();
    // Strip CF-Connecting-IP from the request; production traffic
    // always carries this, but a misconfigured reverse proxy or an
    // unhardened dev environment could miss it.
    const req = new Request('http://localhost/api/capsules/guest-publish', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Age-Attested': '1',
        'X-Turnstile-Token': 'tok',
      },
      body: minimalValidCapsule(),
    });
    const res = await onRequestPost(makeContext(req, env));
    expect(res.status).toBe(500);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('server_not_configured');
  });

  it('returns 429 with Retry-After when quota exceeded', async () => {
    const now = Math.floor(Date.now() / 1000);
    checkQuotaMock.mockResolvedValue({
      allowed: false, currentCount: 5, limit: 5, retryAtSeconds: now + 1800,
    });
    const env = makeEnv();
    const res = await onRequestPost(makeContext(makeRequest(minimalValidCapsule(), {
      'X-Age-Attested': '1',
      'X-Turnstile-Token': 'tok',
    }), env));
    expect(res.status).toBe(429);
    const retryAfter = Number(res.headers.get('Retry-After'));
    expect(retryAfter).toBeGreaterThan(0);
    // Turnstile is not contacted when quota blocks (pre-body check).
    expect(verifyMock).not.toHaveBeenCalled();
    expect(consumeQuotaMock).not.toHaveBeenCalled();
  });

  it('returns 503 turnstile_unavailable on Siteverify timeout', async () => {
    verifyMock.mockResolvedValue({ ok: false, reason: 'siteverify_timeout' });
    const env = makeEnv();
    const res = await onRequestPost(makeContext(makeRequest(minimalValidCapsule(), {
      'X-Age-Attested': '1',
      'X-Turnstile-Token': 'tok',
    }), env));
    expect(res.status).toBe(503);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('turnstile_unavailable');
    expect(consumeQuotaMock).not.toHaveBeenCalled();
  });

  it('returns 400 turnstile_failed on Siteverify rejection', async () => {
    verifyMock.mockResolvedValue({
      ok: false, reason: 'siteverify_rejected', errorCodes: ['invalid-input-response'],
    });
    const env = makeEnv();
    const res = await onRequestPost(makeContext(makeRequest(minimalValidCapsule(), {
      'X-Age-Attested': '1',
      'X-Turnstile-Token': 'tok',
    }), env));
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('turnstile_failed');
  });

  it('returns 413 with the auth-parity envelope when the body exceeds MAX_PUBLISH_BYTES', async () => {
    // Slip past Content-Length preflight — we want the authoritative
    // byte check to fire, same as the auth path.
    const big = 'X'.repeat(21 * 1024 * 1024);
    const env = makeEnv();
    const res = await onRequestPost(makeContext(makeRequest(big, {
      'X-Age-Attested': '1',
      'X-Turnstile-Token': 'tok',
    }), env));
    expect(res.status).toBe(413);
    expect(res.headers.get('X-Max-Publish-Bytes')).toBe(String(20 * 1024 * 1024));
    const body = await res.json() as { error: string; maxBytes: number; actualBytes: number };
    expect(body.error).toBe('payload_too_large');
    expect(body.maxBytes).toBe(20 * 1024 * 1024);
    // Turnstile was not contacted — size check comes before Siteverify.
    expect(verifyMock).not.toHaveBeenCalled();
  });

  it('posts the raw capsule body byte-for-byte (no envelope)', async () => {
    // Pin the byte-identity invariant by capturing the body the
    // endpoint passes to R2 and comparing to the submitted bytes.
    verifyMock.mockResolvedValue({ ok: true });
    const env = makeEnv();
    const captured: { key: string; bytes: Uint8Array | null } = { key: '', bytes: null };
    env.R2_BUCKET = {
      put: async (key: string, value: Uint8Array) => {
        captured.key = key;
        captured.bytes = value;
        return {};
      },
      delete: async () => {},
      get: async () => null,
      list: async () => ({ objects: [], truncated: false, delimitedPrefixes: [] }),
    } as unknown as Env['R2_BUCKET'];
    const raw = minimalValidCapsule();
    const res = await onRequestPost(makeContext(makeRequest(raw, {
      'X-Age-Attested': '1',
      'X-Turnstile-Token': 'tok',
    }), env));
    expect(res.status).toBe(201);
    expect(captured.bytes).not.toBeNull();
    const receivedText = new TextDecoder().decode(captured.bytes!);
    // The bytes persisted to R2 are exactly the POSTed capsule JSON.
    expect(receivedText).toBe(raw);
    expect(new TextEncoder().encode(receivedText).byteLength).toBe(
      new TextEncoder().encode(raw).byteLength,
    );
  });

  it('success response carries shareCode, shareUrl, and expiresAt 72h in the future', async () => {
    verifyMock.mockResolvedValue({ ok: true });
    const env = makeEnv();
    const before = Date.now();
    const res = await onRequestPost(makeContext(makeRequest(minimalValidCapsule(), {
      'X-Age-Attested': '1',
      'X-Turnstile-Token': 'tok',
    }), env));
    const after = Date.now();
    expect(res.status).toBe(201);
    const body = await res.json() as { shareCode: string; shareUrl: string; expiresAt: string };
    expect(typeof body.shareCode).toBe('string');
    expect(body.shareUrl).toContain(body.shareCode);
    const expiresMs = Date.parse(body.expiresAt);
    // 72h ± 1s tolerance — the endpoint stamps expires_at from `new Date()`.
    const expectedMin = before + 72 * 60 * 60 * 1000 - 1000;
    const expectedMax = after + 72 * 60 * 60 * 1000 + 1000;
    expect(expiresMs).toBeGreaterThanOrEqual(expectedMin);
    expect(expiresMs).toBeLessThanOrEqual(expectedMax);
  });
});
