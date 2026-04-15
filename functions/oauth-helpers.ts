/**
 * Shared OAuth helpers: user creation/lookup, session creation.
 */

import type { Env } from './env';
import { setSessionCookie } from './auth-middleware';

export interface OAuthUserInfo {
  provider: 'google' | 'github';
  providerAccountId: string;
  email: string | null;
  emailVerified: boolean;
  displayName: string | null;
}

// `findOrCreateUser` was removed in the age-clickwrap simplification —
// every OAuth callback now goes through
// `findOrCreateUserWithPolicyAcceptance` in `policy-acceptance.ts` so
// the user/oauth_accounts/user_policy_acceptance writes happen in one
// transactional batch (no observable interleaving where account-linked
// rows exist without the matching acceptance row).

/**
 * Create a new session and return a Response that sets the session cookie
 * and redirects to returnTo.
 */
export async function createSessionAndRedirect(
  db: D1Database,
  userId: string,
  returnTo: string,
  request: Request,
): Promise<Response> {
  const sessionId = crypto.randomUUID();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000); // 30 days

  await db
    .prepare(
      'INSERT INTO sessions (id, user_id, expires_at, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?)',
    )
    .bind(
      sessionId,
      userId,
      expiresAt.toISOString(),
      now.toISOString(),
      now.toISOString(),
    )
    .run();

  const headers = new Headers({ Location: returnTo });
  setSessionCookie(headers, sessionId, request);
  return new Response(null, { status: 302, headers });
}
