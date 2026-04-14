/**
 * POST /api/account/age-confirmation/intent
 *
 * Issues a short-lived HMAC-signed nonce that the checkbox click hands
 * to GET /auth/{provider}/start. Validating the nonce on `start.ts`
 * makes the checkbox the only path through which a new user can reach
 * the OAuth consent flow.
 *
 * Public (no session required) — the nonce is only valid for 5 min
 * and is bound to `kind='age_13_plus_intent'`, so an attacker cannot
 * reuse it for anything else.
 */

import type { Env } from '../../../env';
import { createAgeIntent } from '../../../signed-intents';
import { noCacheJson } from '../../../http-cache';

export const onRequestPost: PagesFunction<Env> = async ({ env }) => {
  if (!env.SESSION_SECRET) {
    return new Response('Server not configured', { status: 500 });
  }
  const token = await createAgeIntent(env);
  return noCacheJson({ ageIntent: token, ttlSeconds: 5 * 60 });
};
