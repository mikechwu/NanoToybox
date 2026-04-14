/**
 * Shared OAuth helpers: user creation/lookup, session creation.
 */

import type { Env } from './env';
import { setSessionCookie } from './auth-middleware';

interface OAuthUserInfo {
  provider: 'google' | 'github';
  providerAccountId: string;
  email: string | null;
  emailVerified: boolean;
  displayName: string | null;
}

/**
 * Find or create a user from OAuth provider info.
 * Phase 1 policy: no automatic cross-provider linking.
 */
export async function findOrCreateUser(
  db: D1Database,
  info: OAuthUserInfo,
): Promise<string> {
  // Check for existing OAuth account
  const existing = await db
    .prepare(
      'SELECT user_id FROM oauth_accounts WHERE provider = ? AND provider_account_id = ?',
    )
    .bind(info.provider, info.providerAccountId)
    .first<{ user_id: string }>();

  if (existing) return existing.user_id;

  // Create new user + OAuth account
  const userId = crypto.randomUUID();
  const oauthId = crypto.randomUUID();
  const now = new Date().toISOString();

  await db.batch([
    db
      .prepare('INSERT INTO users (id, display_name, created_at) VALUES (?, ?, ?)')
      .bind(userId, info.displayName, now),
    db
      .prepare(
        `INSERT INTO oauth_accounts (id, user_id, provider, provider_account_id, email, email_verified)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        oauthId,
        userId,
        info.provider,
        info.providerAccountId,
        info.email,
        info.emailVerified ? 1 : 0,
      ),
  ]);

  return userId;
}

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
