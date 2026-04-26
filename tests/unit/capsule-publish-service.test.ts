/**
 * @vitest-environment jsdom
 *
 * Tests for the Phase 1 publish architecture:
 *
 *   · `createPreparedCapsuleService` — mode-neutral preparation. Owns
 *     prepare/cache/cancel and the single `assertPreparedCapsuleFresh`
 *     snapshot recheck.
 *   · `postAccountCapsuleArtifact` — single owner of fetch + 4xx/5xx
 *     mapping for the auth path.
 *   · `createPublishPreparedAccountCapsule` — account executor wrapper
 *     that enforces snapshot-recheck-before-POST.
 *   · `createPublishPreparedGuestCapsule` — guest executor wrapper
 *     with the same recheck contract; verifies byte-identity at the
 *     POST boundary (Acceptance #8).
 *
 * Neither suite imports `main.ts` — the service lives in
 * prepared-capsule-service.ts specifically so unit tests can skip
 * booting the renderer / worker / store / auth runtime.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  createPreparedCapsuleService,
  TEST_ONLY_CACHE_SIZE,
  type CapsuleArtifact,
} from '../../lab/js/runtime/prepared-capsule-service';
import { postAccountCapsuleArtifact } from '../../lab/js/runtime/post-account-capsule';
import {
  postGuestCapsuleArtifact,
  GuestTurnstileError,
  GuestQuotaExceededError,
  GuestPublishDisabledError,
} from '../../lab/js/runtime/post-guest-capsule';
import { createPublishPreparedAccountCapsule } from '../../lab/js/runtime/publish-prepared-account-capsule';
import { createPublishPreparedGuestCapsule } from '../../lab/js/runtime/publish-prepared-guest-capsule';

// Helper: the public PreparedCapsuleService interface does not expose
// the cache-size accessor. Tests reach it through the Symbol key — a
// seam that does not leak into production imports because callers
// must explicitly import TEST_ONLY_CACHE_SIZE.
function cacheSize(p: any): number {
  return p[TEST_ONLY_CACHE_SIZE]();
}
import type {
  CapsuleSelectionRange,
  CapsuleSnapshotId,
} from '../../lab/js/runtime/timeline/capsule-publish-types';
import {
  PublishOversizeError,
  CapsuleSnapshotStaleError,
  isPublishOversizeError,
} from '../../lab/js/runtime/publish-errors';
import { AuthRequiredError, AgeConfirmationRequiredError } from '../../lab/js/runtime/auth-runtime';
import { MAX_PUBLISH_BYTES } from '../../src/share/constants';

function makeArtifact(json: string, overrides: Partial<CapsuleArtifact> = {}): CapsuleArtifact {
  const bytes = new TextEncoder().encode(json).byteLength;
  return {
    file: {
      format: 'atomdojo-history',
      version: 1,
      kind: 'capsule',
      producer: { app: 'lab', appVersion: '0.1.0', exportedAt: '2026-04-22T00:00:00.000Z' },
      simulation: { units: { time: 'ps', length: 'angstrom' }, maxAtomCount: 1, durationPs: 0, frameCount: 1, indexingModel: 'dense-prefix' },
      atoms: { atoms: [{ id: 0, element: 'C', isotope: null, charge: null, label: null }] },
      bondPolicy: { version: 1, params: {} } as any,
      timeline: { denseFrames: [{ frameId: 0, timePs: 0, n: 1, atomIds: [0], positions: [0, 0, 0] }] },
    } as any,
    json,
    bytes,
    ...overrides,
  };
}

function makeRange(snapshotId: CapsuleSnapshotId, startIdx = 0, endIdx = 0): CapsuleSelectionRange {
  return { snapshotId, startFrameIndex: startIdx, endFrameIndex: endIdx };
}

describe('createPreparedCapsuleService', () => {
  it('caches the prepared JSON keyed by prepareId and returns summary', async () => {
    const build = vi.fn((_range: CapsuleSelectionRange) => makeArtifact('{"hello":"world"}'));
    const getVersion = vi.fn(() => 'v1:0:0:0');
    const service = createPreparedCapsuleService({
      buildCapsuleArtifact: build,
      getCapsuleExportInputVersion: getVersion,
      generatePrepareId: () => 'prep-test',
    });
    const summary = await service.prepareCapsulePublish(makeRange('v1:0:0:0'));
    expect(summary.prepareId).toBe('prep-test');
    expect(summary.bytes).toBeGreaterThan(0);
    expect(summary.maxSource).toBe('client-fallback');
    expect(cacheSize(service)).toBe(1);
  });

  it('assertPreparedCapsuleFresh throws snapshot-stale when snapshot changed and evicts the entry', async () => {
    const build = vi.fn((_range: CapsuleSelectionRange) => makeArtifact('{"x":1}'));
    let version: CapsuleSnapshotId = 'v1:0:0:0';
    const service = createPreparedCapsuleService({
      buildCapsuleArtifact: build,
      getCapsuleExportInputVersion: () => version,
    });
    const summary = await service.prepareCapsulePublish(makeRange('v1:0:0:0'));
    version = 'v2:0:0:0';
    expect(() => service.assertPreparedCapsuleFresh(summary.prepareId)).toThrow(CapsuleSnapshotStaleError);
    expect(cacheSize(service)).toBe(0);
  });

  it('detects snapshot-stale across all three input families (frame / metadata / appearance)', async () => {
    const build = vi.fn((_range: CapsuleSelectionRange) => makeArtifact('{"y":1}'));
    const cases: CapsuleSnapshotId[] = ['2:0:0:0', '1:1:0:0', '1:0:1:0'];
    for (const next of cases) {
      let version: CapsuleSnapshotId = '1:0:0:0';
      const service = createPreparedCapsuleService({
        buildCapsuleArtifact: build,
        getCapsuleExportInputVersion: () => version,
      });
      const summary = await service.prepareCapsulePublish(makeRange('1:0:0:0'));
      version = next;
      expect(() => service.assertPreparedCapsuleFresh(summary.prepareId)).toThrow(CapsuleSnapshotStaleError);
    }
  });

  it('assertPreparedCapsuleFresh throws when prepareId is unknown / already evicted', async () => {
    const service = createPreparedCapsuleService({
      buildCapsuleArtifact: (_r) => makeArtifact('{}'),
      getCapsuleExportInputVersion: () => 'v:0:0:0',
    });
    expect(() => service.assertPreparedCapsuleFresh('does-not-exist')).toThrow(CapsuleSnapshotStaleError);
  });

  it('getPreparedCapsuleArtifact returns the cached artifact unchanged', async () => {
    const fixedJson = '{"alpha":true}';
    const service = createPreparedCapsuleService({
      buildCapsuleArtifact: (_r) => makeArtifact(fixedJson),
      getCapsuleExportInputVersion: () => 'v:0:0:0',
    });
    const summary = await service.prepareCapsulePublish(makeRange('v:0:0:0'));
    const artifact = service.getPreparedCapsuleArtifact(summary.prepareId);
    expect(artifact.json).toBe(fixedJson);
    expect(artifact.bytes).toBe(summary.bytes);
  });

  it('cancelPreparedPublish evicts the entry and is idempotent', async () => {
    const service = createPreparedCapsuleService({
      buildCapsuleArtifact: (_r) => makeArtifact('{}'),
      getCapsuleExportInputVersion: () => 'v:0:0:0',
    });
    const summary = await service.prepareCapsulePublish(makeRange('v:0:0:0'));
    service.cancelPreparedPublish(summary.prepareId);
    expect(cacheSize(service)).toBe(0);
    service.cancelPreparedPublish(summary.prepareId);
    expect(cacheSize(service)).toBe(0);
  });

  it('bounds the cache and evicts the oldest entry when over the limit', async () => {
    let n = 0;
    const service = createPreparedCapsuleService({
      buildCapsuleArtifact: (_r) => makeArtifact(`{"n":${n}}`),
      getCapsuleExportInputVersion: () => 'v:0:0:0',
      maxCacheEntries: 2,
      generatePrepareId: () => `prep-${n++}`,
    });
    await service.prepareCapsulePublish(makeRange('v:0:0:0'));
    await service.prepareCapsulePublish(makeRange('v:0:0:0'));
    await service.prepareCapsulePublish(makeRange('v:0:0:0'));
    expect(cacheSize(service)).toBe(2);
  });
});

describe('createPublishPreparedAccountCapsule', () => {
  it('runs assertPreparedCapsuleFresh before POST and posts the cached bytes', async () => {
    const post = vi.fn(async (_a: CapsuleArtifact) => ({
      mode: 'account' as const, shareCode: 'x', shareUrl: 'y',
    }));
    const service = createPreparedCapsuleService({
      buildCapsuleArtifact: (_r) => makeArtifact('{"same":true}'),
      getCapsuleExportInputVersion: () => 'v:0:0:0',
    });
    const exec = createPublishPreparedAccountCapsule({ service, postAccount: post });
    const summary = await service.prepareCapsulePublish(makeRange('v:0:0:0'));
    const result = await exec(summary.prepareId);
    expect(result.shareCode).toBe('x');
    expect(post).toHaveBeenCalledTimes(1);
    expect(cacheSize(service)).toBe(0);
  });

  it('throws snapshot-stale and never posts when the snapshot moved', async () => {
    const post = vi.fn();
    let version: CapsuleSnapshotId = 'v:0:0:0';
    const service = createPreparedCapsuleService({
      buildCapsuleArtifact: (_r) => makeArtifact('{"x":1}'),
      getCapsuleExportInputVersion: () => version,
    });
    const exec = createPublishPreparedAccountCapsule({ service, postAccount: post as any });
    const summary = await service.prepareCapsulePublish(makeRange('v:0:0:0'));
    version = 'v2:0:0:0';
    await expect(exec(summary.prepareId)).rejects.toBeInstanceOf(CapsuleSnapshotStaleError);
    expect(post).not.toHaveBeenCalled();
    expect(cacheSize(service)).toBe(0);
  });

  it('byte-identity: POST body is the same JSON string produced at prepare time', async () => {
    const fixedJson = '{"exportedAt":"2026-04-22T00:00:00.000Z","timeline":{"denseFrames":[]}}';
    let captured: CapsuleArtifact | null = null;
    const post = vi.fn(async (artifact: CapsuleArtifact) => {
      captured = artifact;
      return { mode: 'account' as const, shareCode: 'a', shareUrl: 'b' };
    });
    const service = createPreparedCapsuleService({
      buildCapsuleArtifact: (_r) => makeArtifact(fixedJson),
      getCapsuleExportInputVersion: () => 'v:0:0:0',
    });
    const exec = createPublishPreparedAccountCapsule({ service, postAccount: post });
    const summary = await service.prepareCapsulePublish(makeRange('v:0:0:0'));
    await exec(summary.prepareId);
    expect(captured).not.toBeNull();
    expect(captured!.json).toBe(fixedJson);
    expect(captured!.bytes).toBe(summary.bytes);
  });

  it('evicts cache entry on POST failure', async () => {
    const post = vi.fn(async (_a: CapsuleArtifact) => { throw new Error('boom'); });
    const service = createPreparedCapsuleService({
      buildCapsuleArtifact: (_r) => makeArtifact('{}'),
      getCapsuleExportInputVersion: () => 'v:0:0:0',
    });
    const exec = createPublishPreparedAccountCapsule({ service, postAccount: post });
    const summary = await service.prepareCapsulePublish(makeRange('v:0:0:0'));
    await expect(exec(summary.prepareId)).rejects.toThrow('boom');
    expect(cacheSize(service)).toBe(0);
  });
});

describe('createPublishPreparedGuestCapsule', () => {
  it('runs assertPreparedCapsuleFresh before POST and forwards the Turnstile token', async () => {
    const post = vi.fn(async (_a: CapsuleArtifact, _t: string) => ({
      mode: 'guest' as const,
      shareCode: 'g',
      shareUrl: 'h',
      expiresAt: '2030-01-01T00:00:00.000Z',
    }));
    const service = createPreparedCapsuleService({
      buildCapsuleArtifact: (_r) => makeArtifact('{"g":1}'),
      getCapsuleExportInputVersion: () => 'v:0:0:0',
    });
    const exec = createPublishPreparedGuestCapsule({ service, postGuest: post });
    const summary = await service.prepareCapsulePublish(makeRange('v:0:0:0'));
    const result = await exec(summary.prepareId, 'tok-xyz');
    expect(result.shareCode).toBe('g');
    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0][1]).toBe('tok-xyz');
    expect(cacheSize(service)).toBe(0);
  });

  it('byte-identity: POSTed bytes equal the prepared JSON for the same prepareId', async () => {
    const fixedJson = '{"hello":"guest"}';
    let captured: CapsuleArtifact | null = null;
    const post = vi.fn(async (a: CapsuleArtifact, _t: string) => {
      captured = a;
      return {
        mode: 'guest' as const,
        shareCode: 'a', shareUrl: 'b', expiresAt: '2030-01-01T00:00:00.000Z',
      };
    });
    const service = createPreparedCapsuleService({
      buildCapsuleArtifact: (_r) => makeArtifact(fixedJson),
      getCapsuleExportInputVersion: () => 'v:0:0:0',
    });
    const exec = createPublishPreparedGuestCapsule({ service, postGuest: post });
    const summary = await service.prepareCapsulePublish(makeRange('v:0:0:0'));
    await exec(summary.prepareId, 'tok');
    expect(captured!.json).toBe(fixedJson);
    expect(captured!.bytes).toBe(summary.bytes);
  });

  it('throws snapshot-stale and never POSTs when the snapshot moved', async () => {
    const post = vi.fn();
    let version: CapsuleSnapshotId = 'v:0:0:0';
    const service = createPreparedCapsuleService({
      buildCapsuleArtifact: (_r) => makeArtifact('{}'),
      getCapsuleExportInputVersion: () => version,
    });
    const exec = createPublishPreparedGuestCapsule({ service, postGuest: post as any });
    const summary = await service.prepareCapsulePublish(makeRange('v:0:0:0'));
    version = 'v9:0:0:0';
    await expect(exec(summary.prepareId, 'tok')).rejects.toBeInstanceOf(CapsuleSnapshotStaleError);
    expect(post).not.toHaveBeenCalled();
    expect(cacheSize(service)).toBe(0);
  });
});

describe('postAccountCapsuleArtifact', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn();
    (globalThis as any).fetch = fetchMock;
  });

  function okResponse(body: any): Response {
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  it('throws PublishOversizeError(source: preflight) when artifact exceeds MAX_PUBLISH_BYTES without hitting fetch', async () => {
    const artifact = {
      ...makeArtifact('{"x":1}'),
      bytes: MAX_PUBLISH_BYTES + 1,
    };
    await expect(postAccountCapsuleArtifact(artifact as any)).rejects.toBeInstanceOf(PublishOversizeError);
    try {
      await postAccountCapsuleArtifact(artifact as any);
    } catch (e) {
      if (!isPublishOversizeError(e)) throw e;
      expect(e.source).toBe('preflight');
      expect(e.actualBytes).toBe(MAX_PUBLISH_BYTES + 1);
      expect(e.maxBytes).toBe(MAX_PUBLISH_BYTES);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns the parsed payload on 200', async () => {
    fetchMock.mockResolvedValueOnce(okResponse({ shareCode: 'abc', shareUrl: 'https://x/abc' }));
    const result = await postAccountCapsuleArtifact(makeArtifact('{"ok":1}'));
    expect(result.shareCode).toBe('abc');
    expect(result.shareUrl).toBe('https://x/abc');
  });

  it('throws AuthRequiredError on 401', async () => {
    fetchMock.mockResolvedValueOnce(new Response('', { status: 401 }));
    await expect(postAccountCapsuleArtifact(makeArtifact('{}'))).rejects.toBeInstanceOf(AuthRequiredError);
  });

  it('throws AgeConfirmationRequiredError on 428', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ policyVersion: '2026-01' }), {
      status: 428,
      headers: { 'Content-Type': 'application/json' },
    }));
    try {
      await postAccountCapsuleArtifact(makeArtifact('{}'));
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(AgeConfirmationRequiredError);
    }
  });

  it('throws PublishOversizeError(source: 413) with structured body', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      error: 'payload_too_large',
      message: 'too big',
      maxBytes: MAX_PUBLISH_BYTES,
      actualBytes: 42_000_000,
    }), {
      status: 413,
      headers: { 'Content-Type': 'application/json' },
    }));
    try {
      await postAccountCapsuleArtifact(makeArtifact('{}'));
      throw new Error('expected throw');
    } catch (e) {
      if (!isPublishOversizeError(e)) throw e;
      expect(e.source).toBe('413');
      expect(e.maxBytes).toBe(MAX_PUBLISH_BYTES);
      expect(e.actualBytes).toBe(42_000_000);
    }
  });

  it('throws PublishOversizeError(source: 413) with header-only max when body unparseable', async () => {
    fetchMock.mockResolvedValueOnce(new Response('not json', {
      status: 413,
      headers: { 'X-Max-Publish-Bytes': String(MAX_PUBLISH_BYTES) },
    }));
    try {
      await postAccountCapsuleArtifact(makeArtifact('{}'));
      throw new Error('expected throw');
    } catch (e) {
      if (!isPublishOversizeError(e)) throw e;
      expect(e.source).toBe('413');
      expect(e.maxBytes).toBe(MAX_PUBLISH_BYTES);
      expect(e.actualBytes).toBeNull();
    }
  });

  it('surfaces Retry-After delta-seconds in 429 message', async () => {
    fetchMock.mockResolvedValueOnce(new Response('', {
      status: 429,
      headers: { 'Retry-After': '120' },
    }));
    await expect(postAccountCapsuleArtifact(makeArtifact('{}'))).rejects.toThrow(/try again in 120s/);
  });

  it('falls back to generic 429 copy when Retry-After is non-numeric', async () => {
    fetchMock.mockResolvedValueOnce(new Response('', {
      status: 429,
      headers: { 'Retry-After': 'nonsense' },
    }));
    await expect(postAccountCapsuleArtifact(makeArtifact('{}'))).rejects.toThrow(/quota exceeded/);
  });

  it('posts the artifact.json as-is (byte identity at the fetch boundary)', async () => {
    const fixed = '{"alpha":true}';
    fetchMock.mockResolvedValueOnce(okResponse({ shareCode: 'a', shareUrl: 'b' }));
    await postAccountCapsuleArtifact(makeArtifact(fixed));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const call = fetchMock.mock.calls[0];
    const init = call[1] as RequestInit;
    expect(init.body).toBe(fixed);
  });
});

describe('postGuestCapsuleArtifact (Acceptance #7 — full-guest path)', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn();
    (globalThis as any).fetch = fetchMock;
  });

  function okGuestResponse(body: any): Response {
    return new Response(JSON.stringify(body), {
      status: 201,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  it('returns parsed ShareResultGuest on 201 and forwards the Turnstile token in the X-Turnstile-Token header', async () => {
    fetchMock.mockResolvedValueOnce(okGuestResponse({
      shareCode: 'GUESTCODE12',
      shareUrl: 'https://example/g/GUESTCODE12',
      expiresAt: '2030-01-01T00:00:00.000Z',
    }));
    const result = await postGuestCapsuleArtifact(makeArtifact('{"x":1}'), 'tok-live');
    expect(result.mode).toBe('guest');
    expect(result.shareCode).toBe('GUESTCODE12');
    expect(result.expiresAt).toBe('2030-01-01T00:00:00.000Z');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers['X-Turnstile-Token']).toBe('tok-live');
    expect(headers['X-Age-Attested']).toBe('1');
  });

  it('throws GuestTurnstileError("missing") when the token is empty (no fetch)', async () => {
    await expect(postGuestCapsuleArtifact(makeArtifact('{}'), '')).rejects.toBeInstanceOf(GuestTurnstileError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('throws GuestQuotaExceededError on 429 with Retry-After', async () => {
    fetchMock.mockResolvedValueOnce(new Response('', {
      status: 429,
      headers: { 'Retry-After': '60' },
    }));
    try {
      await postGuestCapsuleArtifact(makeArtifact('{}'), 'tok');
      throw new Error('expected throw');
    } catch (e) {
      if (!(e instanceof GuestQuotaExceededError)) throw e;
      expect(e.retryAfterSeconds).toBe(60);
    }
  });

  it('throws GuestPublishDisabledError on 404', async () => {
    fetchMock.mockResolvedValueOnce(new Response('', { status: 404 }));
    await expect(postGuestCapsuleArtifact(makeArtifact('{}'), 'tok')).rejects.toBeInstanceOf(GuestPublishDisabledError);
  });

  it('posts the artifact.json byte-for-byte (full-history byte identity)', async () => {
    const fixed = '{"hello":"guest-full"}';
    fetchMock.mockResolvedValueOnce(okGuestResponse({
      shareCode: 'a', shareUrl: 'b', expiresAt: '2030-01-01T00:00:00.000Z',
    }));
    await postGuestCapsuleArtifact(makeArtifact(fixed), 'tok');
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.body).toBe(fixed);
  });
});
