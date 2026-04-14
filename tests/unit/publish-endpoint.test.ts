/**
 * Handler-level tests for functions/api/capsules/publish.ts.
 *
 * Focus: the quota-reject path wiring. The pure quota math is already
 * covered by tests/unit/rate-limit.test.ts — these tests pin the 429
 * response contract, header set, and ordering invariants that the plan
 * lists under "Tests required before launch".
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { onRequestPost } from '../../functions/api/capsules/publish';
import type { Env } from '../../functions/env';

// ── Mocks ──────────────────────────────────────────────────────────────────

const authMock = vi.hoisted(() => vi.fn<() => Promise<string | null>>());
vi.mock('../../functions/auth-middleware', () => ({
  authenticateRequest: (...args: unknown[]) => authMock(...args as Parameters<typeof authMock>),
}));

const quotaMock = vi.hoisted(() =>
  vi.fn<
    () => Promise<{
      allowed: boolean;
      currentCount: number;
      limit: number;
      retryAtSeconds: number;
    }>
  >(),
);
const consumeMock = vi.hoisted(() => vi.fn<(...args: unknown[]) => Promise<void>>());
vi.mock('../../src/share/rate-limit', async () => {
  const actual = await vi.importActual<typeof import('../../src/share/rate-limit')>('../../src/share/rate-limit');
  return {
    ...actual,
    checkPublishQuota: (...args: unknown[]) => (quotaMock as unknown as (...a: unknown[]) => ReturnType<typeof quotaMock>)(...args),
    consumePublishQuota: (...args: unknown[]) => consumeMock(...args),
  };
});

const auditMock = vi.hoisted(() => vi.fn<(...args: unknown[]) => Promise<string>>());
vi.mock('../../src/share/audit', async () => {
  const actual = await vi.importActual<typeof import('../../src/share/audit')>('../../src/share/audit');
  return {
    ...actual,
    recordAuditEvent: (...args: unknown[]) => auditMock(...args),
  };
});

function makeContext(request: Request) {
  // Minimal context shape — publish.ts only reads .request, .env. The
  // age-gate precondition added in Phase B does a point-read against
  // `user_policy_acceptance`; the stub returns a truthy `ok` row so
  // these tests (which exercise OTHER paths — quota / size / invalid)
  // pass the age check without spelunking into mock plumbing they
  // don't care about.
  const env: Env = {
    DB: {
      prepare: (sql: string) => ({
        bind: () => ({
          run: async () => ({ success: true }),
          first: async () =>
            sql.includes('user_policy_acceptance') ? { ok: 1 } : null,
          all: async () => ({ success: true, results: [] }),
        }),
      }),
      async batch() { return []; },
    } as unknown as Env['DB'],
    R2_BUCKET: undefined as unknown as Env['R2_BUCKET'],
  };
  return { request, env } as unknown as Parameters<typeof onRequestPost>[0];
}

function makePublishRequest(body: string) {
  return new Request('http://localhost/api/capsules/publish', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });
}

/** Minimal valid capsule JSON that passes preparePublishRecord. */
function minimalValidCapsule() {
  return {
    format: 'atomdojo-history',
    version: 1,
    kind: 'capsule',
    producer: { app: 'lab', appVersion: '0.1.0', exportedAt: '2026-04-13T00:00:00Z' },
    simulation: {
      units: { time: 'ps', length: 'angstrom' },
      maxAtomCount: 2, durationPs: 1, frameCount: 2,
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
  };
}

/** Permissive Env mock — D1 always succeeds, R2 captures put/delete keys.
 *  Returned accessors let tests assert on what was written. */
function makePermissiveEnv() {
  const r2Puts: string[] = [];
  const r2Deletes: string[] = [];
  const env = {
    DB: {
      prepare: (sql: string) => ({
        bind: () => ({
          run: async () => ({ success: true }),
          // The publish endpoint reads `user_policy_acceptance` as a
          // point-check before the quota/size paths — tests that do not
          // specifically exercise the 428 branch treat acceptance as
          // present so the legacy paths they assert still fire.
          first: async () =>
            sql.includes('user_policy_acceptance') ? { ok: 1 } : null,
          all: async () => ({ success: true, results: [] }),
        }),
      }),
      async batch() { return []; },
    },
    R2_BUCKET: {
      put: async (key: string) => { r2Puts.push(key); },
      delete: async (key: string) => { r2Deletes.push(key); },
      get: async () => null,
      list: async () => ({ objects: [], truncated: false, delimitedPrefixes: [] }),
    },
  };
  return { env, r2Puts, r2Deletes };
}

// ── Quota-reject path ──────────────────────────────────────────────────────

describe('publish endpoint — quota-reject', () => {
  beforeEach(() => {
    authMock.mockReset();
    quotaMock.mockReset();
    consumeMock.mockReset();
    consumeMock.mockResolvedValue(undefined);
    auditMock.mockReset();
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('returns 401 when unauthenticated (quota is never checked)', async () => {
    authMock.mockResolvedValue(null);
    const res = await onRequestPost(makeContext(makePublishRequest('{}')));
    expect(res.status).toBe(401);
    expect(quotaMock).not.toHaveBeenCalled();
    expect(consumeMock).not.toHaveBeenCalled();
  });

  it('returns 429 with Retry-After + X-RateLimit headers when quota exceeded', async () => {
    authMock.mockResolvedValue('user-1');
    auditMock.mockResolvedValue('audit-id');

    const now = Math.floor(Date.now() / 1000);
    quotaMock.mockResolvedValue({
      allowed: false,
      currentCount: 10,
      limit: 10,
      retryAtSeconds: now + 3600, // 1h from now
    });

    const res = await onRequestPost(makeContext(makePublishRequest('{}')));
    expect(res.status).toBe(429);

    // Retry-After must be >= 0 and close to the computed window.
    const retryAfter = parseInt(res.headers.get('Retry-After') ?? '-1', 10);
    expect(retryAfter).toBeGreaterThanOrEqual(0);
    expect(retryAfter).toBeLessThanOrEqual(3601);

    expect(res.headers.get('X-RateLimit-Limit')).toBe('10');
    expect(res.headers.get('X-RateLimit-Remaining')).toBe('0');
  });

  it('429 response clamps Retry-After to 0 when retryAtSeconds is in the past', async () => {
    authMock.mockResolvedValue('user-1');
    auditMock.mockResolvedValue('audit-id');

    quotaMock.mockResolvedValue({
      allowed: false,
      currentCount: 10,
      limit: 10,
      retryAtSeconds: 0, // far in the past
    });

    const res = await onRequestPost(makeContext(makePublishRequest('{}')));
    expect(res.status).toBe(429);
    expect(parseInt(res.headers.get('Retry-After') ?? '-1', 10)).toBe(0);
  });

  it('429 writes an audit event with publish_rejected_quota type', async () => {
    authMock.mockResolvedValue('user-42');
    auditMock.mockResolvedValue('audit-id');

    quotaMock.mockResolvedValue({
      allowed: false,
      currentCount: 10,
      limit: 10,
      retryAtSeconds: Math.floor(Date.now() / 1000) + 60,
    });

    await onRequestPost(makeContext(makePublishRequest('{}')));

    // Give the fire-and-forget microtask a tick to flush.
    await new Promise((r) => setTimeout(r, 0));

    expect(auditMock).toHaveBeenCalledTimes(1);
    const [, input] = auditMock.mock.calls[0] as unknown as [unknown, Record<string, unknown>];
    expect(input.eventType).toBe('publish_rejected_quota');
    expect(input.actor).toBe('user-42');
    expect(input.severity).toBe('warning');
  });

  it('429 does not block on audit-write failure (fire-and-forget)', async () => {
    authMock.mockResolvedValue('user-1');
    quotaMock.mockResolvedValue({
      allowed: false,
      currentCount: 10,
      limit: 10,
      retryAtSeconds: Math.floor(Date.now() / 1000) + 60,
    });
    auditMock.mockRejectedValue(new Error('D1 down'));

    // If the handler awaited the audit write, this would throw.
    const res = await onRequestPost(makeContext(makePublishRequest('{}')));
    expect(res.status).toBe(429);
  });

  it('429 is returned BEFORE any body read (body can be arbitrarily large)', async () => {
    authMock.mockResolvedValue('user-1');
    quotaMock.mockResolvedValue({
      allowed: false,
      currentCount: 10,
      limit: 10,
      retryAtSeconds: Math.floor(Date.now() / 1000) + 60,
    });
    auditMock.mockResolvedValue('audit-id');

    // A body-read spy — if publish.ts awaits request.text() before the
    // quota check, this test will see it called.
    let bodyRead = false;
    const req = new Request('http://localhost/api/capsules/publish', {
      method: 'POST',
      body: 'x'.repeat(1000),
      headers: { 'Content-Type': 'application/json' },
    });
    const wrappedReq = new Proxy(req, {
      get(target, prop, receiver) {
        if (prop === 'text') {
          return () => {
            bodyRead = true;
            return target.text();
          };
        }
        const v = Reflect.get(target, prop, receiver);
        return typeof v === 'function' ? v.bind(target) : v;
      },
    });

    const res = await onRequestPost(makeContext(wrappedReq));
    expect(res.status).toBe(429);
    expect(bodyRead).toBe(false);
  });

  // ── Split-quota semantics ────────────────────────────────────────────────
  //
  // Quota must NOT be consumed when the publish is rejected after the
  // preflight check passes. Only genuine successful publishes charge the
  // user's rolling window.

  it('over-limit preflight does NOT call consumePublishQuota (no spend)', async () => {
    authMock.mockResolvedValue('user-1');
    quotaMock.mockResolvedValue({
      allowed: false,
      currentCount: 10,
      limit: 10,
      retryAtSeconds: Math.floor(Date.now() / 1000) + 60,
    });
    auditMock.mockResolvedValue('audit-id');

    const res = await onRequestPost(makeContext(makePublishRequest('{}')));
    expect(res.status).toBe(429);
    expect(consumeMock).not.toHaveBeenCalled();
  });

  it('oversized payload rejection does NOT consume quota', async () => {
    authMock.mockResolvedValue('user-1');
    quotaMock.mockResolvedValue({
      allowed: true,
      currentCount: 0,
      limit: 10,
      retryAtSeconds: Math.floor(Date.now() / 1000) + 60,
    });
    auditMock.mockResolvedValue('audit-id');

    // Force a huge body via Content-Length fast-reject path. Must exceed
    // the shared MAX_PUBLISH_BYTES (which the test at the bottom of this
    // file asserts equals 20 MB).
    const { MAX_PUBLISH_BYTES } = await import('../../src/share/constants');
    const req = new Request('http://localhost/api/capsules/publish', {
      method: 'POST',
      body: 'x',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': String(MAX_PUBLISH_BYTES + 1),
      },
    });

    const res = await onRequestPost(makeContext(req));
    expect(res.status).toBe(413);
    expect(consumeMock).not.toHaveBeenCalled();
  });

  it('invalid-JSON rejection does NOT consume quota', async () => {
    authMock.mockResolvedValue('user-1');
    quotaMock.mockResolvedValue({
      allowed: true,
      currentCount: 0,
      limit: 10,
      retryAtSeconds: Math.floor(Date.now() / 1000) + 60,
    });
    auditMock.mockResolvedValue('audit-id');

    // preparePublishRecord throws PublishValidationError on this body.
    const res = await onRequestPost(makeContext(makePublishRequest('{not json')));
    expect(res.status).toBe(400);
    expect(consumeMock).not.toHaveBeenCalled();
  });

  // ── Quota consume is synchronous on the success path ────────────────────

  it('post-persist consume failure returns 201 with warnings (not 500 that would trigger retry)', async () => {
    // This test pins the behavior: once persistRecord has succeeded, the
    // publish IS real. Returning 500 on quota-consume failure would
    // cause the client to retry and create a duplicate capsule. Instead
    // we return 201 with a warnings array — the share is valid, but
    // clients/ops know quota accounting needs reconciliation.
    authMock.mockResolvedValue('user-1');
    quotaMock.mockResolvedValue({
      allowed: true,
      currentCount: 0,
      limit: 10,
      retryAtSeconds: Math.floor(Date.now() / 1000) + 60,
    });
    auditMock.mockResolvedValue('audit-id');
    consumeMock.mockRejectedValue(new Error('D1 write failed'));

    const { env, r2Puts, r2Deletes } = makePermissiveEnv();
    const req = new Request('http://localhost/api/capsules/publish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(minimalValidCapsule()),
    });
    const ctx = { request: req, env } as unknown as Parameters<typeof onRequestPost>[0];

    const res = await onRequestPost(ctx);
    expect(res.status).toBe(201);

    const payload = (await res.json()) as {
      shareCode?: string;
      shareUrl?: string;
      warnings?: string[];
    };
    expect(payload.shareCode).toBeDefined();
    expect(payload.shareUrl).toBeDefined();
    expect(payload.warnings).toEqual(['quota_accounting_failed']);

    expect(consumeMock).toHaveBeenCalledTimes(1);

    // Capsule was persisted — we do NOT roll back a real publish.
    expect(r2Puts.length).toBe(1);
    expect(r2Deletes.length).toBe(0);

    // A critical-severity audit event was emitted for ops reconciliation.
    // The event type MUST be publish_quota_accounting_failed — reusing
    // publish_rejected_quota would conflate a real rejection (429 path)
    // with a successful publish that lost a quota increment.
    // Give fire-and-forget audits a tick to flush.
    await new Promise((r) => setTimeout(r, 0));
    const accountingAudit = auditMock.mock.calls.find(
      (call) => (call[1] as unknown as { eventType: string }).eventType === 'publish_quota_accounting_failed',
    );
    expect(accountingAudit).toBeDefined();
    const input = accountingAudit![1] as unknown as Record<string, unknown>;
    expect(input.severity).toBe('critical');
    expect(input.reason).toContain('quota_accounting_failed');
    expect((input.details as Record<string, unknown>).reconciliationNeeded).toBe(true);

    // And critically, NO publish_rejected_quota event — this was not a
    // rejection. Conflating them would break 429-rate dashboards.
    const rejectionAudits = auditMock.mock.calls.filter(
      (call) => (call[1] as unknown as { eventType: string }).eventType === 'publish_rejected_quota',
    );
    expect(rejectionAudits.length).toBe(0);
  });

  it('successful publish with a working consume omits the warnings field', async () => {
    authMock.mockResolvedValue('user-1');
    quotaMock.mockResolvedValue({
      allowed: true,
      currentCount: 0,
      limit: 10,
      retryAtSeconds: Math.floor(Date.now() / 1000) + 60,
    });
    auditMock.mockResolvedValue('audit-id');
    consumeMock.mockResolvedValue(undefined);

    const { env } = makePermissiveEnv();
    const req = new Request('http://localhost/api/capsules/publish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(minimalValidCapsule()),
    });

    const res = await onRequestPost(
      { request: req, env } as unknown as Parameters<typeof onRequestPost>[0],
    );
    expect(res.status).toBe(201);
    const payload = (await res.json()) as Record<string, unknown>;
    expect(payload.warnings).toBeUndefined();
  });
});

// ── Payload-too-large path (413) ─────────────────────────────────────────
//
// Locks the shared-constant + structured-JSON contract. The limit lives
// in `src/share/constants.ts` — if these tests start failing after a
// limit change, the constant is the single place to update, and the
// server, client, and tests update together by construction.

describe('publish endpoint — 413 payload-too-large', () => {
  beforeEach(() => {
    authMock.mockReset();
    quotaMock.mockReset();
    auditMock.mockReset();
    consumeMock.mockReset();
    authMock.mockResolvedValue('user-123');
    // Quota must pass so the size check is the actual rejection reason.
    quotaMock.mockResolvedValue({
      allowed: true, currentCount: 0, limit: 10, retryAtSeconds: 0,
    });
    auditMock.mockResolvedValue('audit-id');
  });

  it('rejects on Content-Length preflight with structured JSON (no actualBytes)', async () => {
    const { MAX_PUBLISH_BYTES } = await import('../../src/share/constants');
    const { env } = makePermissiveEnv();
    const oversize = MAX_PUBLISH_BYTES + 1;
    // Send a harmless body; Content-Length header claims the oversize.
    // The preflight should fire before body read.
    const req = new Request('http://localhost/api/capsules/publish', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': String(oversize),
      },
      body: JSON.stringify({ small: true }),
    });
    const res = await onRequestPost(
      { request: req, env } as unknown as Parameters<typeof onRequestPost>[0],
    );
    expect(res.status).toBe(413);
    const body = await res.json() as Record<string, unknown>;
    expect(body.error).toBe('payload_too_large');
    expect(typeof body.message).toBe('string');
    expect(body.maxBytes).toBe(MAX_PUBLISH_BYTES);
    // actualBytes is OMITTED on the preflight path — we haven't read the body.
    expect('actualBytes' in body).toBe(false);
  });

  it('rejects on authoritative post-read size with structured JSON including actualBytes', async () => {
    const { MAX_PUBLISH_BYTES } = await import('../../src/share/constants');
    const { env } = makePermissiveEnv();
    // Build a body that's over the limit by padding an opaque JSON field
    // past MAX_PUBLISH_BYTES. Exact JSON wrapper is `{"pad":"..."}` (~10
    // bytes), but we just pad past the limit by a comfortable margin so
    // the post-read measurement is unambiguously >. Omit Content-Length
    // so the preflight skips and the authoritative check fires.
    const huge = JSON.stringify({ pad: 'x'.repeat(MAX_PUBLISH_BYTES + 1024) });
    const actualBytes = new TextEncoder().encode(huge).byteLength;
    expect(actualBytes).toBeGreaterThan(MAX_PUBLISH_BYTES);

    const req = new Request('http://localhost/api/capsules/publish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }, // no Content-Length
      body: huge,
    });
    const res = await onRequestPost(
      { request: req, env } as unknown as Parameters<typeof onRequestPost>[0],
    );
    expect(res.status).toBe(413);
    const body = await res.json() as Record<string, unknown>;
    expect(body.error).toBe('payload_too_large');
    expect(body.maxBytes).toBe(MAX_PUBLISH_BYTES);
    // actualBytes is the measured body size (exact integer from TextEncoder).
    expect(body.actualBytes).toBe(actualBytes);
  });

  it('does NOT 413 at exactly MAX_PUBLISH_BYTES (strict greater-than boundary)', async () => {
    // Validation (publish-core) rejects most capsules, so we can't easily
    // build a valid-but-max-sized capsule here. This boundary test asserts
    // the status is NOT 413 at the boundary — any other rejection reason
    // is acceptable (we're not asserting 201). The point is to lock the
    // strictly-greater-than comparison.
    const { MAX_PUBLISH_BYTES } = await import('../../src/share/constants');
    const { env } = makePermissiveEnv();
    const req = new Request('http://localhost/api/capsules/publish', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': String(MAX_PUBLISH_BYTES), // exactly at the limit
      },
      body: JSON.stringify({ small: true }),
    });
    const res = await onRequestPost(
      { request: req, env } as unknown as Parameters<typeof onRequestPost>[0],
    );
    expect(res.status).not.toBe(413);
  });

  it('preflight 413 includes X-Max-Publish-Bytes header matching MAX_PUBLISH_BYTES', async () => {
    const { MAX_PUBLISH_BYTES } = await import('../../src/share/constants');
    const { env } = makePermissiveEnv();
    const req = new Request('http://localhost/api/capsules/publish', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': String(MAX_PUBLISH_BYTES + 1),
      },
      body: JSON.stringify({ small: true }),
    });
    const res = await onRequestPost(
      { request: req, env } as unknown as Parameters<typeof onRequestPost>[0],
    );
    expect(res.status).toBe(413);
    // Header duplicates maxBytes so a client that can't parse the JSON
    // body (CDN error-page injection / middleware rewrite) still has a
    // trustworthy numeric limit from THIS response.
    expect(res.headers.get('X-Max-Publish-Bytes')).toBe(String(MAX_PUBLISH_BYTES));
  });

  it('post-read 413 includes X-Max-Publish-Bytes header matching MAX_PUBLISH_BYTES', async () => {
    const { MAX_PUBLISH_BYTES } = await import('../../src/share/constants');
    const { env } = makePermissiveEnv();
    const huge = JSON.stringify({ pad: 'x'.repeat(MAX_PUBLISH_BYTES + 1024) });
    const req = new Request('http://localhost/api/capsules/publish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: huge,
    });
    const res = await onRequestPost(
      { request: req, env } as unknown as Parameters<typeof onRequestPost>[0],
    );
    expect(res.status).toBe(413);
    expect(res.headers.get('X-Max-Publish-Bytes')).toBe(String(MAX_PUBLISH_BYTES));
  });

  it('header and body maxBytes agree on both 413 paths (contract)', async () => {
    const { MAX_PUBLISH_BYTES } = await import('../../src/share/constants');
    const { env } = makePermissiveEnv();
    // Preflight
    const preflight = await onRequestPost({
      request: new Request('http://localhost/api/capsules/publish', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': String(MAX_PUBLISH_BYTES + 1),
        },
        body: JSON.stringify({ small: true }),
      }),
      env,
    } as unknown as Parameters<typeof onRequestPost>[0]);
    const preflightHeader = Number(preflight.headers.get('X-Max-Publish-Bytes'));
    const preflightBody = (await preflight.json()) as Record<string, unknown>;
    expect(preflightHeader).toBe(preflightBody.maxBytes);
    // Post-read
    const huge = JSON.stringify({ pad: 'x'.repeat(MAX_PUBLISH_BYTES + 1024) });
    const postRead = await onRequestPost({
      request: new Request('http://localhost/api/capsules/publish', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: huge,
      }),
      env,
    } as unknown as Parameters<typeof onRequestPost>[0]);
    const postReadHeader = Number(postRead.headers.get('X-Max-Publish-Bytes'));
    const postReadBody = (await postRead.json()) as Record<string, unknown>;
    expect(postReadHeader).toBe(postReadBody.maxBytes);
  });

  it('no dev-mode bypass — the 413 fires regardless of request host (no localhost special-case)', async () => {
    const { MAX_PUBLISH_BYTES } = await import('../../src/share/constants');
    const { env } = makePermissiveEnv();
    // Both http://localhost and https://atomdojo.pages.dev should produce
    // the same 413 for an oversize payload. No env variable, no host
    // heuristic, no query-param knob relaxes the check.
    const body = JSON.stringify({ pad: 'x'.repeat(MAX_PUBLISH_BYTES) });
    const localReq = new Request('http://localhost/api/capsules/publish', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
    });
    const prodReq = new Request('https://atomdojo.pages.dev/api/capsules/publish', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
    });
    const [localRes, prodRes] = await Promise.all([
      onRequestPost({ request: localReq, env } as unknown as Parameters<typeof onRequestPost>[0]),
      onRequestPost({ request: prodReq, env } as unknown as Parameters<typeof onRequestPost>[0]),
    ]);
    expect(localRes.status).toBe(413);
    expect(prodRes.status).toBe(413);
    const localBody = await localRes.json() as Record<string, unknown>;
    const prodBody = await prodRes.json() as Record<string, unknown>;
    expect(localBody.maxBytes).toBe(MAX_PUBLISH_BYTES);
    expect(prodBody.maxBytes).toBe(MAX_PUBLISH_BYTES);
  });
});

// ── Shared-constant drift guard ──────────────────────────────────────────

describe('shared publish-size constant', () => {
  it('is 20 MB (the plan-mandated value; any drift would break server + client + tests together)', async () => {
    const { MAX_PUBLISH_BYTES } = await import('../../src/share/constants');
    expect(MAX_PUBLISH_BYTES).toBe(20 * 1024 * 1024);
  });
});
