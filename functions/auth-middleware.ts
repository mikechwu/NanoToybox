/**
 * Session cookie auth middleware for Pages Functions.
 *
 * Decision tree:
 * 1. Dev bypass: AUTH_DEV_USER_ID + localhost → skip cookie, use fixed user ID
 * 2. HTTPS: __Host-atomdojo_session cookie → D1 session lookup
 * 3. Plain HTTP localhost: atomdojo_session_dev cookie → D1 session lookup
 *
 * Attaches userId to context.data for downstream Functions.
 */

import type { Env } from './env';

const COOKIE_PROD = '__Host-atomdojo_session';
const COOKIE_DEV = 'atomdojo_session_dev';
const IDLE_EXPIRY_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const LAST_SEEN_THROTTLE_MS = 5 * 60 * 1000; // 5 minutes

function isLocalRequest(request: Request): boolean {
  const url = new URL(request.url);
  return url.hostname === 'localhost' || url.hostname === '127.0.0.1';
}

function isDevBypassEnabled(env: Env): boolean {
  return typeof env.AUTH_DEV_USER_ID === 'string' && env.AUTH_DEV_USER_ID.length > 0;
}

function isSecureRequest(request: Request): boolean {
  const url = new URL(request.url);
  return url.protocol === 'https:';
}

function getCookieName(request: Request): string {
  return isSecureRequest(request) ? COOKIE_PROD : COOKIE_DEV;
}

function parseCookie(header: string, name: string): string | null {
  const match = header.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  return match ? match[1] : null;
}

export function setSessionCookie(
  headers: Headers,
  sessionId: string,
  request: Request,
): void {
  const secure = isSecureRequest(request);
  const name = secure ? COOKIE_PROD : COOKIE_DEV;
  const flags = [
    `${name}=${sessionId}`,
    'HttpOnly',
    'SameSite=Lax',
    'Path=/',
    'Max-Age=2592000',
  ];
  if (secure) flags.push('Secure');
  headers.append('Set-Cookie', flags.join('; '));
}

export function clearSessionCookie(headers: Headers, request: Request): void {
  const secure = isSecureRequest(request);
  const name = secure ? COOKIE_PROD : COOKIE_DEV;
  const flags = [`${name}=`, 'HttpOnly', 'SameSite=Lax', 'Path=/', 'Max-Age=0'];
  if (secure) flags.push('Secure');
  headers.append('Set-Cookie', flags.join('; '));
}

/**
 * Authenticate a request and return the user ID.
 * Returns null if the request is not authenticated.
 */
export async function authenticateRequest(
  request: Request,
  env: Env,
): Promise<string | null> {
  // Dev bypass: skip cookie entirely
  if (isDevBypassEnabled(env) && isLocalRequest(request)) {
    return env.AUTH_DEV_USER_ID!;
  }

  // Read session cookie
  const cookieHeader = request.headers.get('Cookie');
  if (!cookieHeader) return null;

  const cookieName = getCookieName(request);
  const sessionId = parseCookie(cookieHeader, cookieName);
  if (!sessionId) return null;

  // Look up session in D1
  const row = await env.DB.prepare(
    'SELECT user_id, expires_at, last_seen_at FROM sessions WHERE id = ?',
  )
    .bind(sessionId)
    .first<{ user_id: string; expires_at: string; last_seen_at: string }>();

  if (!row) return null;

  // Check expiration
  const now = Date.now();
  if (new Date(row.expires_at).getTime() < now) return null;

  // Check idle expiration (30 days since last activity)
  if (now - new Date(row.last_seen_at).getTime() > IDLE_EXPIRY_MS) return null;

  // Throttled last_seen_at update (fire-and-forget — must not block auth)
  if (now - new Date(row.last_seen_at).getTime() > LAST_SEEN_THROTTLE_MS) {
    env.DB.prepare('UPDATE sessions SET last_seen_at = ? WHERE id = ?')
      .bind(new Date().toISOString(), sessionId)
      .run()
      .catch((err) => {
        console.error(`[auth] last_seen_at update failed: ${err instanceof Error ? err.message : String(err)}`);
      });
  }

  return row.user_id;
}

/**
 * Middleware that requires authentication.
 * Attach to Functions that need a logged-in user.
 */
export async function requireAuth(
  context: EventContext<Env, string, Record<string, unknown>>,
): Promise<Response | null> {
  const userId = await authenticateRequest(context.request, context.env);
  if (!userId) {
    return new Response('Unauthorized', { status: 401 });
  }
  context.data.userId = userId;
  return null;
}
