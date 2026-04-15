/**
 * GET /auth/google/callback
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

  // Acceptance recording is fused into user creation. For NEW accounts
  // the helper writes users + oauth_accounts + user_policy_acceptance
  // in a single db.batch — there is no observable interleaving where
  // account-linked rows exist without an acceptance row. For EXISTING
  // accounts the helper UPSERTs the acceptance row before we set the
  // session cookie. See plan §2 backend "Acceptance invariant — precise
  // wording" for the three-part guarantee.
  let result;
  try {
    result = await findOrCreateUserWithPolicyAcceptance(
      env.DB,
      {
        provider: 'google',
        providerAccountId: userInfo.id,
        email: userInfo.email ?? null,
        emailVerified: userInfo.verified_email ?? false,
        displayName: userInfo.name ?? null,
      },
      {
        age13PlusConfirmed: statePayload.age13PlusConfirmed === true,
        policyVersion: statePayload.agePolicyVersion ?? POLICY_VERSION,
      },
    );
  } catch (err) {
    // Includes MissingAge13PlusError (brand-new account + legacy state)
    // and any DB / batch error. In both cases we MUST NOT create a
    // session cookie — bail to /auth/error so the user can retry with
    // fresh post-deploy state. The helper guarantees no users /
    // oauth_accounts rows exist on the MissingAge13PlusError path; D1
    // batches are atomic so DB errors leave nothing partially committed.
    console.error('[auth.google.callback] policy acceptance failed:', err);
    return redirectToAuthError(request, 'google', 'acceptance_failed');
  }

  return createSessionAndRedirect(
    env.DB,
    result.userId,
    statePayload.returnTo,
    request,
  );
};
