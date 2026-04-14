/**
 * POST /api/admin/capsules/:code/delete — admin moderation delete.
 *
 * Thin wrapper around the shared delete core (`src/share/capsule-delete.ts`).
 * Emits audit `event_type='moderation_delete'`; severity escalates to
 * 'critical' if the R2 cleanup fails.
 *
 * Idempotent: safe to retry. A second call against an already-tombstoned
 * row still re-attempts the R2 delete (the blob might have survived a
 * prior failure).
 */

import type { Env } from '../../../../env';
import { requireAdminOr404 } from '../../../../admin-gate';
import { normalizeShareInput } from '../../../../../src/share/share-code';
import { deleteCapsule } from '../../../../../src/share/capsule-delete';

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
      if (parsed && typeof parsed.reason === 'string') {
        reason = parsed.reason;
      }
    }
  } catch {
    // Malformed JSON body — acceptable on an admin endpoint; keep going.
  }

  const result = await deleteCapsule(env, code, {
    actor: 'admin',
    reason,
    userAgent: request.headers.get('User-Agent') ?? undefined,
  });

  if (!result) {
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
