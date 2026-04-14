/**
 * POST /api/admin/capsules/:code/delete — admin moderation delete.
 *
 * Marks the share record as 'deleted' (public endpoints now return 404)
 * and removes the R2 blob. The audit event is recorded with the reason
 * supplied in the request body, if any.
 *
 * Idempotency: safe to retry. If the record is already status=deleted
 * but the R2 blob is still present (because a prior attempt failed),
 * a retry will attempt the R2 delete again. The audit details record
 * whether the blob was actually removed on this invocation so operators
 * can distinguish "clean delete" from "partial delete".
 *
 * Protection: admin-gated (DEV_ADMIN_ENABLED + localhost OR CRON_SECRET).
 */

import type { Env } from '../../../../env';
import { requireAdminOr404 } from '../../../../admin-gate';
import { normalizeShareInput } from '../../../../../src/share/share-code';
import { recordAuditEvent } from '../../../../../src/share/audit';

interface ShareRowForDelete {
  id: string;
  status: string;
  object_key: string;
}

export const onRequestPost: PagesFunction<Env> = async (context) => {
  const { request, env } = context;

  const denied = requireAdminOr404(request, env);
  if (denied) return denied;

  const rawCode = context.params.code;
  if (typeof rawCode !== 'string') {
    return new Response('Not found', { status: 404 });
  }
  const code = normalizeShareInput(rawCode);
  if (!code) {
    return new Response('Not found', { status: 404 });
  }

  // Parse optional { reason } body.
  let reason: string | undefined;
  try {
    const text = await request.text();
    if (text.length > 0) {
      const parsed = JSON.parse(text);
      // Truncation is enforced inside recordAuditEvent — pass through raw.
      if (parsed && typeof parsed.reason === 'string') {
        reason = parsed.reason;
      }
    }
  } catch {
    // Malformed JSON body — acceptable on an admin endpoint; keep going.
  }

  const row = await env.DB.prepare(
    'SELECT id, status, object_key FROM capsule_share WHERE share_code = ?',
  )
    .bind(code)
    .first<ShareRowForDelete>();

  if (!row) {
    return new Response('Not found', { status: 404 });
  }

  const alreadyDeleted = row.status === 'deleted';

  // If not yet marked deleted, flip status first — public endpoints
  // immediately stop serving the capsule even if the R2 delete below
  // fails and needs a retry.
  if (!alreadyDeleted) {
    await env.DB.prepare(
      `UPDATE capsule_share SET status = 'deleted', rejection_reason = ? WHERE id = ?`,
    )
      .bind(reason ?? null, row.id)
      .run();
  }

  // Attempt R2 cleanup on both fresh and idempotent-retry paths. R2
  // delete is idempotent server-side (no-op for a missing key), so
  // retries are cheap.
  let r2Deleted = true;
  let r2Error: string | undefined;
  await env.R2_BUCKET.delete(row.object_key).catch((err) => {
    r2Deleted = false;
    r2Error = err instanceof Error ? err.message : String(err);
    console.error(
      `[admin-delete] R2 blob removal failed for key=${row.object_key}: ${r2Error}`,
    );
  });

  // Audit both fresh and retry paths so the chain-of-custody is complete.
  // Severity escalates to 'critical' if R2 cleanup failed — so these are
  // surfaced in ops dashboards.
  await recordAuditEvent(env.DB, {
    shareId: row.id,
    shareCode: code,
    eventType: 'moderation_delete',
    actor: 'admin',
    severity: r2Deleted ? 'warning' : 'critical',
    reason,
    userAgent: request.headers.get('User-Agent') ?? undefined,
    details: {
      alreadyDeleted,
      r2Deleted,
      ...(r2Error ? { r2Error } : {}),
    },
  });

  return Response.json({
    shareCode: code,
    status: 'deleted',
    alreadyDeleted,
    r2Deleted,
    ...(r2Error ? { r2Error } : {}),
  });
};
