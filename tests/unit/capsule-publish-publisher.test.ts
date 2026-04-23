/**
 * @vitest-environment jsdom
 *
 * Tests for createPreparedCapsulePublisher and postCapsuleArtifact.
 *
 * Two distinct suites, isolated from each other:
 *
 *   · Publisher suite stubs `buildCapsuleArtifact`,
 *     `getCapsuleExportInputVersion`, and `postCapsuleArtifact`. Drives
 *     snapshot-stale and cache-eviction paths without touching fetch.
 *
 *   · postCapsuleArtifact suite stubs global `fetch` to drive each
 *     response branch (200, 401, 413 structured, 413 header-only, 428,
 *     429 Retry-After, generic). Asserts typed-error throws and the
 *     byte-identity contract (POST body === prepared JSON).
 *
 * Neither suite imports `main.ts` — the publisher lives in
 * publish-capsule-artifacts.ts specifically so unit tests can skip
 * booting the renderer / worker / store / auth runtime.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  createPreparedCapsulePublisher,
  postCapsuleArtifact,
  TEST_ONLY_CACHE_SIZE,
  type CapsuleArtifact,
} from '../../lab/js/runtime/publish-capsule-artifacts';

// Helper: the public PreparedCapsulePublisher interface does not
// expose the cache-size accessor. Tests reach it through the Symbol
// key — a seam that does not leak into production imports because
// callers must explicitly import TEST_ONLY_CACHE_SIZE.
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
  isCapsuleSnapshotStaleError,
} from '../../lab/js/runtime/publish-errors';
import { AuthRequiredError, AgeConfirmationRequiredError } from '../../lab/js/runtime/auth-runtime';
import { MAX_PUBLISH_BYTES } from '../../src/share/constants';

function makeArtifact(json: string, overrides: Partial<CapsuleArtifact> = {}): CapsuleArtifact {
  const bytes = new TextEncoder().encode(json).byteLength;
  return {
    // Minimal file shape — tests only consume `artifact.bytes` and
    // `artifact.json` along the publisher's critical path.
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

describe('createPreparedCapsulePublisher', () => {
  it('caches the prepared JSON keyed by prepareId and returns summary', async () => {
    const build = vi.fn((_range: CapsuleSelectionRange) => makeArtifact('{"hello":"world"}'));
    const post = vi.fn(async (_a: CapsuleArtifact) => ({ shareCode: 'abc', shareUrl: 'https://x' }));
    const getVersion = vi.fn(() => 'v1:0:0:0');
    const publisher = createPreparedCapsulePublisher({
      buildCapsuleArtifact: build,
      getCapsuleExportInputVersion: getVersion,
      postCapsuleArtifact: post,
      generatePrepareId: () => 'prep-test',
    });
    const summary = await publisher.prepareCapsulePublish(makeRange('v1:0:0:0'));
    expect(summary.prepareId).toBe('prep-test');
    expect(summary.bytes).toBeGreaterThan(0);
    expect(summary.maxSource).toBe('client-fallback');
    expect(cacheSize(publisher)).toBe(1);
  });

  it('publishPreparedCapsule throws snapshot-stale when snapshot changed and never calls post', async () => {
    const build = vi.fn((_range: CapsuleSelectionRange) => makeArtifact('{"x":1}'));
    const post = vi.fn(async (_a: CapsuleArtifact) => ({ shareCode: 'c', shareUrl: 'u' }));
    let version: CapsuleSnapshotId = 'v1:0:0:0';
    const publisher = createPreparedCapsulePublisher({
      buildCapsuleArtifact: build,
      getCapsuleExportInputVersion: () => version,
      postCapsuleArtifact: post,
    });
    const summary = await publisher.prepareCapsulePublish(makeRange('v1:0:0:0'));
    // Simulate a recordFrame mutation between prepare and publish by
    // flipping the version. `publishPreparedCapsule` should reject with
    // the typed error, evict the cache entry, and never call `post`.
    version = 'v2:0:0:0';
    await expect(publisher.publishPreparedCapsule(summary.prepareId)).rejects.toBeInstanceOf(CapsuleSnapshotStaleError);
    expect(post).not.toHaveBeenCalled();
    expect(cacheSize(publisher)).toBe(0);
  });

  it('detects snapshot-stale across all three input families (frame / metadata / appearance)', async () => {
    const build = vi.fn((_range: CapsuleSelectionRange) => makeArtifact('{"y":1}'));
    const post = vi.fn(async (_a: CapsuleArtifact) => ({ shareCode: 'c', shareUrl: 'u' }));
    const cases: CapsuleSnapshotId[] = ['2:0:0:0', '1:1:0:0', '1:0:1:0'];
    for (const next of cases) {
      let version: CapsuleSnapshotId = '1:0:0:0';
      const publisher = createPreparedCapsulePublisher({
        buildCapsuleArtifact: build,
        getCapsuleExportInputVersion: () => version,
        postCapsuleArtifact: post,
      });
      const summary = await publisher.prepareCapsulePublish(makeRange('1:0:0:0'));
      version = next;
      await expect(publisher.publishPreparedCapsule(summary.prepareId)).rejects.toBeInstanceOf(CapsuleSnapshotStaleError);
    }
    expect(post).not.toHaveBeenCalled();
  });

  it('publishPreparedCapsule posts cached artifact when snapshot matches and evicts on success', async () => {
    const post = vi.fn(async (_a: CapsuleArtifact) => ({ shareCode: 'x', shareUrl: 'y' }));
    const publisher = createPreparedCapsulePublisher({
      buildCapsuleArtifact: (_range) => makeArtifact('{"same":true}'),
      getCapsuleExportInputVersion: () => 'v:0:0:0',
      postCapsuleArtifact: post,
    });
    const summary = await publisher.prepareCapsulePublish(makeRange('v:0:0:0'));
    const result = await publisher.publishPreparedCapsule(summary.prepareId);
    expect(result.shareCode).toBe('x');
    expect(post).toHaveBeenCalledTimes(1);
    expect(cacheSize(publisher)).toBe(0);
  });

  it('byte-identity: POST body is the same JSON string produced at prepare time', async () => {
    // Acceptance #16 — if the publisher silently rebuilt the artifact
    // at publish time (for any reason), `exportedAt` would drift and
    // this comparison would fail.
    const fixedJson = '{"exportedAt":"2026-04-22T00:00:00.000Z","timeline":{"denseFrames":[]}}';
    let captured: CapsuleArtifact | null = null;
    const post = vi.fn(async (artifact: CapsuleArtifact) => {
      captured = artifact;
      return { shareCode: 'a', shareUrl: 'b' };
    });
    const publisher = createPreparedCapsulePublisher({
      buildCapsuleArtifact: (_r) => makeArtifact(fixedJson),
      getCapsuleExportInputVersion: () => 'v:0:0:0',
      postCapsuleArtifact: post,
    });
    const summary = await publisher.prepareCapsulePublish(makeRange('v:0:0:0'));
    await publisher.publishPreparedCapsule(summary.prepareId);
    expect(captured).not.toBeNull();
    expect(captured!.json).toBe(fixedJson);
    expect(captured!.bytes).toBe(summary.bytes);
  });

  it('cancelPreparedPublish evicts the entry and is idempotent', async () => {
    const post = vi.fn();
    const publisher = createPreparedCapsulePublisher({
      buildCapsuleArtifact: (_r) => makeArtifact('{}'),
      getCapsuleExportInputVersion: () => 'v:0:0:0',
      postCapsuleArtifact: post as any,
    });
    const summary = await publisher.prepareCapsulePublish(makeRange('v:0:0:0'));
    publisher.cancelPreparedPublish(summary.prepareId);
    expect(cacheSize(publisher)).toBe(0);
    // Idempotent — calling again does not throw.
    publisher.cancelPreparedPublish(summary.prepareId);
    expect(cacheSize(publisher)).toBe(0);
  });

  it('bounds the cache and evicts the oldest entry when over the limit', async () => {
    let n = 0;
    const publisher = createPreparedCapsulePublisher({
      buildCapsuleArtifact: (_r) => makeArtifact(`{"n":${n}}`),
      getCapsuleExportInputVersion: () => 'v:0:0:0',
      postCapsuleArtifact: async () => ({ shareCode: 'x', shareUrl: 'y' }),
      maxCacheEntries: 2,
      generatePrepareId: () => `prep-${n++}`,
    });
    await publisher.prepareCapsulePublish(makeRange('v:0:0:0'));
    await publisher.prepareCapsulePublish(makeRange('v:0:0:0'));
    await publisher.prepareCapsulePublish(makeRange('v:0:0:0'));
    expect(cacheSize(publisher)).toBe(2);
  });

  it('evicts cache entry on publish failure (non-stale)', async () => {
    const post = vi.fn(async (_a: CapsuleArtifact) => { throw new Error('boom'); });
    const publisher = createPreparedCapsulePublisher({
      buildCapsuleArtifact: (_r) => makeArtifact('{}'),
      getCapsuleExportInputVersion: () => 'v:0:0:0',
      postCapsuleArtifact: post,
    });
    const summary = await publisher.prepareCapsulePublish(makeRange('v:0:0:0'));
    await expect(publisher.publishPreparedCapsule(summary.prepareId)).rejects.toThrow('boom');
    expect(cacheSize(publisher)).toBe(0);
  });
});

describe('postCapsuleArtifact', () => {
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
    // Construct an artifact whose `bytes` claims to be above the cap.
    // We don't allocate the real string — we lie about bytes to test
    // the preflight branch cheaply.
    const artifact = {
      ...makeArtifact('{"x":1}'),
      bytes: MAX_PUBLISH_BYTES + 1,
    };
    await expect(postCapsuleArtifact(artifact as any)).rejects.toBeInstanceOf(PublishOversizeError);
    try {
      await postCapsuleArtifact(artifact as any);
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
    const result = await postCapsuleArtifact(makeArtifact('{"ok":1}'));
    expect(result.shareCode).toBe('abc');
    expect(result.shareUrl).toBe('https://x/abc');
  });

  it('throws AuthRequiredError on 401', async () => {
    fetchMock.mockResolvedValueOnce(new Response('', { status: 401 }));
    await expect(postCapsuleArtifact(makeArtifact('{}'))).rejects.toBeInstanceOf(AuthRequiredError);
  });

  it('throws AgeConfirmationRequiredError on 428', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ policyVersion: '2026-01' }), {
      status: 428,
      headers: { 'Content-Type': 'application/json' },
    }));
    try {
      await postCapsuleArtifact(makeArtifact('{}'));
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
      await postCapsuleArtifact(makeArtifact('{}'));
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
      await postCapsuleArtifact(makeArtifact('{}'));
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
    await expect(postCapsuleArtifact(makeArtifact('{}'))).rejects.toThrow(/try again in 120s/);
  });

  it('falls back to generic 429 copy when Retry-After is non-numeric', async () => {
    fetchMock.mockResolvedValueOnce(new Response('', {
      status: 429,
      headers: { 'Retry-After': 'nonsense' },
    }));
    await expect(postCapsuleArtifact(makeArtifact('{}'))).rejects.toThrow(/quota exceeded/);
  });

  it('posts the artifact.json as-is (byte identity at the fetch boundary)', async () => {
    const fixed = '{"alpha":true}';
    fetchMock.mockResolvedValueOnce(okResponse({ shareCode: 'a', shareUrl: 'b' }));
    await postCapsuleArtifact(makeArtifact(fixed));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const call = fetchMock.mock.calls[0];
    const init = call[1] as RequestInit;
    expect(init.body).toBe(fixed);
  });
});
