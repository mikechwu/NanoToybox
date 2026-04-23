/**
 * DELETE /api/account/capsules/:code — owner self-service delete.
 *
 * 404 contract: a non-existent code AND an existing code owned by a
 * different user both return 404. Returning 403 for "wrong owner" would
 * leak existence information — any share code owned by anyone becomes
 * distinguishable from a random one.
 *
 * Wraps the shared delete core (`src/share/capsule-delete.ts`) with
 * actor='owner'; audit event_type='owner_delete'. Idempotent: a second
 * call against an already-tombstoned row returns 200 with
 * alreadyDeleted=true and emits a retry audit event.
 */

import type { Env } from '../../../../env';
import { authenticateRequest } from '../../../../auth-middleware';
import { normalizeShareInput } from '../../../../../src/share/share-code';
import { deleteCapsule } from '../../../../../src/share/capsule-delete';

interface OwnerCheckRow {
  owner_user_id: string | null;
}

export const onRequestDelete: PagesFunction<Env> = async (context) => {
  const { request, env } = context;

  const userId = await authenticateRequest(request, env);
  if (!userId) {
    return new Response('Unauthorized', { status: 401 });
  }

  const rawCode = context.params.code;
  if (typeof rawCode !== 'string') {
    return new Response('Not found', { status: 404 });
  }
  const code = normalizeShareInput(rawCode);
  if (!code) {
    return new Response('Not found', { status: 404 });
  }

  // Ownership check — a row owned by someone else (or a guest row with
  // no owner at all) is indistinguishable from a non-existent code at
  // the HTTP layer. `share_mode = 'account'` is explicit belt-and-braces
  // over the `owner_user_id IS NOT NULL` that the CHECK constraint
  // already guarantees for account rows; a guest row with NULL owner
  // cannot be reached this way even by a user forging their own id.
  const owned = await env.DB.prepare(
    "SELECT owner_user_id FROM capsule_share WHERE share_code = ? AND share_mode = 'account'",
  )
    .bind(code)
    .first<OwnerCheckRow>();
  if (!owned || owned.owner_user_id !== userId) {
    return new Response('Not found', { status: 404 });
  }

  const result = await deleteCapsule(env, code, {
    actor: 'owner',
    userId,
    userAgent: request.headers.get('User-Agent') ?? undefined,
  });
  if (!result) {
    // Race: the row disappeared between ownership check and delete.
    return new Response('Not found', { status: 404 });
  }

  return Response.json({
    shareCode: result.shareCode,
    status: 'deleted',
    alreadyDeleted: result.alreadyDeleted,
    r2Deleted: result.r2Deleted,
    ...(result.r2Error ? { r2Error: result.r2Error } : {}),
  });
};
