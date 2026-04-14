/**
 * GET /auth/google/start?returnTo=/lab/
 * Redirect to Google OAuth consent screen.
 */

import type { Env } from '../../env';
import { createOAuthState, validateReturnTo } from '../../oauth-state';

export const onRequestGet: PagesFunction<Env> = async (context) => {
  const { env, request } = context;
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
    return new Response('Google OAuth not configured', { status: 500 });
  }

  const url = new URL(request.url);
  const returnTo = validateReturnTo(url.searchParams.get('returnTo'));
  const state = await createOAuthState(env, 'google', returnTo);

  const callbackUrl = new URL('/auth/google/callback', request.url).toString();
  const params = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: callbackUrl,
    response_type: 'code',
    scope: 'openid email profile',
    state,
  });

  return Response.redirect(
    `https://accounts.google.com/o/oauth2/v2/auth?${params}`,
    302,
  );
};
