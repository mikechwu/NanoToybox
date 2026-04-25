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
import {
  recordShareAccessIfStale,
  shouldRecordShareAccess,
} from '../../../src/share/share-access';

export const onRequestGet: PagesFunction<Env> = async (context) => {
  const rawCode = context.params.code;
  if (typeof rawCode !== 'string') {
    return new Response('Not found', { status: 404 });
  }

  const code = normalizeShareInput(rawCode);
  if (!code) {
    return new Response('Not found', { status: 404 });
  }

  // Single instant shared by accessibility check and access recording, so
  // a row cannot be "accessible at T" and "accessed at T+ε" within one
  // request (also avoids two `new Date()` calls on the hot path).
  const nowIso = new Date().toISOString();

  const row = await context.env.DB.prepare(
    'SELECT * FROM capsule_share WHERE share_code = ?',
  )
    .bind(code)
    .first<CapsuleShareRow>();

  if (!row || !isAccessibleShare(row, nowIso)) {
    return new Response('Not found', { status: 404 });
  }

  // Route-level gate: skips waitUntil BEFORE any write query is issued
  // when the SELECTed row is already fresh. This is what removes load
  // from D1 primary on repeat reads (D1 forwards every UPDATE to primary
  // regardless of meta.changes). The helper's conditional SQL remains as
  // a race-safety layer for concurrent readers that pass this gate from
  // the same snapshot. Both layers route through the same exported
  // predicate / threshold compute — see src/share/share-access.ts.
  if (shouldRecordShareAccess(row.last_accessed_at, nowIso)) {
    context.waitUntil(
      recordShareAccessIfStale(context.env.DB, row.id, nowIso).catch((err) => {
        console.error(
          `[capsule-meta] last_accessed_at update failed for ${row.id}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }),
    );
  }

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
