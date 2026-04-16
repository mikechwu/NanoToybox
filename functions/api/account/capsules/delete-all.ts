/**
 * POST /api/account/capsules/delete-all — bulk delete for the signed-in user.
 *
 * Invokes the shared delete core once per owned, non-deleted capsule.
 * Best-effort: partial failures are reported in the response body and
 * recorded as audit rows (the shared core emits per-capsule audits).
 *
 * Returns: { totalAttempted, succeeded, failed: [{code, reason}] }.
 */

import type { Env } from '../../../env';
import { authenticateRequest } from '../../../auth-middleware';
import { deleteCapsule } from '../../../../src/share/capsule-delete';

interface CapsuleCodeRow {
  share_code: string;
}

export const onRequestPost: PagesFunction<Env> = async (context) => {
  const { request, env } = context;

  const userId = await authenticateRequest(request, env);
  if (!userId) {
    return new Response('Unauthorized', { status: 401 });
  }

  const userAgent = request.headers.get('User-Agent') ?? undefined;

  // LIMIT 200: each iteration is ~4 D1 round-trips + 1 R2 delete + an
  // audit insert. Cloudflare Workers' per-request CPU + subrequest
  // budgets cap us well before "every capsule a power-user could ever
  // accumulate". Returning the cap-hit signal lets the client batch.
  const BATCH_LIMIT = 200;
  const rows = await env.DB.prepare(
    `SELECT share_code FROM capsule_share
       WHERE owner_user_id = ? AND status != 'deleted'
       ORDER BY created_at ASC
       LIMIT ?`,
  )
    .bind(userId, BATCH_LIMIT)
    .all<CapsuleCodeRow>();

  const totalAttempted = rows.results.length;
  let succeeded = 0;
  const failed: Array<{ code: string; reason: string }> = [];

  for (const row of rows.results) {
    try {
      const result = await deleteCapsule(env, row.share_code, {
        actor: 'owner',
        userId,
        userAgent,
        reason: 'account_delete_all',
      });
      if (!result) {
        failed.push({ code: row.share_code, reason: 'missing' });
      } else if (!result.r2Deleted) {
        console.error(
          `[account.delete-all] share=${row.share_code} r2_error="${result.r2Error ?? 'unknown'}"`,
        );
        failed.push({ code: row.share_code, reason: 'r2_failed' });
      } else {
        succeeded++;
      }
    } catch (err) {
      // Log full error for ops; return only a coarse code to the
      // client to avoid leaking raw D1/SQLite constraint text.
      const raw = err instanceof Error ? err.message : String(err);
      console.error(
        `[account.delete-all] share=${row.share_code} error="${raw}"`,
      );
      failed.push({ code: row.share_code, reason: 'delete_failed' });
    }
  }

  if (failed.length > 0) {
    console.error(
      `[account.delete-all-partial] user=${userId} total=${totalAttempted} ok=${succeeded} failed=${failed.length}`,
    );
  }

  // Surface the cap-hit signal so the client can issue a follow-up POST
  // when the user has more than BATCH_LIMIT capsules. A simple flag is
  // enough; the next call's SELECT will pick up the remainder.
  const moreAvailable = totalAttempted === BATCH_LIMIT;
  return Response.json({ totalAttempted, succeeded, failed, moreAvailable });
};
