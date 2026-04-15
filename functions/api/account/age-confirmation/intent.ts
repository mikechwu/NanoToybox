/**
 * POST /api/account/age-confirmation/intent
 *
 * Issues a short-lived HMAC-signed nonce that the clickwrap notice's
 * provider-button click (D120 — supersedes D118) hands to
 * GET /auth/{provider}/start. Validating the nonce on `start.ts`
 * keeps the clickwrap as the only path through which a signed-out
 * user can reach the OAuth consent flow. The auth runtime fetches
 * this nonce just-in-time AFTER opening the popup shell inside the
 * user gesture — see `lab/js/runtime/auth-runtime.ts fetchAgeIntent`.
 *
 * Public (no session required) — the nonce is only valid for 5 min
 * and is bound to `kind='age_13_plus_intent'`, so an attacker cannot
 * reuse it for anything else. The endpoint is rate-limited at the
 * Cloudflare WAF edge; see `wrangler.toml`.
 */

import type { Env } from '../../../env';
import { createAgeIntent } from '../../../signed-intents';
import { noCacheJson } from '../../../http-cache';
import { hashIp, getClientIp } from '../../../../src/share/audit';

/** Per-isolate, per-hashed-IP token bucket. App-level layer-2 defense
 *  — the primary layer is the Cloudflare WAF rule documented in
 *  `wrangler.toml`. Cloudflare multiplexes many requests onto one
 *  Worker isolate; a Map-based limit inside module scope caps the
 *  single-isolate CPU-amplification profile even when the WAF rule
 *  is under-tuned or temporarily disabled.
 *
 *  Contract: 60 requests per IP per 60 seconds. A real user hits the
 *  endpoint at most twice per surface per session; 60 is generous.
 *  When the bucket is exceeded the endpoint returns 429 without
 *  spending a `crypto.subtle.sign` on the attacker.
 *
 *  The map is NOT cross-isolate — that's by design. A determined
 *  attacker using many IPs or spreading across isolates is a WAF
 *  problem, not an app-level one. */
const WINDOW_MS = 60 * 1000;
const LIMIT = 60;
const ipBuckets = new Map<string, { count: number; windowStart: number }>();

/** Returns the remaining window for a denied request, or 0 when the
 *  request is allowed. `retryAfterSeconds` is rounded up and floored
 *  at 1 so a Retry-After header is always a positive integer. */
function checkAndConsume(ipKey: string, now: number): { allowed: boolean; retryAfterSeconds: number } {
  const bucket = ipBuckets.get(ipKey);
  if (!bucket || now - bucket.windowStart >= WINDOW_MS) {
    ipBuckets.set(ipKey, { count: 1, windowStart: now });
    return { allowed: true, retryAfterSeconds: 0 };
  }
  if (bucket.count >= LIMIT) {
    const msLeft = (bucket.windowStart + WINDOW_MS) - now;
    const retryAfterSeconds = Math.max(1, Math.ceil(msLeft / 1000));
    return { allowed: false, retryAfterSeconds };
  }
  bucket.count += 1;
  return { allowed: true, retryAfterSeconds: 0 };
}

/** Periodic housekeeping — drop expired entries so hashed IP keys
 *  don't linger in a long-lived isolate after their windows close.
 *  Two triggers, whichever fires first:
 *    (a) time-based: at most once per PRUNE_INTERVAL_MS so a steady
 *        trickle of one-off IPs doesn't retain hashes indefinitely.
 *    (b) size-based: an emergency cap for a burst of distinct IPs
 *        within one interval — keeps the map bounded even under load.
 *  Both paths walk the map in O(n) and only touch expired entries.
 *
 *  Using two triggers (not either alone) keeps the fast path cheap:
 *  (a) runs only ~60 times per minute across all requests in that
 *  interval; (b) kicks in only when the map is genuinely large. */
const PRUNE_INTERVAL_MS = 60 * 1000;
const PRUNE_SIZE_THRESHOLD = 1000;
let lastPruneAt = 0;

function pruneExpired(now: number): void {
  const timeDue = now - lastPruneAt >= PRUNE_INTERVAL_MS;
  const sizeDue = ipBuckets.size >= PRUNE_SIZE_THRESHOLD;
  if (!timeDue && !sizeDue) return;
  for (const [key, bucket] of ipBuckets) {
    if (now - bucket.windowStart >= WINDOW_MS) ipBuckets.delete(key);
  }
  lastPruneAt = now;
}

export const onRequestPost: PagesFunction<Env> = async ({ env, request }) => {
  if (!env.SESSION_SECRET) {
    return new Response('Server not configured', { status: 500 });
  }
  // Hash the client IP before bucket-keying so the in-memory map
  // never holds raw IP addresses. Reuses the same hashing primitive
  // the audit / privacy-request layers use.
  const ip = getClientIp(request);
  const ipKey = ip ? await hashIp(ip, env.SESSION_SECRET) : 'unknown';
  const now = Date.now();
  pruneExpired(now);
  const gate = checkAndConsume(ipKey, now);
  if (!gate.allowed) {
    return new Response('Too many requests', {
      status: 429,
      headers: { 'Retry-After': String(gate.retryAfterSeconds) },
    });
  }
  const token = await createAgeIntent(env);
  return noCacheJson({ ageIntent: token, ttlSeconds: 5 * 60 });
};

/** Test hook — resets the in-memory bucket state (map + prune clock)
 *  so unit tests can run deterministically without interfering with
 *  each other. Production code must not call this. */
export function __test_only_resetBuckets(): void {
  ipBuckets.clear();
  lastPruneAt = 0;
}
