/**
 * GET /c/:code — share-preview HTML route.
 *
 * For browsers: returns HTML with preview metadata and immediate client redirect to /watch/?c=<code>.
 * For bots/unfurlers: the same HTML exposes og: metadata without requiring JS.
 *
 * Returns 404 for non-accessible statuses and unknown codes.
 *
 * Capsule-preview V1 (April 2026, spec §9): emits og:image / twitter:image for
 * every accessible capsule when CAPSULE_PREVIEW_DYNAMIC_FALLBACK is on; uses
 * canonical brand name "Atom Dojo" (with space) per docs/glossary.md.
 */

import type { Env } from '../env';
import { normalizeShareInput } from '../../src/share/share-code';
import {
  isAccessibleStatus,
  isDynamicPreviewFallbackEnabled,
  toMetadataResponse,
} from '../../src/share/share-record';
import type { CapsuleShareRow } from '../../src/share/share-record';
import {
  CAPSULE_TITLE_FALLBACK,
  sanitizeCapsuleTitle,
} from '../../src/share/capsule-preview';

export const onRequestGet: PagesFunction<Env> = async (context) => {
  const rawCode = context.params.code;
  if (typeof rawCode !== 'string') {
    return new Response('Not found', { status: 404 });
  }

  const code = normalizeShareInput(rawCode);
  if (!code) {
    return new Response('Not found', { status: 404 });
  }

  const row = await context.env.DB.prepare(
    'SELECT * FROM capsule_share WHERE share_code = ?',
  )
    .bind(code)
    .first<CapsuleShareRow>();

  if (!row || !isAccessibleStatus(row.status)) {
    return new Response('Not found', { status: 404 });
  }

  const dynamicFallbackEnabled = isDynamicPreviewFallbackEnabled(context.env);
  const meta = toMetadataResponse(row, { dynamicFallbackEnabled });
  const watchUrl = `/watch/?c=${code}`;

  // Build description from metadata
  const descParts: string[] = [];
  if (meta.atomCount) descParts.push(`${meta.atomCount} atoms`);
  if (meta.frameCount) descParts.push(`${meta.frameCount} frames`);
  if (meta.durationPs) descParts.push(`${meta.durationPs.toFixed(1)} ps`);
  const description = descParts.length > 0
    ? `Molecular simulation: ${descParts.join(', ')}`
    : 'Molecular simulation capsule on Atom Dojo';

  // Spec §3 / §9: titles routed to image surfaces ALWAYS pass through the
  // sanitizer. Canonical fallback is "Atom Dojo Capsule" (with space).
  const sanitizedTitle = sanitizeCapsuleTitle(row.title);

  // Spec §10 alt-text template (≤420 chars).
  const altText = (
    sanitizedTitle === CAPSULE_TITLE_FALLBACK
      ? `Atom Dojo capsule ${code} — ${meta.atomCount} atoms, ${meta.frameCount} frames`
      : `${sanitizedTitle} — Atom Dojo capsule ${code} — ${meta.atomCount} atoms, ${meta.frameCount} frames`
  ).slice(0, 420);

  // og:image only when meta exposes a poster endpoint — absolute URL for
  // unfurler reliability.
  const absolutePosterUrl = meta.preview?.posterUrl
    ? new URL(meta.preview.posterUrl, context.request.url).toString()
    : null;
  const ogImageTags = absolutePosterUrl
    ? [
        `<meta property="og:image" content="${escapeHtml(absolutePosterUrl)}" />`,
        `<meta property="og:image:width" content="1200" />`,
        `<meta property="og:image:height" content="630" />`,
        `<meta property="og:image:alt" content="${escapeHtml(altText)}" />`,
      ].join('\n  ')
    : '';
  const twitterImageTags = absolutePosterUrl
    ? [
        `<meta name="twitter:image" content="${escapeHtml(absolutePosterUrl)}" />`,
        `<meta name="twitter:image:alt" content="${escapeHtml(altText)}" />`,
      ].join('\n  ')
    : '';
  const twitterCard = absolutePosterUrl ? 'summary_large_image' : 'summary';

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(sanitizedTitle)}</title>
  <meta property="og:title" content="${escapeHtml(sanitizedTitle)}" />
  <meta property="og:description" content="${escapeHtml(description)}" />
  <meta property="og:type" content="website" />
  ${ogImageTags}
  <meta name="twitter:card" content="${twitterCard}" />
  <meta name="twitter:title" content="${escapeHtml(sanitizedTitle)}" />
  <meta name="twitter:description" content="${escapeHtml(description)}" />
  ${twitterImageTags}
  <meta http-equiv="refresh" content="0;url=${escapeHtml(watchUrl)}" />
</head>
<body>
  <p>Opening in Watch&hellip; <a href="${escapeHtml(watchUrl)}">Click here</a> if not redirected.</p>
</body>
</html>`;

  return new Response(html, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'public, max-age=60',
    },
  });
};

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
