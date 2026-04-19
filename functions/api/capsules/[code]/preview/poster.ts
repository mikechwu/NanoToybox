/**
 * GET /api/capsules/:code/preview/poster — serve preview poster image (spec §6).
 *
 * Branches:
 *   stored ready → 200 image/png from R2, immutable for a year
 *   dynamic       → 200 image/png generated via Satori/ImageResponse (V1 fallback)
 *   render error  → 200 image/png from /og-fallback.png (terminal fallback)
 *   inaccessible / flag-off & not stored → 404
 *
 * Every response emits a structured log line for observability (spec §13).
 * The `?v=` query param is a cache key only and is ignored by the route.
 */

import type { Env } from '../../../../env';
import { normalizeShareInput } from '../../../../../src/share/share-code';
import {
  isAccessibleStatus,
  isDynamicPreviewFallbackEnabled,
} from '../../../../../src/share/share-record';
import type { CapsuleShareRow } from '../../../../../src/share/share-record';
import {
  buildCapsulePreviewDescriptor,
  fnv1a32Hex,
  TEMPLATE_VERSION,
  type CapsulePreviewInput,
} from '../../../../../src/share/capsule-preview';

type PosterMode = 'stored' | 'generated' | 'error' | 'flag-off' | 'inaccessible';

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

// 1×1 transparent PNG — fallback-for-the-fallback (spec §4).
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

function rowToPreviewInput(row: CapsuleShareRow): CapsulePreviewInput {
  return {
    shareCode: row.share_code,
    title: row.title,
    kind: row.kind,
    atomCount: row.atom_count,
    frameCount: row.frame_count,
    sizeBytes: row.size_bytes,
    createdAt: row.created_at ?? null,
  };
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
 *  `_lib/capsule-preview-image`. The seam takes the same descriptor the
 *  production renderer takes (no separate input thread) so the contract is
 *  identical across paths. */
type DescriptorRenderer = (
  descriptor: ReturnType<typeof buildCapsulePreviewDescriptor>,
) => Promise<Response> | Response;

let rendererOverride: DescriptorRenderer | null = null;

export function __setRendererForTesting(fn: DescriptorRenderer | null): void {
  rendererOverride = fn;
}

/** Two-phase failure isolation: lazy-import errors and Satori-render errors
 *  surface with distinct cause strings, so the structured log doesn't
 *  falsely accuse Satori for a font/wasm/plugin import problem. */
async function generateDynamicPoster(
  descriptor: ReturnType<typeof buildCapsulePreviewDescriptor>,
): Promise<Response> {
  if (rendererOverride) return rendererOverride(descriptor);
  let mod: typeof import('../../../../_lib/capsule-preview-image');
  try {
    mod = await import('../../../../_lib/capsule-preview-image');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`module-import-failed:${msg}`);
  }
  return mod.renderCapsulePosterImage(descriptor);
}

/**
 * Stable, content-bound ETag for a dynamic poster — derived from a
 * canonical serialization of the actual render-affecting descriptor fields
 * (spec §6 contract). Changes whenever any of: TEMPLATE_VERSION, sanitized
 * title, subtitle, figure variant, accent color, or density change.
 */
function dynamicPosterETag(
  descriptor: ReturnType<typeof buildCapsulePreviewDescriptor>,
): string {
  const canonical = [
    `t${TEMPLATE_VERSION}`,
    descriptor.title,
    descriptor.subtitle,
    descriptor.figureVariant,
    descriptor.accentColor,
    descriptor.density,
    descriptor.shareCode,
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

  // Selection (spec §6): stored takes precedence; dynamic gated on flag.
  const hasStored = row.preview_status === 'ready' && !!row.preview_poster_key;
  const dynamicEnabled = isDynamicPreviewFallbackEnabled(context.env);

  if (hasStored) {
    const object = await context.env.R2_BUCKET.get(row.preview_poster_key!);
    if (!object) {
      // R2 miss for a "ready" row — degrade to terminal fallback so the
      // social card still has an image.
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

  try {
    const input = rowToPreviewInput(row);
    const descriptor = buildCapsulePreviewDescriptor(input, {
      mode: 'static-figure',
      themeVariant: 'light',
    });
    const response = await generateDynamicPoster(descriptor);
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
    // Spec §6 — ETag is bound to the actual render inputs, so any sanitized-
    // title / subtitle / variant / accent / density / template-version change
    // produces a different validator and conditional GETs revalidate.
    headers.set('ETag', dynamicPosterETag(descriptor));
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
