/**
 * GET /auth/github/start?returnTo=/lab/&ageIntent=<nonce>
 * Redirect to GitHub OAuth consent screen.
 *
 * 13+ age-gate enforcement — see `functions/auth/google/start.ts` for
 * the full rationale; the contract here is identical.
 */

import type { Env } from '../../env';
import { createOAuthState, validateReturnTo } from '../../oauth-state';
import { authenticateRequest } from '../../auth-middleware';
import { verifyAgeIntent, SignedIntentError } from '../../signed-intents';

export const onRequestGet: PagesFunction<Env> = async (context) => {
  const { env, request } = context;
  if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) {
    return new Response('GitHub OAuth not configured', { status: 500 });
  }

  const url = new URL(request.url);
  const ageIntent = url.searchParams.get('ageIntent');

  const existingUserId = await authenticateRequest(request, env);
  if (!existingUserId) {
    try {
      if (!ageIntent) {
        return new Response(
          'Missing age_13_plus confirmation. Please start sign-in from the product UI.',
          { status: 400 },
        );
      }
      await verifyAgeIntent(env, ageIntent);
    } catch (err) {
      const code = err instanceof SignedIntentError ? err.code : 'invalid';
      return new Response(`Invalid age confirmation nonce: ${code}`, {
        status: 400,
      });
    }
  }

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
