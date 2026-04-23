/**
 * GET /api/capsules/:code — resolve share metadata.
 *
 * Returns 200 with public metadata for accessible records (ready, ready_pending_preview).
 * Returns 404 for non-accessible statuses and unknown codes.
 */

import type { Env } from '../../env';
import { normalizeShareInput } from '../../../src/share/share-code';
import { isAccessibleShare, isDynamicPreviewFallbackEnabled, toMetadataResponse } from '../../../src/share/share-record';
import type { CapsuleShareRow } from '../../../src/share/share-record';

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

  if (!row || !isAccessibleShare(row, new Date().toISOString())) {
    return new Response('Not found', { status: 404 });
  }

  // Update last_accessed_at (fire-and-forget, do not block response)
  context.waitUntil(
    context.env.DB.prepare(
      'UPDATE capsule_share SET last_accessed_at = ? WHERE id = ?',
    )
      .bind(new Date().toISOString(), row.id)
      .run()
      .catch((err) => {
        console.error(`[capsule-meta] last_accessed_at update failed for ${row.id}: ${err instanceof Error ? err.message : String(err)}`);
      }),
  );

  return Response.json(
    toMetadataResponse(row, {
      dynamicFallbackEnabled: isDynamicPreviewFallbackEnabled(context.env),
    }),
    {
      headers: {
        'Cache-Control': 'public, max-age=60',
      },
    },
  );
};
