/**
 * GET /auth/google/start?returnTo=/lab/&ageIntent=<nonce>
 * Redirect to Google OAuth consent screen.
 *
 * 13+ age-gate enforcement (plan Phase B, "Server-authoritative enforcement"):
 * the `ageIntent` query parameter is a short-lived HMAC nonce issued by
 * `POST /api/account/age-confirmation/intent`. Missing / expired /
 * tampered → 400. Users who already have a live session cookie bypass
 * this check (they are signed in already; the publish-time precondition
 * catches them instead).
 */

import type { Env } from '../../env';
import { createOAuthState, validateReturnTo } from '../../oauth-state';
import { authenticateRequest } from '../../auth-middleware';
import { verifyAgeIntent, SignedIntentError } from '../../signed-intents';

export const onRequestGet: PagesFunction<Env> = async (context) => {
  const { env, request } = context;
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
    return new Response('Google OAuth not configured', { status: 500 });
  }

  const url = new URL(request.url);
  const ageIntent = url.searchParams.get('ageIntent');

  // Users already holding a live session cookie (e.g. clicking sign-in
  // again from AccountControl while still signed in) do not need to
  // re-prove age — they are already authenticated and the publish-time
  // 428 precondition catches them if their acceptance row is missing.
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
