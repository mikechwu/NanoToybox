/**
 * GET /auth/google/callback
 * Exchange authorization code for tokens, create/find user, set session cookie.
 */

import type { Env } from '../../env';
import { verifyOAuthState } from '../../oauth-state';
import { findOrCreateUser, createSessionAndRedirect } from '../../oauth-helpers';

export const onRequestGet: PagesFunction<Env> = async (context) => {
  const { env, request } = context;
  const url = new URL(request.url);

  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  if (!code || !state) {
    return new Response('Missing code or state', { status: 400 });
  }

  // Verify state (CSRF, expiration, provider binding)
  let statePayload;
  try {
    statePayload = await verifyOAuthState(env, state, 'google');
  } catch {
    return new Response('Invalid or expired state', { status: 400 });
  }

  // Exchange code for tokens
  const callbackUrl = new URL('/auth/google/callback', request.url).toString();
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID!,
      client_secret: env.GOOGLE_CLIENT_SECRET!,
      redirect_uri: callbackUrl,
      grant_type: 'authorization_code',
    }),
  });

  if (!tokenRes.ok) {
    return new Response('Token exchange failed', { status: 500 });
  }

  const tokens = (await tokenRes.json()) as { access_token: string };

  // Fetch user info
  const userInfoRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  });

  if (!userInfoRes.ok) {
    return new Response('Failed to fetch user info', { status: 500 });
  }

  const userInfo = (await userInfoRes.json()) as {
    id: string;
    email?: string;
    verified_email?: boolean;
    name?: string;
  };

  const userId = await findOrCreateUser(env.DB, {
    provider: 'google',
    providerAccountId: userInfo.id,
    email: userInfo.email ?? null,
    emailVerified: userInfo.verified_email ?? false,
    displayName: userInfo.name ?? null,
  });

  return createSessionAndRedirect(
    env.DB,
    userId,
    statePayload.returnTo,
    request,
  );
};
