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
import {
  healBondlessRow,
  rebakeSceneFromR2,
  sceneIsBondless,
} from '../../../../../src/share/capsule-preview-heal';

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
      // `module-import-failed` is a PLATFORM failure (missing asset
      // in the build output) — every capsule is broken until a
      // redeploy. Use `no-cache` so edge caches don't lock in the
      // fallback PNG for 60 s after a bad deploy; ops pages faster
      // and the retry loop is tight once the fix ships. Scene-
      // specific Satori errors (`satori-threw:*`) remain cacheable
      // at 60 s since they're per-capsule, not site-wide. Audit
      // finding: SFH #6. */
      const isPlatformFailure = cause.startsWith('module-import-failed:');
      const cacheControl = isPlatformFailure
        ? 'no-cache, no-store, must-revalidate'
        : 'public, max-age=60';
      return new Response(fb.body, {
        status: 200,
        headers: {
          'Content-Type': 'image/png',
          'Cache-Control': cacheControl,
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
  const sceneMissing = !scene || scene.atoms.length === 0;
  // Also heal scenes whose atoms are intact but whose bonds are
  // empty everywhere — those are pre-fix legacy rows that baked
  // atoms-only under the old publish-time bond filters. A fresh
  // rebake via the current path (3D topology + relaxed thresholds)
  // produces a scene with bonds; the `overwriteExisting = true`
  // write replaces the stale row in-place so future reads fast-
  // path to the healed data.
  const sceneBondless = scene != null && !sceneMissing && sceneIsBondless(scene);
  // Track whether a bondless fallback is being served so the
  // structured poster log carries the cause — otherwise ops can't
  // distinguish "fresh render with full bonds" from "served stale
  // bondless scene because heal kept failing".
  let bondlessHealFailure: string | null = null;
  if (sceneMissing) {
    if (row.preview_scene_v1 != null && scene == null) {
      console.warn(`[capsule-poster] scene-parse-failed for share=${code}`);
    }
    const backfill = await rebakeSceneFromR2(context.env, row);
    if (!backfill.ok) {
      const cause = backfill.reason === 'blob-missing'
        ? 'scene-missing'
        : backfill.reason;
      return serveTerminalFallback(context.request, code, startedAt, cause);
    }
    scene = backfill.scene;
  } else if (sceneBondless) {
    // Heal the bondless legacy row by rebaking from R2 and overwriting
    // `preview_scene_v1` in place. Serve the healed scene. On rebake
    // failure, fall through and serve whatever bondless scene we have;
    // a bondless poster is still preferable to the terminal fallback.
    const healed = await healBondlessRow(context.env, row);
    if (healed.ok) {
      scene = healed.scene;
    } else {
      bondlessHealFailure = healed.reason;
      console.warn(`[capsule-poster] bondless-heal-failed: ${healed.reason} share=${code}`);
    }
  }

  // Narrowing guard for the TS checker. Every path above either
  // assigned a non-null scene OR returned early via the terminal
  // fallback, so in practice `scene` is always non-null here —
  // but the compiler can't prove that through the reassignable
  // `let`. A defensive terminal-fallback on the unreachable null
  // path is cheap insurance.
  if (!scene) {
    return serveTerminalFallback(context.request, code, startedAt, 'scene-null-post-heal');
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
    logPoster({
      code,
      mode: 'generated',
      status: 200,
      durationMs: Date.now() - startedAt,
      // Surface bondless-heal failures on the structured success
      // log so ops can query "successful render but bondless" in
      // one stream without grepping two log shapes.
      ...(bondlessHealFailure !== null
        ? { cause: `bondless-heal-failed:${bondlessHealFailure}` }
        : {}),
    });
    return new Response(bytes, { status: 200, headers });
  } catch (err) {
    // Pre-tagged module-import-failed errors come from generateDynamicPoster's
    // import wrapper; everything else here is a real Satori render rejection.
    const raw = err instanceof Error ? err.message : String(err);
    const cause = raw.startsWith('module-import-failed:') ? raw : `satori-threw:${raw}`;
    return serveTerminalFallback(context.request, code, startedAt, cause);
  }
};
