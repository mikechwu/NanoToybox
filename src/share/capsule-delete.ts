/**
 * Shared capsule-delete core.
 *
 * Single source of truth for what "delete a capsule" means. Wrapped by:
 *   - admin moderation: `POST /api/admin/capsules/:code/delete`
 *     (actor='admin', audit event_type='moderation_delete')
 *   - owner self-service: `DELETE /api/account/capsules/:code`
 *     (actor='owner', audit event_type='owner_delete')
 *   - account-wide cascade: `POST /api/account/delete`
 *     (actor='owner', reason='account_delete_cascade')
 *
 * Ordering contract (identical across all callers):
 *   1. Flip `capsule_share.status` to 'deleted' (public endpoints start
 *      returning 404 immediately via `isAccessibleStatus`).
 *   2. NULL content-identifying columns (sha256, preview_poster_key,
 *      preview_motion_key).
 *   3. Delete the R2 blob.
 *   4. On R2 success, NULL `object_key` so no future reference points at
 *      a missing blob; on R2 failure, leave `object_key` so a retry can
 *      still find the key.
 *   5. Emit the audit event. Severity escalates to 'critical' on R2
 *      failure so ops dashboards surface the orphan.
 *
 * Idempotency: a repeat call against an already-deleted row re-runs
 * steps 3–5 (the R2 delete is server-side idempotent, and retry audit
 * events let operators distinguish clean delete from retry-cleanup).
 */

import type { D1Database } from './d1-types';
import { recordAuditEvent, type AuditEventType } from './audit';

/** Cloudflare R2 binding subset used by this module. */
export interface R2BucketLike {
  delete(key: string): Promise<void>;
}

/** Minimal environment shape this module reads. */
export interface CapsuleDeleteEnv {
  DB: D1Database;
  R2_BUCKET: R2BucketLike;
}

export interface DeleteCapsuleOptions {
  actor: 'admin' | 'owner';
  /** Opaque user id string emitted as the audit `actor` when owner-initiated. */
  userId?: string;
  /** Free-form moderation / cascade reason; truncated inside audit helpers. */
  reason?: string;
  /** Optional User-Agent string to record on the audit event. */
  userAgent?: string;
  /** Optional audit `details` overrides. Merged shallowly with the
   *  defaults computed from delete outcome. */
  extraDetails?: Record<string, unknown>;
}

export interface DeleteCapsuleResult {
  shareId: string;
  shareCode: string;
  alreadyDeleted: boolean;
  r2Deleted: boolean;
  r2Error?: string;
}

interface ShareRowForDelete {
  id: string;
  share_code: string;
  status: string;
  object_key: string | null;
}

/**
 * Delete a capsule by share code. Returns null when no row exists for
 * the code (caller should 404). Returns a result object otherwise, with
 * `r2Deleted=false` + `r2Error` populated when the blob cleanup failed
 * (the D1 row is still flipped — the public link is already dead).
 */
export async function deleteCapsule(
  env: CapsuleDeleteEnv,
  code: string,
  opts: DeleteCapsuleOptions,
): Promise<DeleteCapsuleResult | null> {
  const row = await env.DB.prepare(
    `SELECT id, share_code, status, object_key
       FROM capsule_share
      WHERE share_code = ?`,
  )
    .bind(code)
    .first<ShareRowForDelete>();
  if (!row) return null;

  const alreadyDeleted = row.status === 'deleted';

  // Step 1+2: flip status and NULL content-identifying fields in one
  // statement. Idempotent — a retry against an already-deleted row
  // still NULLs any lingering fields. rejection_reason captures the
  // actor-supplied reason so the audit path and the row both agree.
  if (!alreadyDeleted) {
    await env.DB.prepare(
      `UPDATE capsule_share
          SET status             = 'deleted',
              rejection_reason   = ?,
              sha256             = NULL,
              preview_poster_key = NULL,
              preview_motion_key = NULL
        WHERE id = ?`,
    )
      .bind(opts.reason ?? null, row.id)
      .run();
  } else {
    // Second-time path — still scrub content fields defensively (in
    // case an older tombstone didn't NULL them).
    await env.DB.prepare(
      `UPDATE capsule_share
          SET sha256             = NULL,
              preview_poster_key = NULL,
              preview_motion_key = NULL
        WHERE id = ?`,
    )
      .bind(row.id)
      .run();
  }

  // Step 3: R2 delete. R2 is idempotent server-side — no-op for missing
  // keys — so the retry path is cheap.
  let r2Deleted = true;
  let r2Error: string | undefined;
  if (row.object_key) {
    try {
      await env.R2_BUCKET.delete(row.object_key);
    } catch (err) {
      r2Deleted = false;
      r2Error = err instanceof Error ? err.message : String(err);
      console.error(
        `[capsule-delete] R2 blob removal failed for key=${row.object_key} actor=${opts.actor}: ${r2Error}`,
      );
    }
  }

  // Step 4: clear object_key ONLY if R2 confirmed delete. If R2
  // failed, keep object_key so a subsequent retry can find the blob.
  // NULL (not '') so any future `object_key IS NOT NULL` filter in the
  // sweeper or admin queries treats this row as "blob already gone".
  if (r2Deleted && row.object_key) {
    await env.DB.prepare(
      `UPDATE capsule_share SET object_key = NULL WHERE id = ?`,
    )
      .bind(row.id)
      .run();
  }

  // Step 5: audit. Severity escalates on R2 failure.
  const eventType: AuditEventType =
    opts.actor === 'admin' ? 'moderation_delete' : 'owner_delete';
  const auditActor = opts.actor === 'admin' ? 'admin' : (opts.userId ?? 'owner');

  await recordAuditEvent(env.DB, {
    shareId: row.id,
    shareCode: row.share_code,
    eventType,
    actor: auditActor,
    severity: r2Deleted ? (alreadyDeleted ? 'info' : 'warning') : 'critical',
    reason: opts.reason,
    userAgent: opts.userAgent,
    details: {
      alreadyDeleted,
      r2Deleted,
      ...(r2Error ? { r2Error } : {}),
      ...(opts.extraDetails ?? {}),
    },
  });

  return {
    shareId: row.id,
    shareCode: row.share_code,
    alreadyDeleted,
    r2Deleted,
    ...(r2Error ? { r2Error } : {}),
  };
}
