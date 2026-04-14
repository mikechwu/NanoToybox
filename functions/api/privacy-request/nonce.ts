/**
 * GET /api/privacy-request/nonce — issue a CSRF nonce for the form.
 *
 * The form fetches this on page load and posts the token back unchanged
 * to `/api/privacy-request`. The endpoint there verifies HMAC + freshness
 * + kind before accepting any write.
 *
 * Public — no session required. The nonce is bound to
 * `kind='privacy_request_intent'` with a 10-minute TTL, so an attacker
 * cannot reuse it for any other flow.
 */

import type { Env } from '../../env';
import { createPrivacyRequestIntent } from '../../signed-intents';
import { noCacheJson } from '../../http-cache';

export const onRequestGet: PagesFunction<Env> = async ({ env }) => {
  if (!env.SESSION_SECRET) {
    return new Response('Server not configured', { status: 500 });
  }
  const token = await createPrivacyRequestIntent(env);
  return noCacheJson({ nonce: token, ttlSeconds: 10 * 60 });
};
