/**
 * POST /api/auth/logout — clear session cookie and delete session row.
 */

import type { Env } from '../../env';
import { authenticateRequest, clearSessionCookie } from '../../auth-middleware';

export const onRequestPost: PagesFunction<Env> = async (context) => {
  const userId = await authenticateRequest(context.request, context.env);

  // Even if not authenticated, clear the cookie
  const headers = new Headers();
  clearSessionCookie(headers, context.request);

  if (userId) {
    // Delete all sessions for this user (logout everywhere)
    await context.env.DB.prepare('DELETE FROM sessions WHERE user_id = ?')
      .bind(userId)
      .run();
  }

  return new Response('Logged out', { status: 200, headers });
};
