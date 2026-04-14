/**
 * GET /c/:code — share-preview HTML route.
 *
 * For browsers: returns HTML with preview metadata and immediate client redirect to /watch/?c=<code>.
 * For bots/unfurlers: the same HTML exposes og: metadata without requiring JS.
 *
 * Returns 404 for non-accessible statuses and unknown codes.
 */

import type { Env } from '../env';
import { normalizeShareInput } from '../../src/share/share-code';
import { isAccessibleStatus, toMetadataResponse } from '../../src/share/share-record';
import type { CapsuleShareRow } from '../../src/share/share-record';

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

  const meta = toMetadataResponse(row);
  const watchUrl = `/watch/?c=${code}`;

  // Build description from metadata
  const descParts: string[] = [];
  if (meta.atomCount) descParts.push(`${meta.atomCount} atoms`);
  if (meta.frameCount) descParts.push(`${meta.frameCount} frames`);
  if (meta.durationPs) descParts.push(`${meta.durationPs.toFixed(1)} ps`);
  const description = descParts.length > 0
    ? `Molecular simulation: ${descParts.join(', ')}`
    : 'Molecular simulation capsule on AtomDojo';

  const title = row.title ?? 'AtomDojo Capsule';

  // og:image only when poster is actually ready — absolute URL for unfurler reliability
  const absolutePosterUrl = meta.preview?.posterUrl
    ? new URL(meta.preview.posterUrl, context.request.url).toString()
    : null;
  const ogImageTag = absolutePosterUrl
    ? `<meta property="og:image" content="${escapeHtml(absolutePosterUrl)}" />`
    : '';
  const twitterImageTag = absolutePosterUrl
    ? `<meta name="twitter:image" content="${escapeHtml(absolutePosterUrl)}" />`
    : '';
  const twitterCard = absolutePosterUrl ? 'summary_large_image' : 'summary';

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)}</title>
  <meta property="og:title" content="${escapeHtml(title)}" />
  <meta property="og:description" content="${escapeHtml(description)}" />
  <meta property="og:type" content="website" />
  ${ogImageTag}
  <meta name="twitter:card" content="${twitterCard}" />
  <meta name="twitter:title" content="${escapeHtml(title)}" />
  <meta name="twitter:description" content="${escapeHtml(description)}" />
  ${twitterImageTag}
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
