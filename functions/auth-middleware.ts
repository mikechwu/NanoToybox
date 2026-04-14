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

/** Per-isolate dedupe for orphan-session DELETE attempts. Prevents a
 *  persistently-failing DELETE from hammering D1 on every request in a
 *  hot path. Entries are added before the fire-and-forget DELETE and
 *  are NOT removed on success or error — the row either stops being
 *  orphaned (DELETE worked) or persists until the LRU trim at
 *  ORPHAN_DEDUPE_LIMIT evicts it, OR until isolate churn resets the
 *  Set. The DELETE itself is idempotent (D1 no-op on missing row), so
 *  re-entry on a future request is harmless even if a stale entry
 *  blocks it within this isolate. */
const orphanDeleteDedupe = new Set<string>();
/** Hard cap on the dedupe set so adversarial cookies can't cause
 *  unbounded memory growth in a long-lived isolate. */
const ORPHAN_DEDUPE_LIMIT = 256;

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

/** True when the incoming request carries our session cookie (prod or
 *  dev variant, matching the request's protocol). Used by the session
 *  probe to decide whether to opportunistically clear a stale cookie
 *  when the resolved auth state is signed-out. */
export function hasSessionCookie(request: Request): boolean {
  const cookieHeader = request.headers.get('Cookie');
  if (!cookieHeader) return false;
  return parseCookie(cookieHeader, getCookieName(request)) !== null;
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
 *
 * Orphan-session handling: a session row whose `user_id` no longer
 * references an existing users row (user was deleted after sign-in) is
 * treated as unauthenticated AND the orphan is deleted as a side-effect
 * so subsequent calls don't repeat the join-and-reject cost. Without this
 * check, the session probe at /api/auth/session (which now verifies the
 * users row) would report signed-out while protected endpoints would
 * still accept the cookie as authorized — a real correctness gap, not
 * just a UX mismatch.
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

  // Look up session joined to users so we reject orphaned sessions in a
  // single round-trip. `user_row_id IS NULL` via LEFT JOIN signals "user
  // row is missing OR tombstoned"; we distinguish that from "session row
  // itself missing" so we only delete the orphan in the former case.
  //
  // `u.deleted_at IS NULL` lives in the JOIN ON condition (NOT the WHERE
  // clause) so a tombstoned user is absorbed by the existing orphan
  // branch rather than requiring a separate code path. See plan
  // "Account deletion — authoritative cascade order" for rationale.
  const row = await env.DB.prepare(
    `SELECT s.user_id     AS user_id,
            s.expires_at  AS expires_at,
            s.last_seen_at AS last_seen_at,
            u.id          AS user_row_id
       FROM sessions s
       LEFT JOIN users u
         ON u.id = s.user_id
        AND u.deleted_at IS NULL
      WHERE s.id = ?`,
  )
    .bind(sessionId)
    .first<{
      user_id: string;
      expires_at: string;
      last_seen_at: string;
      user_row_id: string | null;
    }>();

  if (!row) return null;

  // Orphan: session references a user that no longer exists. Delete the
  // orphan row fire-and-forget so future requests don't re-do the join
  // and so the sweeper doesn't need to find it later. Auth result: null.
  if (row.user_row_id === null) {
    if (!orphanDeleteDedupe.has(sessionId)) {
      orphanDeleteDedupe.add(sessionId);
      // Bound the dedupe set's memory — we only need to prevent hammering
      // D1 for a handful of persistently-failing orphans in a single
      // isolate. Isolate churn (new worker instance) resets it naturally.
      if (orphanDeleteDedupe.size > ORPHAN_DEDUPE_LIMIT) {
        const oldest = orphanDeleteDedupe.values().next().value;
        if (oldest !== undefined) orphanDeleteDedupe.delete(oldest);
      }
      env.DB.prepare('DELETE FROM sessions WHERE id = ?')
        .bind(sessionId)
        .run()
        .catch((err) => {
          // Tagged prefix makes this greppable in Pages logs — orphan
          // DELETE failure would otherwise be a steady-state load
          // amplifier (every subsequent request re-does the LEFT JOIN
          // and re-fires DELETE). The dedupe set keeps us to a single
          // attempt per orphan per isolate lifetime; isolate churn on
          // the Pages runtime provides natural eviction so transient
          // D1 flakes eventually retry on a fresh worker. Session id
          // prefix only — never log the full value.
          const idPrefix = sessionId.slice(0, 8);
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`[auth.orphan-delete-failed] sid=${idPrefix}… ${msg}`);
        });
    }
    return null;
  }

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
