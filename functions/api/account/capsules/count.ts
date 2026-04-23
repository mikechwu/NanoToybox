/**
 * GET /api/account/capsules/count — cheap count of the signed-in
 * user's owned, non-deleted account-mode capsules.
 *
 * Exists so the Transfer dialog's signed-in Share panel can surface
 * "N capsules published" without fetching the full paginated list.
 * The main list endpoint (`index.ts`) returns a cursored page and
 * has no `total` field; adding one there would require either a
 * second aggregate pass or a trigger-maintained counter. A
 * dedicated endpoint is simpler and the query is O(index-range).
 *
 * Filters mirror the list endpoint for consistency:
 *   - owner_user_id = <current user>
 *   - share_mode = 'account'  (hides guest rows; mandatory per plan)
 *   - status != 'deleted'
 *
 * Returns: `{ count: number }`. No cache (count mutates on publish +
 * delete). Auth-gated; 401 for signed-out callers.
 */

import type { Env } from '../../../env';
import { authenticateRequest } from '../../../auth-middleware';

export const onRequestGet: PagesFunction<Env> = async (context) => {
  const { request, env } = context;

  const userId = await authenticateRequest(request, env);
  if (!userId) {
    return new Response('Unauthorized', { status: 401 });
  }

  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS count
       FROM capsule_share
      WHERE owner_user_id = ?
        AND share_mode = 'account'
        AND status != 'deleted'`,
  )
    .bind(userId)
    .first<{ count: number }>();

  const count = row?.count ?? 0;

  return Response.json(
    { count },
    {
      headers: {
        'Cache-Control': 'no-store, private',
        Vary: 'Cookie',
      },
    },
  );
};
