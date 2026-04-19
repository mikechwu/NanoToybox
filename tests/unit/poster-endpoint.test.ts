/**
 * Tests for functions/api/capsules/[code]/preview/poster.ts (spec §6, §7, §13).
 *
 * Covers all branches:
 *   - inaccessible (404)
 *   - flag-off + not stored (404)
 *   - stored asset (200 R2 bytes, immutable cache)
 *   - dynamic generation (200 PNG, V1 cache header)
 *   - render error → terminal fallback (200 og-fallback.png, max-age=60)
 *   - fallback-for-the-fallback (200 1×1 PNG, max-age=60)
 * Plus AC #14: every response emits a structured log entry.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  onRequestGet,
  __setRendererForTesting,
} from '../../functions/api/capsules/[code]/preview/poster';
import type { CapsuleShareRow } from '../../src/share/share-record';

// ── Test harness ───────────────────────────────────────────────────────────

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
    ...over,
  };
}

// Valid 8-byte PNG signature + minimal padding so route's looksLikePng()
// guard passes. Test bodies use this when the route should treat the input
// as a real image; tests for "garbage body → fallback" pass a too-short array.
const VALID_PNG_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
]);

function makeContext(opts: {
  row: CapsuleShareRow | null;
  flag?: string;
  r2Object?: { body?: ReadableStream | string; arrayBuffer?: () => Promise<ArrayBuffer>; httpMetadata?: { contentType?: string } } | null;
  fetchImpl?: typeof fetch;
}) {
  const env = {
    DB: {
      prepare: () => ({
        bind: () => ({ first: async () => opts.row }),
      }),
    },
    R2_BUCKET: {
      get: async () => opts.r2Object ?? null,
    },
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
  __setRendererForTesting(null);
});

afterEach(() => {
  logSpy.mockRestore();
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
        // Route now reads via arrayBuffer + validates PNG magic.
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

describe('poster route — dynamic generation (flag on)', () => {
  it('emits 200 PNG with V1 cache header', async () => {
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
    // Spec §6 — ETag bound to TEMPLATE_VERSION + descriptor hash
    expect(res.headers.get('ETag')).toMatch(/^"v\d+-[0-9a-f]{8}"$/);
    expect(lastLogEntry()).toMatchObject({ mode: 'generated', status: 200 });
  });

  it('ETag changes when a content-affecting field changes (title)', async () => {
    __setRendererForTesting(() =>
      new Response(VALID_PNG_BYTES, {
        status: 200,
        headers: { 'Content-Type': 'image/png' },
      }),
    );
    const r1 = await onRequestGet(
      makeContext({ row: makeRow({ title: 'Alpha' }), flag: 'on' }),
    );
    const r2 = await onRequestGet(
      makeContext({ row: makeRow({ title: 'Beta different title' }), flag: 'on' }),
    );
    expect(r1.headers.get('ETag')).not.toBe(r2.headers.get('ETag'));
  });

  it('ETag changes when atomCount/frameCount (subtitle inputs) change', async () => {
    __setRendererForTesting(() =>
      new Response(VALID_PNG_BYTES, {
        status: 200,
        headers: { 'Content-Type': 'image/png' },
      }),
    );
    const r1 = await onRequestGet(
      makeContext({ row: makeRow({ atom_count: 8, frame_count: 60 }), flag: 'on' }),
    );
    const r2 = await onRequestGet(
      makeContext({ row: makeRow({ atom_count: 1024, frame_count: 60 }), flag: 'on' }),
    );
    expect(r1.headers.get('ETag')).not.toBe(r2.headers.get('ETag'));
  });

  it('ETag is stable across identical inputs', async () => {
    __setRendererForTesting(() =>
      new Response(VALID_PNG_BYTES, {
        status: 200,
        headers: { 'Content-Type': 'image/png' },
      }),
    );
    const r1 = await onRequestGet(makeContext({ row: makeRow(), flag: 'on' }));
    const r2 = await onRequestGet(makeContext({ row: makeRow(), flag: 'on' }));
    expect(r1.headers.get('ETag')).toBe(r2.headers.get('ETag'));
  });
});

// ── Fallback paths (spec §4) ──────────────────────────────────────────────

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
    // PNG magic
    expect(body[0]).toBe(0x89);
    expect(body[1]).toBe(0x50);
    expect(body[2]).toBe(0x4e);
    expect(body[3]).toBe(0x47);
    // Cause must preserve the ORIGINAL satori failure AND the fallback-
    // fetch failure — both are needed for ops to recover.
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
    // Falls into the terminal fallback — short cache, not the 5-min one.
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
        arrayBuffer: async () => new Uint8Array([0xff, 0xd8, 0xff]).buffer.slice(0), // JPEG, not PNG
        httpMetadata: { contentType: 'image/png' },
      },
    });
    const res = await onRequestGet(ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=60');
    expect(String(lastLogEntry().cause)).toMatch(/^stored-not-png:/);
  });
});
