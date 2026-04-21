/**
 * End-to-end integration test for the stale-row backfill transition
 * (ADR D138 Lane A). Closes the gap the code-only review flagged:
 * selector tests, admin tests, and wrapper tests all pass, but none
 * prove that a rev<CURRENT row actually transitions to rev=CURRENT
 * through the live admin endpoint + library + account-derivation
 * chain.
 *
 * Flow:
 *   1. Seed a simulated D1 row whose `preview_scene_v1` carries an
 *      embedded thumb at `rev: 2` (pre-D138 shape).
 *   2. Assert that the account-route derivation (`deriveAccountThumb`)
 *      ignores the stale embedded thumb and live-samples from the
 *      stored scene (the `thumb-rev-stale` warn fires).
 *   3. Invoke the admin endpoint (`onRequestPost` from
 *      `functions/api/admin/backfill-preview-scenes.ts`) with the
 *      seeded row in D1 and the capsule blob in R2.
 *   4. Assert that the row's stored `preview_scene_v1.thumb.rev` is
 *      now `CURRENT_THUMB_REV` and the account-route derivation
 *      returns the pre-baked bonded thumb (fast path, no
 *      `thumb-rev-stale` warn).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { onRequestPost } from '../../functions/api/admin/backfill-preview-scenes';
import { projectCapsuleToSceneJson } from '../../src/share/publish-core';
import { deriveAccountThumb } from '../../src/share/capsule-preview-account-derive';
import { CURRENT_THUMB_REV } from '../../src/share/capsule-preview-scene-store';
import { makeC60Capsule } from '../../src/share/__fixtures__/capsule-preview-structures';
import type { Env } from '../../functions/env';

/** Drop the embedded thumb and re-emit it at a legacy rev, mimicking
 *  the pre-D138 state of a production row. */
function makeStaleSceneJson(capsule: ReturnType<typeof makeC60Capsule>): string {
  const fresh = projectCapsuleToSceneJson(capsule)!;
  const parsed = JSON.parse(fresh) as Record<string, unknown>;
  const staleThumb = parsed.thumb as Record<string, unknown> | undefined;
  if (staleThumb) staleThumb.rev = 2;
  return JSON.stringify(parsed);
}

/** In-memory D1 shim that stores one row and exposes update queries
 *  through the same `prepare(...).bind(...).run()` surface the
 *  backfill library uses. Deliberately minimal — the admin endpoint
 *  is exercised end-to-end but without spinning up Miniflare. */
function makeSeededDb(seed: { id: string; object_key: string; preview_scene_v1: string }) {
  const state = { ...seed };
  const prepare = (sql: string) => {
    let binds: unknown[] = [];
    const trimmed = sql.trimStart().toUpperCase();
    const isSelect = trimmed.startsWith('SELECT');
    const isUpdate = trimmed.startsWith('UPDATE');
    const isInsert = trimmed.startsWith('INSERT');
    return {
      bind(...values: unknown[]) { binds = values; return this; },
      async run() {
        if (isUpdate && sql.includes('preview_scene_v1 = ?')) {
          state.preview_scene_v1 = String(binds[0]);
        }
        // Audit-event INSERTs land here — treat as no-op but don't
        // fail; the endpoint spies on the audit call at the function
        // boundary so the SQL layer doesn't need to persist.
        if (isInsert) { /* no-op for this shim */ }
        return { success: true };
      },
      async first<T = unknown>() {
        if (isSelect) return state as unknown as T;
        return null;
      },
      async all<T = unknown>() {
        if (isSelect) return { success: true, results: [state] as T[] };
        return { success: true, results: [] as T[] };
      },
    };
  };
  return {
    state,
    db: { prepare, async batch() { return []; } } as unknown as Env['DB'],
  };
}

function makeR2WithBlob(key: string, blob: string) {
  return {
    async get(k: string) {
      if (k !== key) return null;
      return { text: async () => blob };
    },
  } as unknown as Env['R2_BUCKET'];
}

function makeContext(env: Env) {
  const request = new Request('http://localhost/api/admin/backfill-preview-scenes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  return { request, env, params: {} } as unknown as Parameters<typeof onRequestPost>[0];
}

describe('stale-row → backfill → account integration', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it('transitions a rev:2 row to rev:CURRENT_THUMB_REV with a bonded thumb', async () => {
    const capsule = makeC60Capsule();
    const capsuleJson = JSON.stringify(capsule);
    const staleSceneJson = makeStaleSceneJson(capsule);

    // Sanity: the seeded row truly carries rev:2.
    const storedPre = JSON.parse(staleSceneJson);
    expect(storedPre.thumb.rev).toBe(2);

    // Account-route path BEFORE backfill: `deriveAccountThumb`
    // detects thumb-rev-stale, drops the embedded bytes, and live-
    // samples from the stored scene.
    const pre = deriveAccountThumb(staleSceneJson);
    expect(pre).not.toBeNull();
    expect(
      warnSpy.mock.calls.some((c: unknown[]) =>
        c.some((a: unknown) => typeof a === 'string' && a.includes('thumb-rev-stale')),
      ),
    ).toBe(true);

    // Run the admin endpoint against a D1 + R2 pair holding the
    // seeded row + capsule blob.
    const seed = makeSeededDb({
      id: 'row-1',
      object_key: 'capsules/row-1/capsule.atomdojo',
      preview_scene_v1: staleSceneJson,
    });
    const env: Env = {
      DB: seed.db,
      R2_BUCKET: makeR2WithBlob(seed.state.object_key, capsuleJson),
      DEV_ADMIN_ENABLED: 'true',
    };
    const res = await onRequestPost(makeContext(env));
    expect(res.status).toBe(200);
    const summary = await res.json() as {
      scanned: number; updated: number; skipped: number; failed: unknown[];
    };
    expect(summary.scanned).toBe(1);
    expect(summary.updated).toBe(1);
    expect(summary.failed.length).toBe(0);

    // Post-backfill: D1 row now carries rev:CURRENT_THUMB_REV + bonds.
    const storedPost = JSON.parse(seed.state.preview_scene_v1);
    expect(storedPost.thumb.rev).toBe(CURRENT_THUMB_REV);
    expect(storedPost.thumb.atoms.length).toBeGreaterThan(0);
    expect(storedPost.thumb.bonds?.length ?? 0).toBeGreaterThanOrEqual(2);

    // Fresh warn counter for the post-backfill derivation —
    // stored-thumb fast path must NOT emit `thumb-rev-stale` now.
    warnSpy.mockClear();
    const post = deriveAccountThumb(seed.state.preview_scene_v1);
    expect(post).not.toBeNull();
    expect(post!.bonds?.length ?? 0).toBeGreaterThanOrEqual(2);
    expect(
      warnSpy.mock.calls.some((c: unknown[]) =>
        c.some((a: unknown) => typeof a === 'string' && a.includes('thumb-rev-stale')),
      ),
    ).toBe(false);

    // Pre vs post MUST differ (pre = live-sampled atoms-only-or-
    // relaxed, post = pre-baked stored-thumb fast path).
    expect(JSON.stringify(pre)).not.toBe(JSON.stringify(post));
  });
});
