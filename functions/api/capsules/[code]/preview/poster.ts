/**
 * GET /api/capsules/:code/preview/poster — serve preview poster image.
 *
 * Branches:
 *   stored ready → 200 image/png from R2, immutable for a year
 *   dynamic       → 200 image/png generated via Satori/ImageResponse
 *                   from the pre-baked preview_scene_v1 (lazy-backfilled
 *                   from R2 on V2 cold rows)
 *   render error  → 200 image/png from /og-fallback.png (terminal fallback)
 *   inaccessible / flag-off & not stored → 404
 *
 * Every response emits a structured log line for observability.
 * The `?v=` query param is a cache key only and is ignored by the route.
 *
 * V2 notes (spec §S1): the dynamic branch reads `preview_scene_v1` from D1
 * instead of reconstructing the scene from row metadata. When the column is
 * NULL (pre-V2 rows that haven't been backfilled), the route fetches the
 * capsule blob from R2 ONCE, projects the scene, writes it back to D1, and
 * renders. Subsequent requests hit the fast path.
 */

import type { Env } from '../../../../env';
import { normalizeShareInput } from '../../../../../src/share/share-code';
import {
  isAccessibleStatus,
  isDynamicPreviewFallbackEnabled,
} from '../../../../../src/share/share-record';
import type { CapsuleShareRow } from '../../../../../src/share/share-record';
import {
  fnv1a32Hex,
  sanitizeCapsuleTitle,
  TEMPLATE_VERSION,
} from '../../../../../src/share/capsule-preview';
import {
  parsePreviewSceneV1,
  type PreviewSceneV1,
} from '../../../../../src/share/capsule-preview-scene-store';
import { projectCapsuleToSceneJson } from '../../../../../src/share/publish-core';
import {
  validateCapsuleFile,
  type AtomDojoPlaybackCapsuleFileV1,
} from '../../../../../src/history/history-file-v1';

type PosterMode = 'stored' | 'generated' | 'error' | 'flag-off' | 'inaccessible';

export interface PosterRenderMeta {
  sanitizedTitle: string;
  subtitle: string;
  shareCode: string;
}

interface PosterLogEntry {
  code: string;
  mode: PosterMode;
  durationMs: number;
  status: number;
  cause?: string;
}

function logPoster(entry: PosterLogEntry): void {
  // Structured stdout — visible via `wrangler pages deployment tail`.
  console.log(`[capsule-poster] ${JSON.stringify(entry)}`);
}

/** PNG signature (8-byte magic). A buffer that doesn't start with this is
 *  not a valid PNG, regardless of what Content-Type the producer claimed. */
const PNG_MAGIC = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Cheap structural check — short-circuits on length and magic bytes. */
function looksLikePng(bytes: Uint8Array): boolean {
  if (bytes.byteLength < PNG_MAGIC.byteLength) return false;
  for (let i = 0; i < PNG_MAGIC.byteLength; i++) {
    if (bytes[i] !== PNG_MAGIC[i]) return false;
  }
  return true;
}

// 1×1 transparent PNG — fallback-for-the-fallback.
const TRANSPARENT_PIXEL_PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
  0x89, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x44, 0x41,
  0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00,
  0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
  0x42, 0x60, 0x82,
]);

function formatSubtitle(row: CapsuleShareRow): string {
  const parts: string[] = [];
  if (Number.isFinite(row.atom_count) && row.atom_count > 0) {
    parts.push(`${row.atom_count} atoms`);
  }
  if (Number.isFinite(row.frame_count) && row.frame_count > 0) {
    parts.push(`${row.frame_count} frames`);
  }
  if (parts.length === 0) return 'Interactive molecular dynamics scene';
  return parts.join(' · ');
}

async function serveTerminalFallback(
  request: Request,
  code: string,
  startedAt: number,
  cause: string,
): Promise<Response> {
  try {
    const url = new URL('/og-fallback.png', request.url);
    const fb = await fetch(url.toString());
    if (fb.ok && fb.body) {
      logPoster({
        code,
        mode: 'error',
        status: 200,
        durationMs: Date.now() - startedAt,
        cause,
      });
      return new Response(fb.body, {
        status: 200,
        headers: {
          'Content-Type': 'image/png',
          'Cache-Control': 'public, max-age=60',
          'Access-Control-Allow-Origin': '*',
          'X-Content-Type-Options': 'nosniff',
        },
      });
    }
    throw new Error(`fallback fetch returned ${fb.status}`);
  } catch (fbErr) {
    // Preserve the ORIGINAL cause that triggered the fallback (e.g. a
    // satori-threw rejection). Otherwise the only loggable signal becomes
    // 'fallback-fetch-failed', and the actual upstream failure that put us
    // here is unrecoverable from logs.
    const fbMsg = fbErr instanceof Error ? fbErr.message : String(fbErr);
    logPoster({
      code,
      mode: 'error',
      status: 200,
      durationMs: Date.now() - startedAt,
      cause: `${cause}; fallback-fetch-failed:${fbMsg}`,
    });
    return new Response(TRANSPARENT_PIXEL_PNG, {
      status: 200,
      headers: {
        'Content-Type': 'image/png',
        'Cache-Control': 'public, max-age=60',
        'Access-Control-Allow-Origin': '*',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  }
}

/** Test seam — vitest can swap in a synchronous renderer so the route can run
 *  outside the workerd runtime. Production codepath uses `import()` of
 *  `_lib/capsule-preview-image`. The seam takes the same scene + meta the
 *  production renderer takes so the contract is identical across paths
 *  (spec §V1 Carry-Over Checklist, updated for V2). */
type SceneRenderer = (
  scene: PreviewSceneV1,
  meta: PosterRenderMeta,
) => Promise<Response> | Response;

let rendererOverride: SceneRenderer | null = null;

export function __setRendererForTesting(fn: SceneRenderer | null): void {
  rendererOverride = fn;
}

/** Two-phase failure isolation: lazy-import errors and Satori-render errors
 *  surface with distinct cause strings, so the structured log doesn't
 *  falsely accuse Satori for a font/wasm/plugin import problem. */
async function generateDynamicPoster(
  scene: PreviewSceneV1,
  meta: PosterRenderMeta,
): Promise<Response> {
  if (rendererOverride) return rendererOverride(scene, meta);
  let mod: typeof import('../../../../_lib/capsule-preview-image');
  try {
    mod = await import('../../../../_lib/capsule-preview-image');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`module-import-failed:${msg}`);
  }
  return mod.renderCapsulePosterImage(scene, meta);
}

/**
 * Stable, content-bound ETag for a dynamic poster — derived from a
 * canonical serialization of the actual rendered scene (spec §ETag binding).
 * Changes whenever any of: TEMPLATE_VERSION, scene hash, sanitized title,
 * or share code change.
 */
function dynamicPosterETag(
  scene: PreviewSceneV1,
  sanitizedTitle: string,
  shareCode: string,
): string {
  const canonical = [
    `t${TEMPLATE_VERSION}`,
    scene.hash,
    sanitizedTitle,
    shareCode,
  ].join('|');
  return `"v${TEMPLATE_VERSION}-${fnv1a32Hex(canonical)}"`;
}

/**
 * Lazy-backfill path: fetch the capsule blob from R2, project the scene,
 * write the serialized JSON back to D1. Writes are awaited but failures
 * do NOT prevent serving the poster (the scene is already computed in
 * memory). Subsequent requests for this row will hit the fast path.
 */
async function lazyBackfillScene(
  env: Env,
  row: CapsuleShareRow,
): Promise<{ scene: PreviewSceneV1; sceneJson: string } | { error: string }> {
  if (!row.object_key) return { error: 'blob-missing' };
  const obj = await env.R2_BUCKET.get(row.object_key);
  if (!obj) return { error: 'blob-missing' };
  let text: string;
  try {
    text = await obj.text();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { error: `blob-read-failed:${msg}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { error: `capsule-parse-failed:${msg}` };
  }
  const errors = validateCapsuleFile(parsed);
  if (errors.length > 0) {
    return { error: `capsule-parse-failed:${errors[0]}` };
  }
  const capsule = parsed as AtomDojoPlaybackCapsuleFileV1;
  const sceneJson = projectCapsuleToSceneJson(capsule);
  if (!sceneJson) return { error: 'no-dense-frames' };
  const scene = parsePreviewSceneV1(sceneJson);
  if (!scene || scene.atoms.length === 0) return { error: 'scene-empty' };
  // Fire-and-observe: write back to D1 so the next request hits the fast
  // path. Await it so errors surface — but a failed write does NOT block
  // serving the poster we already have in memory.
  try {
    // Include the IS NULL gate so a concurrent writer (or a post-V2
    // publish on the same row) cannot be overwritten by a stale lazy
    // backfill. deriveScene is deterministic, so losing the race is a
    // benign no-op rather than a consistency hazard.
    await env.DB.prepare(
      `UPDATE capsule_share SET preview_scene_v1 = ?
         WHERE id = ? AND preview_scene_v1 IS NULL`,
    ).bind(sceneJson, row.id).run();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[capsule-poster] lazy-backfill write failed: ${msg}`);
  }
  return { scene, sceneJson };
}

export const onRequestGet: PagesFunction<Env> = async (context) => {
  const startedAt = Date.now();
  const rawCode = context.params.code;
  const codeForLog = typeof rawCode === 'string' ? rawCode.slice(0, 32) : '';

  if (typeof rawCode !== 'string') {
    logPoster({ code: codeForLog, mode: 'inaccessible', status: 404, durationMs: Date.now() - startedAt });
    return new Response('Not found', { status: 404, headers: { 'Cache-Control': 'public, max-age=60' } });
  }
  const code = normalizeShareInput(rawCode);
  if (!code) {
    logPoster({ code: codeForLog, mode: 'inaccessible', status: 404, durationMs: Date.now() - startedAt });
    return new Response('Not found', { status: 404, headers: { 'Cache-Control': 'public, max-age=60' } });
  }

  const row = await context.env.DB.prepare(
    'SELECT * FROM capsule_share WHERE share_code = ?',
  )
    .bind(code)
    .first<CapsuleShareRow>();

  if (!row || !isAccessibleStatus(row.status)) {
    logPoster({ code, mode: 'inaccessible', status: 404, durationMs: Date.now() - startedAt });
    return new Response('Not found', { status: 404, headers: { 'Cache-Control': 'public, max-age=60' } });
  }

  // Selection: stored takes precedence; dynamic gated on flag.
  const hasStored = row.preview_status === 'ready' && !!row.preview_poster_key;
  const dynamicEnabled = isDynamicPreviewFallbackEnabled(context.env);

  if (hasStored) {
    const object = await context.env.R2_BUCKET.get(row.preview_poster_key!);
    if (!object) {
      return serveTerminalFallback(context.request, code, startedAt, 'r2-miss');
    }
    // Materialize R2 stream before re-wrapping. Same workerd quirk as the
    // dynamic branch: streaming bodies handed straight into a new Response
    // can drop bytes silently. Validate PNG signature before serving with
    // a 1-year immutable cache header — a corrupt/truncated stored asset
    // pinned for a year would be unrecoverable from social caches.
    const bytes = new Uint8Array(await object.arrayBuffer());
    if (!looksLikePng(bytes)) {
      return serveTerminalFallback(context.request, code, startedAt, `stored-not-png:${bytes.byteLength}b`);
    }
    logPoster({ code, mode: 'stored', status: 200, durationMs: Date.now() - startedAt });
    return new Response(bytes, {
      status: 200,
      headers: {
        'Content-Type': object.httpMetadata?.contentType ?? 'image/png',
        'Cache-Control': 'public, max-age=31536000, immutable',
        'Access-Control-Allow-Origin': '*',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  }

  if (!dynamicEnabled) {
    logPoster({ code, mode: 'flag-off', status: 404, durationMs: Date.now() - startedAt });
    return new Response('Not found', { status: 404, headers: { 'Cache-Control': 'public, max-age=60' } });
  }

  // V2 dynamic branch: read pre-baked scene; fall back to lazy backfill.
  let scene: PreviewSceneV1 | null = parsePreviewSceneV1(row.preview_scene_v1);
  if (!scene || scene.atoms.length === 0) {
    // preview_scene_v1 is absent OR malformed — treat malformed as null so
    // the lazy-backfill rewrites the cell with a fresh render on next call.
    if (row.preview_scene_v1 != null && scene == null) {
      // Diagnostic breadcrumb for ops — malformed JSON in a TEXT column is
      // rare enough that we want a signal when it happens.
      console.warn(`[capsule-poster] scene-parse-failed for share=${code}`);
    }
    const backfill = await lazyBackfillScene(context.env, row);
    if ('error' in backfill) {
      const cause = backfill.error === 'blob-missing'
        ? 'scene-missing'
        : backfill.error;
      return serveTerminalFallback(context.request, code, startedAt, cause);
    }
    scene = backfill.scene;
  }

  try {
    const sanitizedTitle = sanitizeCapsuleTitle(row.title);
    const meta: PosterRenderMeta = {
      sanitizedTitle,
      subtitle: formatSubtitle(row),
      shareCode: row.share_code,
    };
    const response = await generateDynamicPoster(scene, meta);
    // Materialize the body before re-wrapping. workerd's stream pipeline
    // can drop bytes when an ImageResponse stream is handed straight to a
    // new Response; reading to an ArrayBuffer first sidesteps that and is
    // cheap (typical poster ≤ a few hundred KB). Validate PNG signature so
    // we never serve a 200 image/png with an empty/garbage body — social
    // unfurlers cache that under our permissive Cache-Control for hours.
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (!looksLikePng(bytes)) {
      return serveTerminalFallback(
        context.request, code, startedAt,
        `dynamic-not-png:${bytes.byteLength}b`,
      );
    }
    const headers = new Headers(response.headers);
    headers.set('Content-Type', 'image/png');
    headers.set(
      'Cache-Control',
      'public, max-age=300, s-maxage=3600, stale-while-revalidate=86400',
    );
    headers.set('ETag', dynamicPosterETag(scene, sanitizedTitle, row.share_code));
    headers.set('Access-Control-Allow-Origin', '*');
    headers.set('X-Content-Type-Options', 'nosniff');
    logPoster({ code, mode: 'generated', status: 200, durationMs: Date.now() - startedAt });
    return new Response(bytes, { status: 200, headers });
  } catch (err) {
    // Pre-tagged module-import-failed errors come from generateDynamicPoster's
    // import wrapper; everything else here is a real Satori render rejection.
    const raw = err instanceof Error ? err.message : String(err);
    const cause = raw.startsWith('module-import-failed:') ? raw : `satori-threw:${raw}`;
    return serveTerminalFallback(context.request, code, startedAt, cause);
  }
};
