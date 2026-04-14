/**
 * Shared admin-route hard gate.
 *
 * An admin endpoint is accessible iff the caller passes ONE of the two
 * authorization paths below. Every failure mode returns 404 (not 403) so
 * the route is indistinguishable from "does not exist" — no admin-route
 * existence leak to unauthorized callers.
 *
 * **Path 1 — local operator (primary for development):**
 *   env.DEV_ADMIN_ENABLED === 'true'  (strict equality — 'false', '0',
 *     'TRUE', etc. are all disabled)
 *   AND
 *   request hostname is localhost / 127.0.0.1
 *
 *   Relies on the `DEV_ADMIN_ENABLED` env var being absent in production.
 *   Cloudflare's edge normalizes `url.hostname` from the validated Host
 *   header, so a public request with `Host: localhost` gets rejected at
 *   the edge before reaching this gate. Still defense-in-depth: **never
 *   set DEV_ADMIN_ENABLED=true on a public deploy.**
 *
 * **Path 2 — production cron/automation:**
 *   env.CRON_SECRET is non-empty
 *   AND
 *   request header `X-Cron-Secret` matches env.CRON_SECRET (constant-time)
 *
 *   Used by a deployed Cloudflare Worker (cron-triggered) that calls the
 *   admin sweep endpoints from the public domain. Without this path the
 *   localhost gate would block all production automation.
 *
 *   `CRON_SECRET` MUST be stored via `wrangler secret put`, never in
 *   `.dev.vars` committed to source.
 */

import type { Env } from './env';

/** Return a 404 Response if the request is NOT authorized. Return null on success. */
export function requireAdminOr404(
  request: Request,
  env: Env,
): Response | null {
  if (isLocalOperator(request, env)) return null;
  if (isAuthorizedCron(request, env)) return null;
  return new Response('Not found', { status: 404 });
}

function isLocalOperator(request: Request, env: Env): boolean {
  if (env.DEV_ADMIN_ENABLED !== 'true') return false;
  const url = new URL(request.url);
  return url.hostname === 'localhost' || url.hostname === '127.0.0.1';
}

function isAuthorizedCron(request: Request, env: Env): boolean {
  const secret = env.CRON_SECRET;
  if (typeof secret !== 'string' || secret.length === 0) return false;
  const presented = request.headers.get('X-Cron-Secret');
  if (typeof presented !== 'string' || presented.length === 0) return false;
  return constantTimeEqual(presented, secret);
}

/** Length-aware constant-time string comparison. */
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
