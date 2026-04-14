/**
 * POST /api/admin/sweep/sessions — delete expired sessions + prune
 * stale publish-quota window rows.
 *
 * Sessions expire on two axes:
 *   - absolute: expires_at < now (set at login, fixed 30-day lifetime)
 *   - idle:     last_seen_at + 30 days < now
 *
 * Either axis makes the row unusable, so both are deleted. Quota window
 * rows older than the active window are also pruned to keep the table
 * lean — this is cheap O(log N) with the existing index.
 *
 * Protection: admin-gated, same as other sweeps.
 */

import type { Env } from '../../../env';
import { requireAdminOr404 } from '../../../admin-gate';
import { pruneExpiredQuotaBuckets } from '../../../../src/share/rate-limit';
import { recordAuditEvent } from '../../../../src/share/audit';

const IDLE_EXPIRY_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export const onRequestPost: PagesFunction<Env> = async (context) => {
  const { request, env } = context;

  const denied = requireAdminOr404(request, env);
  if (denied) return denied;

  const now = new Date();
  const nowIso = now.toISOString();
  const idleCutoff = new Date(now.getTime() - IDLE_EXPIRY_MS).toISOString();

  // Delete sessions that are absolute-expired OR idle-expired.
  const sessionResult = await env.DB.prepare(
    `DELETE FROM sessions WHERE expires_at < ? OR last_seen_at < ?`,
  )
    .bind(nowIso, idleCutoff)
    .run();

  // Prune quota buckets older than the active window.
  await pruneExpiredQuotaBuckets(env.DB, undefined, now);

  // D1 Result doesn't expose rows-affected in our minimal shim, so report
  // a best-effort audit without a precise count. The audit is a signal
  // that the sweeper ran, not a reconciliation point.
  await recordAuditEvent(env.DB, {
    eventType: 'session_swept',
    actor: 'sweeper',
    severity: 'info',
    reason: 'expired sessions + quota buckets pruned',
  });

  return Response.json({
    ok: true,
    ranAt: nowIso,
    // sessionResult.meta isn't in our shim; include the raw result for
    // debugging. Shape is runtime-dependent, so cast.
    sessionDeleteMeta: (sessionResult as unknown as { meta?: unknown }).meta ?? null,
  });
};
