/**
 * GET /auth/github/callback
 * Exchange authorization code for tokens, create/find user, set session cookie.
 */

import type { Env } from '../../env';
import { verifyOAuthState } from '../../oauth-state';
import { createSessionAndRedirect } from '../../oauth-helpers';
import {
  findOrCreateUserWithPolicyAcceptance,
  redirectToAuthError,
  POLICY_VERSION,
} from '../../policy-acceptance';

export const onRequestGet: PagesFunction<Env> = async (context) => {
  const { env, request } = context;
  const url = new URL(request.url);

  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  if (!code || !state) {
    return new Response('Missing code or state', { status: 400 });
  }

  let statePayload;
  try {
    statePayload = await verifyOAuthState(env, state, 'github');
  } catch {
    return new Response('Invalid or expired state', { status: 400 });
  }

  // Exchange code for access token
  const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      client_id: env.GITHUB_CLIENT_ID,
      client_secret: env.GITHUB_CLIENT_SECRET,
      code,
      redirect_uri: new URL('/auth/github/callback', request.url).toString(),
    }),
  });

  if (!tokenRes.ok) {
    return new Response('Token exchange failed', { status: 500 });
  }

  const tokens = (await tokenRes.json()) as { access_token: string; error?: string };
  if (tokens.error) {
    return new Response(`OAuth error: ${tokens.error}`, { status: 400 });
  }

  // Fetch user info
  const userInfoRes = await fetch('https://api.github.com/user', {
    headers: {
      Authorization: `Bearer ${tokens.access_token}`,
      'User-Agent': 'AtomDojo',
    },
  });

  if (!userInfoRes.ok) {
    return new Response('Failed to fetch user info', { status: 500 });
  }

  const userInfo = (await userInfoRes.json()) as {
    id: number;
    login: string;
    name?: string | null;
    email?: string | null;
  };

  // See google/callback.ts for the full rationale on the new helper +
  // failure-path redirect.
  let result;
  try {
    result = await findOrCreateUserWithPolicyAcceptance(
      env.DB,
      {
        provider: 'github',
        providerAccountId: String(userInfo.id),
        email: userInfo.email ?? null,
        emailVerified: false, // GitHub email verification requires separate API call
        displayName: userInfo.name ?? userInfo.login,
      },
      {
        age13PlusConfirmed: statePayload.age13PlusConfirmed === true,
        policyVersion: statePayload.agePolicyVersion ?? POLICY_VERSION,
      },
    );
  } catch (err) {
    console.error('[auth.github.callback] policy acceptance failed:', err);
    return redirectToAuthError(request, 'github', 'acceptance_failed');
  }

  return createSessionAndRedirect(
    env.DB,
    result.userId,
    statePayload.returnTo,
    request,
  );
};
