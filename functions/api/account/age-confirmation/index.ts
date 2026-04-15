/**
 * POST /api/account/age-confirmation
 *
 * Legacy / remediation endpoint for the 13+ acceptance row. Most users
 * have the row written at OAuth callback time (see
 * `functions/policy-acceptance.ts findOrCreateUserWithPolicyAcceptance`).
 * This endpoint covers:
 *
 *   - users created BEFORE the OAuth-callback acceptance write shipped
 *     (legacy population) who hit the publish-time 428 backstop;
 *   - any account state created through an unexpected path (which
 *     should be vanishingly rare post-deploy).
 *
 * Server-authoritative: the user_id is read from the session cookie,
 * not from the request body — a client that tries to fabricate
 * acceptance for another user (by POSTing a different user_id) is
 * ignored.
 *
 * Idempotent: the shared helper does an UPSERT on (user_id,
 * policy_kind), so repeat calls update `accepted_at` + `policy_version`
 * without creating a duplicate row.
 *
 * The endpoint must NOT keep its own SQL — both this surface and the
 * OAuth callback share `recordAge13PlusAcceptance` so a future
 * policy-version bump or schema migration lands in one place.
 */

import type { Env } from '../../../env';
import { authenticateRequest } from '../../../auth-middleware';
import { noCacheJson } from '../../../http-cache';
import { POLICY_VERSION } from '../../../../src/share/constants';
import { recordAge13PlusAcceptance } from '../../../policy-acceptance';

export const onRequestPost: PagesFunction<Env> = async (context) => {
  const { request, env } = context;

  const userId = await authenticateRequest(request, env);
  if (!userId) {
    return new Response('Unauthorized', { status: 401 });
  }

  // Single source of truth — the helper does the UPSERT and
  // best-effort audit emission. Throws on DB failure; that surfaces
  // as a 500 from this endpoint, which ops sees in Pages logs.
  await recordAge13PlusAcceptance(env.DB, userId, POLICY_VERSION);

  // Wall-clock timestamp returned for observability — the helper
  // writes its own `accepted_at`; the timestamp here is informational
  // for the client (it is what would be returned from a fresh GET).
  const acceptedAt = new Date().toISOString();
  return noCacheJson({
    userId,
    policyKind: 'age_13_plus',
    policyVersion: POLICY_VERSION,
    acceptedAt,
  });
};
