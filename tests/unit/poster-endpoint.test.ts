/**
 * Tests for functions/api/capsules/[code]/preview/poster.ts — V2 (spec §Backend).
 *
 * Covers every branch of the poster route:
 *   - inaccessible (404)
 *   - flag-off + not stored (404)
 *   - stored asset (200 R2 bytes, immutable cache)
 *   - dynamic generation from pre-baked preview_scene_v1 (200 PNG)
 *   - lazy-backfill path when preview_scene_v1 is NULL
 *   - render error → terminal fallback (200 og-fallback.png, max-age=60)
 *   - fallback-for-the-fallback (200 1×1 PNG, max-age=60)
 *   - body validation (dynamic and stored)
 *   - ETag stability + scene-bound invalidation
 *   - structured logging on every response path
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  onRequestGet,
  __setRendererForTesting,
} from '../../functions/api/capsules/[code]/preview/poster';
import type { CapsuleShareRow } from '../../src/share/share-record';
import {
  buildPreviewSceneV1,
  serializePreviewSceneV1,
} from '../../src/share/capsule-preview-scene-store';
import type { CapsulePreviewRenderScene } from '../../src/share/capsule-preview-project';

function makeRenderScene(n: number, seed = 0): CapsulePreviewRenderScene {
  const atoms = [];
  for (let i = 0; i < n; i++) {
    atoms.push({
      atomId: i,
      x: 50 + (i * 500) / Math.max(1, n - 1),
      y: 50 + ((i + seed) * 400) / Math.max(1, n - 1),
      r: 6,
      colorHex: '#222222',
      depth: i * 0.1,
    });
  }
  return { atoms, bounds: { width: 600, height: 500 }, classification: 'general' };
}

function makeSceneJson(n = 4, seed = 0): string {
  return serializePreviewSceneV1(buildPreviewSceneV1(makeRenderScene(n, seed)));
}

function makeRow(over: Partial<CapsuleShareRow> = {}): CapsuleShareRow {
  return {
    id: 'id-1',
    share_code: '7M4K2D8Q9T1V',
    status: 'ready',
    owner_user_id: 'u',
    object_key: 'capsules/x/capsule.atomdojo',
    format: 'atomdojo-history',
    version: 1,
    kind: 'capsule',
    app_version: '0.1.0',
    sha256: 'abc',
    size_bytes: 100,
    frame_count: 60,
    atom_count: 32,
    max_atom_count: 32,
    duration_ps: 1.0,
    has_appearance: 0,
    has_interaction: 0,
    title: null,
    preview_status: 'pending',
    preview_poster_key: null,
    preview_motion_key: null,
    created_at: '2026-04-13T00:00:00Z',
    uploaded_at: '2026-04-13T00:00:00Z',
    published_at: '2026-04-13T00:00:00Z',
    last_accessed_at: null,
    rejection_reason: null,
    preview_scene_v1: makeSceneJson(),
    ...over,
  };
}

const VALID_PNG_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
]);

function makeContext(opts: {
  row: CapsuleShareRow | null;
  flag?: string;
  r2Object?: { arrayBuffer?: () => Promise<ArrayBuffer>; text?: () => Promise<string>; httpMetadata?: { contentType?: string } } | null;
  r2Impl?: { get: (key: string) => Promise<any> };
  updateFn?: (sceneJson: string, id: string) => Promise<void>;
  fetchImpl?: typeof fetch;
}) {
  const updateFn = opts.updateFn ?? (async () => {});
  const env = {
    DB: {
      prepare: (sql: string) => ({
        _binds: [] as unknown[],
        bind(...vs: unknown[]) { this._binds = vs; return this; },
        async first() {
          if (sql.includes('SELECT * FROM capsule_share')) return opts.row;
          return null;
        },
        async run() {
          if (sql.includes('UPDATE capsule_share SET preview_scene_v1')) {
            await updateFn(String(this._binds[0]), String(this._binds[1]));
          }
          return { success: true };
        },
      }),
    },
    R2_BUCKET: opts.r2Impl ?? { get: async () => opts.r2Object ?? null },
    CAPSULE_PREVIEW_DYNAMIC_FALLBACK: opts.flag,
  } as any;
  const request = new Request('https://example.com/api/capsules/7M4K2D8Q9T1V/preview/poster');
  if (opts.fetchImpl) {
    (globalThis as any).fetch = opts.fetchImpl;
  }
  return {
    env,
    request,
    params: { code: '7M4K2D8Q9T1V' },
    waitUntil: () => {},
    next: () => new Response(),
    data: {},
  } as any;
}

let logSpy: ReturnType<typeof vi.spyOn>;
const origFetch = globalThis.fetch;

beforeEach(() => {
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  __setRendererForTesting(null);
});

afterEach(() => {
  vi.restoreAllMocks();
  __setRendererForTesting(null);
  globalThis.fetch = origFetch;
});

function lastLogEntry(): any | null {
  for (let i = logSpy.mock.calls.length - 1; i >= 0; i--) {
    const msg = String(logSpy.mock.calls[i][0] ?? '');
    if (msg.startsWith('[capsule-poster] ')) {
      return JSON.parse(msg.slice('[capsule-poster] '.length));
    }
  }
  return null;
}

// ── 404 branches ───────────────────────────────────────────────────────────

describe('poster route — 404 branches', () => {
  it('inaccessible status → 404 + log mode=inaccessible', async () => {
    const ctx = makeContext({ row: makeRow({ status: 'rejected' }) });
    const res = await onRequestGet(ctx);
    expect(res.status).toBe(404);
    expect(lastLogEntry()).toMatchObject({ mode: 'inaccessible', status: 404 });
  });

  it('flag off + not stored → 404 + log mode=flag-off', async () => {
    const ctx = makeContext({
      row: makeRow({ preview_status: 'pending', preview_poster_key: null }),
      flag: 'off',
    });
    const res = await onRequestGet(ctx);
    expect(res.status).toBe(404);
    expect(lastLogEntry()).toMatchObject({ mode: 'flag-off', status: 404 });
  });

  it('unknown code → 404', async () => {
    const ctx = makeContext({ row: null });
    ctx.params.code = '!!!';
    const res = await onRequestGet(ctx);
    expect(res.status).toBe(404);
  });
});

// ── Stored asset branch ───────────────────────────────────────────────────

describe('poster route — stored asset', () => {
  it('serves R2 bytes with immutable cache when preview_status=ready', async () => {
    const ctx = makeContext({
      row: makeRow({
        preview_status: 'ready',
        preview_poster_key: 'capsules/x/preview-poster.png',
      }),
      r2Object: {
        arrayBuffer: async () => VALID_PNG_BYTES.buffer.slice(0),
        httpMetadata: { contentType: 'image/png' },
      },
    });
    const res = await onRequestGet(ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('image/png');
    expect(res.headers.get('Cache-Control')).toContain('immutable');
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(lastLogEntry()).toMatchObject({ mode: 'stored', status: 200 });
  });

  it('R2 miss for ready row → terminal fallback (not 404)', async () => {
    globalThis.fetch = (async () =>
      new Response(VALID_PNG_BYTES, { status: 200 })) as any;
    const ctx = makeContext({
      row: makeRow({
        preview_status: 'ready',
        preview_poster_key: 'capsules/x/preview-poster.png',
      }),
      r2Object: null,
    });
    const res = await onRequestGet(ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toContain('max-age=60');
    expect(lastLogEntry()).toMatchObject({ mode: 'error', cause: 'r2-miss' });
  });
});

// ── Dynamic generation branch ─────────────────────────────────────────────

describe('poster route — dynamic generation (flag on, scene pre-baked)', () => {
  it('emits 200 PNG with V2 cache header', async () => {
    __setRendererForTesting(() =>
      new Response(VALID_PNG_BYTES, {
        status: 200,
        headers: { 'Content-Type': 'image/png' },
      }),
    );
    const ctx = makeContext({
      row: makeRow({ preview_status: 'pending', preview_poster_key: null }),
      flag: 'on',
    });
    const res = await onRequestGet(ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('image/png');
    expect(res.headers.get('Cache-Control')).toMatch(/max-age=300/);
    expect(res.headers.get('Cache-Control')).toMatch(/stale-while-revalidate=86400/);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(res.headers.get('ETag')).toMatch(/^"v2-[0-9a-f]{8}"$/);
    expect(lastLogEntry()).toMatchObject({ mode: 'generated', status: 200 });
  });

  it('ETag changes when scene.hash changes (different first-frame content)', async () => {
    __setRendererForTesting(() =>
      new Response(VALID_PNG_BYTES, { status: 200, headers: { 'Content-Type': 'image/png' } }),
    );
    const r1 = await onRequestGet(
      makeContext({ row: makeRow({ preview_scene_v1: makeSceneJson(4, 0) }), flag: 'on' }),
    );
    const r2 = await onRequestGet(
      makeContext({ row: makeRow({ preview_scene_v1: makeSceneJson(4, 7) }), flag: 'on' }),
    );
    expect(r1.headers.get('ETag')).not.toBe(r2.headers.get('ETag'));
  });

  it('ETag changes when the sanitized title changes', async () => {
    __setRendererForTesting(() =>
      new Response(VALID_PNG_BYTES, { status: 200, headers: { 'Content-Type': 'image/png' } }),
    );
    const sceneJson = makeSceneJson(4);
    const r1 = await onRequestGet(
      makeContext({ row: makeRow({ title: 'Alpha', preview_scene_v1: sceneJson }), flag: 'on' }),
    );
    const r2 = await onRequestGet(
      makeContext({ row: makeRow({ title: 'Beta different title', preview_scene_v1: sceneJson }), flag: 'on' }),
    );
    expect(r1.headers.get('ETag')).not.toBe(r2.headers.get('ETag'));
  });

  it('ETag is stable across identical inputs', async () => {
    __setRendererForTesting(() =>
      new Response(VALID_PNG_BYTES, { status: 200, headers: { 'Content-Type': 'image/png' } }),
    );
    const sceneJson = makeSceneJson(4);
    const r1 = await onRequestGet(makeContext({ row: makeRow({ preview_scene_v1: sceneJson }), flag: 'on' }));
    const r2 = await onRequestGet(makeContext({ row: makeRow({ preview_scene_v1: sceneJson }), flag: 'on' }));
    expect(r1.headers.get('ETag')).toBe(r2.headers.get('ETag'));
  });

  it('passes the parsed scene (not JSON string) to the renderer seam', async () => {
    let receivedScene: any = null;
    let receivedMeta: any = null;
    __setRendererForTesting((scene, meta) => {
      receivedScene = scene;
      receivedMeta = meta;
      return new Response(VALID_PNG_BYTES, { status: 200 });
    });
    await onRequestGet(makeContext({
      row: makeRow({ preview_scene_v1: makeSceneJson(3), title: 'Hello' }),
      flag: 'on',
    }));
    expect(receivedScene).toBeTruthy();
    expect(receivedScene.atoms.length).toBe(3);
    expect(receivedMeta.sanitizedTitle).toBe('Hello');
    expect(receivedMeta.shareCode).toBe('7M4K2D8Q9T1V');
    expect(receivedMeta.subtitle).toMatch(/atoms|frames|Interactive/);
  });
});

// ── Lazy-backfill path (scene NULL) ───────────────────────────────────────

describe('poster route — lazy backfill on preview_scene_v1=null', () => {
  const validCapsule = JSON.stringify({
    format: 'atomdojo-history',
    version: 1,
    kind: 'capsule',
    producer: { app: 'lab', appVersion: '0.1.0', exportedAt: '2026-04-19T00:00:00Z' },
    simulation: {
      units: { time: 'ps', length: 'angstrom' },
      maxAtomCount: 2,
      durationPs: 1.0,
      frameCount: 1,
      indexingModel: 'dense-prefix',
    },
    atoms: { atoms: [{ id: 0, element: 'C' }, { id: 1, element: 'C' }] },
    bondPolicy: { policyId: 'default-carbon-v1', cutoff: 1.85, minDist: 0.5 },
    timeline: { denseFrames: [{ frameId: 0, timePs: 0, n: 2, atomIds: [0, 1], positions: [0, 0, 0, 1.42, 0, 0] }] },
  });

  it('fetches blob, projects, writes back, renders', async () => {
    let writtenSceneJson: string | null = null;
    __setRendererForTesting(() =>
      new Response(VALID_PNG_BYTES, { status: 200, headers: { 'Content-Type': 'image/png' } }),
    );
    const ctx = makeContext({
      row: makeRow({ preview_status: 'pending', preview_poster_key: null, preview_scene_v1: null }),
      flag: 'on',
      r2Impl: {
        get: async () => ({
          text: async () => validCapsule,
        }),
      },
      updateFn: async (sceneJson) => { writtenSceneJson = sceneJson; },
    });
    const res = await onRequestGet(ctx);
    expect(res.status).toBe(200);
    expect(writtenSceneJson).not.toBeNull();
    expect(writtenSceneJson).toContain('"atoms"');
  });

  it('R2 blob missing → terminal fallback scene-missing', async () => {
    globalThis.fetch = (async () => new Response(VALID_PNG_BYTES, { status: 200 })) as any;
    const ctx = makeContext({
      row: makeRow({ preview_scene_v1: null }),
      flag: 'on',
      r2Impl: { get: async () => null },
    });
    const res = await onRequestGet(ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=60');
    expect(String(lastLogEntry().cause)).toMatch(/^scene-missing/);
  });

  it('R2 blob malformed JSON → capsule-parse-failed', async () => {
    globalThis.fetch = (async () => new Response(VALID_PNG_BYTES, { status: 200 })) as any;
    const ctx = makeContext({
      row: makeRow({ preview_scene_v1: null }),
      flag: 'on',
      r2Impl: { get: async () => ({ text: async () => 'not-json' }) },
    });
    const res = await onRequestGet(ctx);
    expect(res.status).toBe(200);
    expect(String(lastLogEntry().cause)).toMatch(/^capsule-parse-failed/);
  });

  it('R2 blob with zero dense frames → no-dense-frames cause', async () => {
    globalThis.fetch = (async () => new Response(VALID_PNG_BYTES, { status: 200 })) as any;
    const bad = JSON.stringify({
      format: 'atomdojo-history',
      version: 1,
      kind: 'capsule',
      producer: { app: 'lab', appVersion: '0.1.0', exportedAt: '2026-04-19T00:00:00Z' },
      simulation: {
        units: { time: 'ps', length: 'angstrom' },
        maxAtomCount: 0,
        durationPs: 0,
        frameCount: 0,
        indexingModel: 'dense-prefix',
      },
      atoms: { atoms: [] },
      bondPolicy: { policyId: 'default-carbon-v1', cutoff: 1.85, minDist: 0.5 },
      timeline: { denseFrames: [] },
    });
    // validateCapsuleFile rejects empty denseFrames with "denseFrames must not be empty"
    const ctx = makeContext({
      row: makeRow({ preview_scene_v1: null }),
      flag: 'on',
      r2Impl: { get: async () => ({ text: async () => bad }) },
    });
    const res = await onRequestGet(ctx);
    expect(res.status).toBe(200);
    expect(String(lastLogEntry().cause)).toMatch(/^capsule-parse-failed/);
  });

  it('malformed preview_scene_v1 cell falls through to lazy-backfill', async () => {
    let backfillJson: string | null = null;
    __setRendererForTesting(() =>
      new Response(VALID_PNG_BYTES, { status: 200, headers: { 'Content-Type': 'image/png' } }),
    );
    const validCapsule = JSON.stringify({
      format: 'atomdojo-history',
      version: 1,
      kind: 'capsule',
      producer: { app: 'lab', appVersion: '0.1.0', exportedAt: '2026-04-19T00:00:00Z' },
      simulation: {
        units: { time: 'ps', length: 'angstrom' },
        maxAtomCount: 2,
        durationPs: 1.0,
        frameCount: 1,
        indexingModel: 'dense-prefix',
      },
      atoms: { atoms: [{ id: 0, element: 'C' }, { id: 1, element: 'C' }] },
      bondPolicy: { policyId: 'default-carbon-v1', cutoff: 1.85, minDist: 0.5 },
      timeline: { denseFrames: [{ frameId: 0, timePs: 0, n: 2, atomIds: [0, 1], positions: [0, 0, 0, 1.42, 0, 0] }] },
    });
    const ctx = makeContext({
      row: makeRow({ preview_scene_v1: '{broken' }),
      flag: 'on',
      r2Impl: { get: async () => ({ text: async () => validCapsule }) },
      updateFn: async (json) => { backfillJson = json; },
    });
    const res = await onRequestGet(ctx);
    expect(res.status).toBe(200);
    expect(backfillJson).not.toBeNull();
  });
});

// ── Fallback paths ────────────────────────────────────────────────────────

describe('poster route — terminal fallback', () => {
  it('renderer throws → fetches /og-fallback.png, returns 200 max-age=60', async () => {
    __setRendererForTesting(() => {
      throw new Error('satori boom');
    });
    globalThis.fetch = (async () =>
      new Response(VALID_PNG_BYTES, {
        status: 200,
        headers: { 'Content-Type': 'image/png' },
      })) as any;
    const ctx = makeContext({
      row: makeRow({ preview_status: 'pending', preview_poster_key: null }),
      flag: 'on',
    });
    const res = await onRequestGet(ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('image/png');
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=60');
    const log = lastLogEntry();
    expect(log).toMatchObject({ mode: 'error', status: 200 });
    expect(String(log.cause)).toMatch(/^satori-threw:/);
  });

  it('renderer throws AND fallback fetch fails → 1×1 PNG, cause preserves BOTH errors', async () => {
    __setRendererForTesting(() => {
      throw new Error('satori boom');
    });
    globalThis.fetch = (async () => new Response('nope', { status: 500 })) as any;
    const ctx = makeContext({
      row: makeRow({ preview_status: 'pending', preview_poster_key: null }),
      flag: 'on',
    });
    const res = await onRequestGet(ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('image/png');
    const body = new Uint8Array(await res.arrayBuffer());
    expect(body[0]).toBe(0x89);
    expect(body[1]).toBe(0x50);
    expect(body[2]).toBe(0x4e);
    expect(body[3]).toBe(0x47);
    const log = lastLogEntry();
    expect(log).toMatchObject({ mode: 'error', status: 200 });
    expect(log.cause).toContain('satori-threw:satori boom');
    expect(log.cause).toContain('fallback-fetch-failed:');
  });
});

describe('poster route — body validation', () => {
  it('Satori returns empty body → terminal fallback (not 200 with empty PNG)', async () => {
    __setRendererForTesting(() => new Response(new Uint8Array([]), { status: 200, headers: { 'Content-Type': 'image/png' } }));
    globalThis.fetch = (async () => new Response(VALID_PNG_BYTES, { status: 200 })) as any;
    const ctx = makeContext({
      row: makeRow({ preview_status: 'pending', preview_poster_key: null }),
      flag: 'on',
    });
    const res = await onRequestGet(ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=60');
    const log = lastLogEntry();
    expect(log).toMatchObject({ mode: 'error' });
    expect(String(log.cause)).toMatch(/^dynamic-not-png:/);
  });

  it('R2 returns garbage body → terminal fallback (no 1-year cache pin)', async () => {
    globalThis.fetch = (async () => new Response(VALID_PNG_BYTES, { status: 200 })) as any;
    const ctx = makeContext({
      row: makeRow({ preview_status: 'ready', preview_poster_key: 'capsules/x/preview-poster.png' }),
      r2Object: {
        arrayBuffer: async () => new Uint8Array([0xff, 0xd8, 0xff]).buffer.slice(0),
        httpMetadata: { contentType: 'image/png' },
      },
    });
    const res = await onRequestGet(ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=60');
    expect(String(lastLogEntry().cause)).toMatch(/^stored-not-png:/);
  });
});
