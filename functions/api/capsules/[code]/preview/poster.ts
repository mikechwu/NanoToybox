/**
 * GET /api/capsules/:code/preview/poster — serve preview poster image.
 *
 * Returns 200 with poster image for ready records with a poster asset.
 * Returns 404 when poster is pending (not an error — preview not yet generated).
 * Returns 404 for non-accessible statuses and unknown codes.
 */

import type { Env } from '../../../../env';
import { normalizeShareInput } from '../../../../../src/share/share-code';
import { isAccessibleStatus } from '../../../../../src/share/share-record';
import type { CapsuleShareRow } from '../../../../../src/share/share-record';

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
    'SELECT status, preview_status, preview_poster_key FROM capsule_share WHERE share_code = ?',
  )
    .bind(code)
    .first<Pick<CapsuleShareRow, 'status' | 'preview_status' | 'preview_poster_key'>>();

  if (!row || !isAccessibleStatus(row.status)) {
    return new Response('Not found', { status: 404 });
  }

  // Poster not yet generated — 404, not an error
  if (row.preview_status !== 'ready' || !row.preview_poster_key) {
    return new Response('Not found', { status: 404 });
  }

  const object = await context.env.R2_BUCKET.get(row.preview_poster_key);
  if (!object) {
    return new Response('Not found', { status: 404 });
  }

  return new Response(object.body, {
    headers: {
      'Content-Type': object.httpMetadata?.contentType ?? 'image/png',
      'Cache-Control': 'public, max-age=86400',
      'X-Content-Type-Options': 'nosniff',
    },
  });
};
