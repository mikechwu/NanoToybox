/**
 * POST /api/admin/sweep/guest-expires — tombstone expired guest shares.
 *
 * Runs on a cron schedule through the companion atomdojo-cron-sweeper
 * Worker. Rows with `share_mode='guest'` and `expires_at <= now()` that
 * haven't already been tombstoned are routed through the shared delete
 * core (actor='cron') so blob cleanup, audit emission, and ordering
 * semantics match every other delete path.
 *
 * Safety rails:
 *   - Admin gate (CRON_SECRET in prod, DEV_ADMIN_ENABLED + localhost
 *     in dev) — identical to the other sweeps.
 *   - Guest-publish-flag off → still runs normally. With the flag off
 *     no new guest rows are created, so this sweep either cleans up
 *     the pre-disable tail (desired) or no-ops (desired). MUST NOT 404
 *     on the flag — a 404 would turn a benign "nothing to do" state
 *     into a Cron-sweeper retry storm (§Feature-Flag Helper §Single
 *     authoritative gate policy).
 *   - Per-call deletion cap + scan cap so a pathological backlog can't
 *     blow the 30 s request wall.
 */

import type { Env } from '../../../env';
import { requireAdminOr404 } from '../../../admin-gate';
import { deleteCapsule } from '../../../../src/share/capsule-delete';

const DEFAULT_MAX_DELETE = 200;
const SCAN_LIMIT = 1000;

interface ExpiredRow {
  share_code: string;
  id: string;
  expires_at: string | null;
}

export const onRequestPost: PagesFunction<Env> = async (context) => {
  const { request, env } = context;

  const denied = requireAdminOr404(request, env);
  if (denied) return denied;

  const url = new URL(request.url);
  const maxDelete = Math.max(
    1,
    Math.min(
      SCAN_LIMIT,
      parseInt(url.searchParams.get('max') ?? String(DEFAULT_MAX_DELETE), 10)
        || DEFAULT_MAX_DELETE,
    ),
  );

  const nowIso = new Date().toISOString();

  // Partial index `idx_capsule_guest_expires` makes this cheap even at
  // large row counts — it only covers guest rows that haven't been
  // tombstoned yet, which is exactly what we're scanning.
  const rows = await env.DB.prepare(
    `SELECT share_code, id, expires_at
       FROM capsule_share
      WHERE share_mode = 'guest'
        AND status != 'deleted'
        AND expires_at IS NOT NULL
        AND expires_at <= ?
      ORDER BY expires_at ASC
      LIMIT ?`,
  )
    .bind(nowIso, maxDelete)
    .all<ExpiredRow>();

  const scanned = rows.results.length;
  let deleted = 0;
  const failedDetails: Array<{ shareCode: string; reason: string }> = [];

  for (const row of rows.results) {
    try {
      const result = await deleteCapsule(env, row.share_code, {
        actor: 'cron',
        userId: null,
        reason: 'guest_expired',
        extraDetails: { expiresAt: row.expires_at ?? null },
      });
      if (result && result.r2Deleted) {
        deleted++;
      } else if (result) {
        // R2 cleanup failed but the D1 row is tombstoned — delete-core
        // already emitted a critical audit event. Surface in the
        // summary so the operator knows the scan had partial failures.
        failedDetails.push({
          shareCode: row.share_code,
          reason: result.r2Error ?? 'r2_delete_failed',
        });
      } else {
        failedDetails.push({
          shareCode: row.share_code,
          reason: 'row_missing_at_delete',
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(
        `[sweep/guest-expires] delete failed for share=${row.share_code}: ${message}`,
      );
      failedDetails.push({ shareCode: row.share_code, reason: message.slice(0, 200) });
    }
  }

  return Response.json({
    ok: true,
    scanned,
    deleted,
    failed: failedDetails.length,
    failedDetails: failedDetails.slice(0, 50),
  });
};
