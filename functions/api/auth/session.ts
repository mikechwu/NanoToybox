/**
 * GET /api/auth/session — return current user info or 401.
 */

import type { Env } from '../../env';
import { authenticateRequest } from '../../auth-middleware';

export const onRequestGet: PagesFunction<Env> = async (context) => {
  const userId = await authenticateRequest(context.request, context.env);
  if (!userId) {
    return new Response('Unauthorized', { status: 401 });
  }

  const user = await context.env.DB.prepare(
    'SELECT id, display_name, created_at FROM users WHERE id = ?',
  )
    .bind(userId)
    .first<{ id: string; display_name: string | null; created_at: string }>();

  if (!user) {
    return new Response('User not found', { status: 401 });
  }

  return Response.json({
    userId: user.id,
    displayName: user.display_name,
    createdAt: user.created_at,
  });
};
