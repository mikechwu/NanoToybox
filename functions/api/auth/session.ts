/**
 * GET /api/auth/session — session-state discovery endpoint.
 *
 * Always returns 200 with a status discriminator:
 *   - signed in:  { status: 'signed-in',  userId, displayName, createdAt }
 *   - signed out: { status: 'signed-out' }
 *
 * Rationale: this endpoint is a state-discovery probe, not a protected
 * action. Returning 401 for signed-out users made every Lab page load
 * emit a red network entry in devtools for a normal state. 401 is
 * reserved for protected-action endpoints (e.g. /api/capsules/publish)
 * where it genuinely indicates "the caller is not authorized to perform
 * this action" and the client is expected to flip UI to an auth prompt.
 *
 * Self-healing on signed-out: when the incoming request presented a
 * session cookie BUT auth resolution returned null (orphan, expired,
 * unknown, or idle-expired session), the response appends a
 * cookie-clear Set-Cookie header. Without this, the browser would keep
 * sending the stale cookie on every subsequent probe until a protected
 * action finally cleared it.
 *
 * Cacheability: explicitly NOT cacheable.
 *   - `Cache-Control: no-store, private` forbids both browser and
 *     intermediary caches from storing the response. Under the 200
 *     contract, a cached signed-out response could make the opener
 *     think login failed after a popup completion, and a cached
 *     signed-in response could keep a stale identity visible after
 *     logout. `no-store` is the only Cache-Control directive that
 *     blocks storage entirely (no-cache merely requires revalidation).
 *   - `Pragma: no-cache` covers HTTP/1.0 intermediaries that ignore
 *     Cache-Control.
 *   - `Vary: Cookie` is defense-in-depth: any cache that DOES store
 *     the response despite no-store keys it by the session cookie, so
 *     a different user's view can't be returned.
 */

import type { Env } from '../../env';
import { authenticateRequest, clearSessionCookie, hasSessionCookie } from '../../auth-middleware';
import { isGuestPublishEnabled } from '../../../src/share/guest-publish-flag';

/** Public, non-sensitive config bridged to the Lab SPA at boot. See
 *  implementation plan §Runtime Client-Config Bridge for the contract.
 *  Additive field on every session response; legacy clients ignore it.
 *
 *  `turnstileSiteKey` is forced to null when `enabled=false` so the UI
 *  cannot render a Turnstile widget against a disabled endpoint. */
function buildPublicConfig(env: Env) {
  const enabled = isGuestPublishEnabled(env);
  const siteKey = env.TURNSTILE_SITE_KEY ?? null;
  return {
    guestPublish: {
      enabled,
      turnstileSiteKey: enabled && siteKey ? siteKey : null,
    },
  };
}

const NO_CACHE_HEADERS: Readonly<Record<string, string>> = {
  'Cache-Control': 'no-store, private',
  Pragma: 'no-cache',
  Vary: 'Cookie',
};

/** Build a response Headers object with the no-cache set applied. */
function makeHeaders(): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(NO_CACHE_HEADERS)) {
    headers.set(key, value);
  }
  return headers;
}

function signedOutResponse(request: Request, env: Env): Response {
  const headers = makeHeaders();
  // Opportunistic cookie cleanup: if the request carried a session
  // cookie we've now determined is not authoritative (orphan / expired /
  // idle / unknown session id), append a clearing Set-Cookie so the
  // browser stops sending the stale value on every subsequent probe.
  if (hasSessionCookie(request)) {
    clearSessionCookie(headers, request);
  }
  return Response.json(
    { status: 'signed-out', publicConfig: buildPublicConfig(env) },
    { headers },
  );
}

export const onRequestGet: PagesFunction<Env> = async (context) => {
  const userId = await authenticateRequest(context.request, context.env);
  if (!userId) {
    return signedOutResponse(context.request, context.env);
  }

  const user = await context.env.DB.prepare(
    'SELECT id, display_name, created_at FROM users WHERE id = ?',
  )
    .bind(userId)
    .first<{ id: string; display_name: string | null; created_at: string }>();

  if (!user) {
    // Defensive: middleware already LEFT JOINs against users and rejects
    // orphans, so this branch is unreachable under normal operation.
    // Retained as a guard against (a) a very narrow race where the user
    // row is deleted between the middleware and this query, or (b) a
    // regression in this query (e.g. a typo in the column list or WHERE
    // clause) that would otherwise silently sign every user out. Log
    // with a distinctive prefix so (b) is visible in Pages logs rather
    // than masquerading as the documented race. Cookie is cleared for
    // consistency with the other signed-out branches.
    const idPrefix = String(userId).slice(0, 8);
    console.error(
      `[auth.session.user-missing] authenticated userId prefix=${idPrefix}… ` +
      'returned null from users SELECT — race or regression?',
    );
    return signedOutResponse(context.request, context.env);
  }

  return Response.json(
    {
      status: 'signed-in',
      userId: user.id,
      displayName: user.display_name,
      createdAt: user.created_at,
      publicConfig: buildPublicConfig(context.env),
    },
    { headers: makeHeaders() },
  );
};
