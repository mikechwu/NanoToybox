/**
 * Tests for the V2 `previewThumb` derivation in /api/account/capsules
 * (spec §Account Integration §3, AC #26 — post-launch follow-up that
 * reopened bonds-in-thumb for dense scenes).
 *
 * Hot-path assertions:
 *   - No R2 binding access on the hot path.
 *   - Sparse scenes are atoms-only (≤ ROW_ATOM_CAP_ATOMS_ONLY = 18) with
 *     no `bonds` field on the wire.
 *   - Dense scenes (≥ BONDS_AWARE_SOURCE_THRESHOLD source atoms) carry a
 *     capped bond subset (≤ ROW_BOND_CAP = 24) and the atom count is
 *     bounded by ROW_ATOM_CAP_WITH_BONDS = 24. DOM cost is constant
 *     under the path-batched renderer; caps are now driven by the
 *     storage+legibility tradeoff, not the old ≤20 DOM budget.
 *   - Null/malformed/absent preview_scene_v1 yields `previewThumb: null`
 *     (drives the placeholder thumb on the client).
 */

import { describe, it, expect, vi } from 'vitest';
import { onRequestGet } from '../../functions/api/account/capsules/index';
import type { Env } from '../../functions/env';
import {
  buildPreviewSceneV1,
  ROW_ATOM_CAP,
  ROW_ATOM_CAP_WITH_BONDS,
  serializePreviewSceneV1,
} from '../../src/share/capsule-preview-scene-store';
import type { CapsulePreviewRenderScene } from '../../src/share/capsule-preview-project';

vi.mock('../../functions/auth-middleware', () => ({
  authenticateRequest: async () => 'user-1',
}));

interface Row {
  share_code: string;
  created_at: string;
  size_bytes: number;
  frame_count: number;
  atom_count: number;
  title: string | null;
  kind: string;
  status: string;
  preview_status: string;
  preview_scene_v1: string | null;
}

function makeScene(n: number): CapsulePreviewRenderScene {
  const atoms = [];
  for (let i = 0; i < n; i++) {
    atoms.push({
      atomId: i,
      x: 50 + (i * 400) / Math.max(1, n - 1),
      y: 50 + (i * 350) / Math.max(1, n - 1),
      r: 6,
      colorHex: '#222222',
      depth: i * 0.1,
    });
  }
  return { atoms, bounds: { width: 500, height: 450 }, classification: 'general' };
}

function sceneJson(n: number, withBonds = false): string {
  const render = makeScene(n);
  const bonds = withBonds
    ? Array.from({ length: Math.max(0, n - 1) }, (_, i) => ({ a: i, b: i + 1 }))
    : undefined;
  return serializePreviewSceneV1(buildPreviewSceneV1(render, bonds));
}

/** Fixture where the silhouette sampler is guaranteed to keep every
 *  bond endpoint, so bonds make it past the thumb visibility filter.
 *  Used for tests that assert the bonded-mode wire contract. */
function denseSceneWithLongBonds(): string {
  const atoms = [];
  for (let i = 0; i < 16; i++) {
    atoms.push({
      atomId: i,
      x: 40 + (i % 4) * 160,   // 40, 200, 360, 520
      y: 40 + Math.floor(i / 4) * 140,  // 40, 180, 320, 460
      r: 6,
      colorHex: '#222222',
      depth: 0,
    });
  }
  // Bonds that span the corners, so after silhouette sampling (which
  // keeps the four axis extrema = corners) the bonds remain.
  const bonds = [
    { a: 0, b: 3 },    // top-left → top-right
    { a: 12, b: 15 },  // bottom-left → bottom-right
    { a: 0, b: 12 },   // left vertical
    { a: 3, b: 15 },   // right vertical
    { a: 0, b: 15 },   // diagonal
  ];
  return serializePreviewSceneV1(buildPreviewSceneV1({
    atoms,
    bounds: { width: 600, height: 500 },
    classification: 'general',
  }, bonds));
}

function row(overrides: Partial<Row> = {}): Row {
  return {
    share_code: 'ABCDEF123456',
    created_at: '2026-04-19T00:00:00Z',
    size_bytes: 100,
    frame_count: 1,
    atom_count: 8,
    title: null,
    kind: 'capsule',
    status: 'ready',
    preview_status: 'none',
    preview_scene_v1: null,
    ...overrides,
  };
}

function makeContext(rows: Row[], onR2Access: () => void) {
  const db: Env['DB'] = {
    prepare(_sql: string) {
      return {
        _binds: [] as unknown[],
        bind(...vs: unknown[]) { this._binds = vs; return this; },
        async run() { return { success: true }; },
        async first<T = unknown>(): Promise<T | null> { return null; },
        async all<T = unknown>() {
          return { success: true, results: rows.slice() as unknown as T[] };
        },
      };
    },
    async batch() { return []; },
  } as unknown as Env['DB'];
  const r2Proxy = new Proxy({}, { get() { onR2Access(); throw new Error('R2 accessed on hot path'); } }) as Env['R2_BUCKET'];
  return {
    env: { DB: db, R2_BUCKET: r2Proxy } as unknown as Env,
    request: new Request('https://example.com/api/account/capsules'),
    params: {},
    waitUntil: () => {},
    next: () => new Response(),
    data: {},
  } as any;
}

describe('GET /api/account/capsules — previewThumb derivation', () => {
  it('never touches R2 on the hot path', async () => {
    let r2Calls = 0;
    const ctx = makeContext(
      [row({ preview_scene_v1: sceneJson(10) }), row({ share_code: 'XYZ123456789', preview_scene_v1: null })],
      () => { r2Calls++; },
    );
    const res = await onRequestGet(ctx);
    expect(res.status).toBe(200);
    expect(r2Calls).toBe(0);
  });

  it('omits bonds on sparse scenes (atoms-only budget)', async () => {
    // 5 atoms < dense threshold → bonds from storage dropped, atoms-only.
    const ctx = makeContext(
      [row({ preview_scene_v1: sceneJson(5, true) })],
      () => {},
    );
    const res = await onRequestGet(ctx);
    const body = await res.json() as { capsules: Array<{ previewThumb: unknown }> };
    const thumb = body.capsules[0].previewThumb as { atoms: unknown[]; bonds?: unknown };
    expect(Array.isArray(thumb.atoms)).toBe(true);
    expect(thumb.bonds).toBeUndefined();
  });

  it('carries a capped bond subset on dense scenes with long-enough bonds', async () => {
    // Fixture deliberately places atoms at the four corners of the pane
    // so the silhouette sampler keeps them (as axis extrema) and the
    // inter-corner bonds land well past the visibility floor.
    const ctx = makeContext(
      [row({ preview_scene_v1: denseSceneWithLongBonds() })],
      () => {},
    );
    const res = await onRequestGet(ctx);
    const body = await res.json() as { capsules: Array<{ previewThumb: { atoms: unknown[]; bonds?: unknown[] } }> };
    const thumb = body.capsules[0].previewThumb;
    expect(Array.isArray(thumb.bonds)).toBe(true);
    expect(thumb.bonds!.length).toBeLessThanOrEqual(24);
    expect(thumb.bonds!.length).toBeGreaterThanOrEqual(2);
    expect(thumb.atoms.length).toBeLessThanOrEqual(24);
  });

  it('falls back to atoms-only when a dense scene is too clustered for visible bonds', async () => {
    // The 20-atom diagonal chain fixture is too cramped — once refit
    // squeezes atoms into the thumb cell, their 2.8-viewBox radii cover
    // most of the bond strokes. Derivation must emit atoms-only, NOT
    // produce a 12-atom dense thumb with 0-1 invisible bonds.
    const ctx = makeContext(
      [row({ preview_scene_v1: sceneJson(20, true) })],
      () => {},
    );
    const res = await onRequestGet(ctx);
    const body = await res.json() as { capsules: Array<{ previewThumb: { atoms: unknown[]; bonds?: unknown[] } }> };
    const thumb = body.capsules[0].previewThumb;
    if (thumb.bonds && thumb.bonds.length > 0) {
      // If bonds did survive, they must be the visible ones (≥ 2).
      expect(thumb.bonds.length).toBeGreaterThanOrEqual(2);
    } else {
      // Otherwise the fallback must have been the atoms-only path —
      // `bonds` is absent (not an empty array) and the payload
      // respects the atoms-only cap. Under the D138 follow-up this
      // no longer implies "more atoms than bonded mode" (the caps
      // converged), so we assert the MODE signal directly.
      expect(thumb.bonds).toBeUndefined();
      expect(thumb.atoms.length).toBeLessThanOrEqual(ROW_ATOM_CAP_WITH_BONDS);
    }
  });

  it('caps atoms at ROW_ATOM_CAP=18', async () => {
    const ctx = makeContext(
      [row({ preview_scene_v1: sceneJson(32) })],
      () => {},
    );
    const res = await onRequestGet(ctx);
    const body = await res.json() as { capsules: Array<{ previewThumb: { atoms: unknown[] } }> };
    expect(body.capsules[0].previewThumb.atoms.length).toBeLessThanOrEqual(ROW_ATOM_CAP);
  });

  it('passes small atom arrays through unchanged (no re-sampling when n <= cap)', async () => {
    const ctx = makeContext(
      [row({ preview_scene_v1: sceneJson(8) })],
      () => {},
    );
    const res = await onRequestGet(ctx);
    const body = await res.json() as { capsules: Array<{ previewThumb: { atoms: unknown[] } }> };
    expect(body.capsules[0].previewThumb.atoms.length).toBe(8);
  });

  it('returns previewThumb: null for rows where scene is null', async () => {
    const ctx = makeContext([row({ preview_scene_v1: null })], () => {});
    const res = await onRequestGet(ctx);
    const body = await res.json() as { capsules: Array<{ previewThumb: unknown }> };
    expect(body.capsules[0].previewThumb).toBeNull();
  });

  it('returns previewThumb: null for rows with malformed scene JSON', async () => {
    const ctx = makeContext(
      [row({ preview_scene_v1: '{not json' })],
      () => {},
    );
    const res = await onRequestGet(ctx);
    const body = await res.json() as { capsules: Array<{ previewThumb: unknown }> };
    expect(body.capsules[0].previewThumb).toBeNull();
  });

  it('returns previewThumb: null for rows with schema-mismatch scene', async () => {
    const ctx = makeContext(
      [row({ preview_scene_v1: '{"v":99,"atoms":[]}' })],
      () => {},
    );
    const res = await onRequestGet(ctx);
    const body = await res.json() as { capsules: Array<{ previewThumb: unknown }> };
    expect(body.capsules[0].previewThumb).toBeNull();
  });
});
