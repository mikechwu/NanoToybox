/**
 * POST /api/capsules/:code/report — abuse report (unauthenticated).
 * Phase 5 will add storage and moderation workflow.
 * For now, log and acknowledge.
 */

import type { Env } from '../../../env';
import { normalizeShareInput } from '../../../../src/share/share-code';
import { isAccessibleStatus } from '../../../../src/share/share-record';
import type { ShareRecordStatus } from '../../../../src/share/share-record';

export const onRequestPost: PagesFunction<Env> = async (context) => {
  const rawCode = context.params.code;
  if (typeof rawCode !== 'string') {
    return new Response('Not found', { status: 404 });
  }

  const code = normalizeShareInput(rawCode);
  if (!code) {
    return new Response('Not found', { status: 404 });
  }

  // Same accessibility check as metadata/blob — deleted/rejected return 404
  const row = await context.env.DB.prepare(
    'SELECT id, status FROM capsule_share WHERE share_code = ?',
  )
    .bind(code)
    .first<{ id: string; status: ShareRecordStatus }>();

  if (!row || !isAccessibleStatus(row.status)) {
    return new Response('Not found', { status: 404 });
  }

  // Phase 5: persist report to capsule_share_audit table
  // For now, acknowledge receipt
  console.log(`Abuse report received for capsule ${code} (id: ${row.id})`);

  return Response.json({ received: true });
};
