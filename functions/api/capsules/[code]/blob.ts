/**
 * GET /api/capsules/:code/blob — stream capsule blob from R2.
 *
 * Returns 200 with the capsule JSON blob for accessible records.
 * Returns 404 for non-accessible statuses and unknown codes.
 * Sets safe response headers (Content-Disposition: attachment, nosniff).
 */

import type { Env } from '../../../env';
import { normalizeShareInput } from '../../../../src/share/share-code';
import { isAccessibleShare } from '../../../../src/share/share-record';
import type { CapsuleShareRow } from '../../../../src/share/share-record';

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
    'SELECT id, status, object_key, share_code, expires_at FROM capsule_share WHERE share_code = ?',
  )
    .bind(code)
    .first<Pick<CapsuleShareRow, 'id' | 'status' | 'object_key' | 'share_code' | 'expires_at'>>();

  if (!row || !isAccessibleShare(row, new Date().toISOString())) {
    return new Response('Not found', { status: 404 });
  }

  const object = await context.env.R2_BUCKET.get(row.object_key);
  if (!object) {
    console.error(
      `[blob] R2 object missing for accessible record: share_code=${code}, object_key=${row.object_key}, id=${row.id}`,
    );
    return new Response('Capsule data unavailable', { status: 502 });
  }

  return new Response(object.body, {
    headers: {
      'Content-Type': 'application/json',
      'Content-Disposition': `attachment; filename="atomdojo-capsule-${row.share_code}.atomdojo"`,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'public, max-age=3600',
    },
  });
};
