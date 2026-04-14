/**
 * GET /auth/github/start?returnTo=/lab/
 * Redirect to GitHub OAuth consent screen.
 */

import type { Env } from '../../env';
import { createOAuthState, validateReturnTo } from '../../oauth-state';

export const onRequestGet: PagesFunction<Env> = async (context) => {
  const { env, request } = context;
  if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) {
    return new Response('GitHub OAuth not configured', { status: 500 });
  }

  const url = new URL(request.url);
  const returnTo = validateReturnTo(url.searchParams.get('returnTo'));
  const state = await createOAuthState(env, 'github', returnTo);

  const params = new URLSearchParams({
    client_id: env.GITHUB_CLIENT_ID,
    redirect_uri: new URL('/auth/github/callback', request.url).toString(),
    scope: 'read:user user:email',
    state,
  });

  return Response.redirect(
    `https://github.com/login/oauth/authorize?${params}`,
    302,
  );
};
