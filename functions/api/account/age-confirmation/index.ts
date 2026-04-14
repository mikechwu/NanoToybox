/**
 * POST /api/account/age-confirmation
 *
 * Writes the 13+ acceptance row for the authenticated user.
 *
 * Server-authoritative: the user_id is read from the session cookie, not
 * from the request body — a client that tries to fabricate acceptance
 * for another user (by POSTing a different user_id) is ignored.
 *
 * Idempotent: composite PK on (user_id, policy_kind) makes a repeat
 * acceptance an UPSERT that updates `accepted_at` + `policy_version`
 * without creating a duplicate row. Callers can safely retry.
 */

import type { Env } from '../../../env';
import { authenticateRequest } from '../../../auth-middleware';
import { noCacheJson } from '../../../http-cache';
import { recordAuditEvent } from '../../../../src/share/audit';
import { errorMessage } from '../../../../src/share/error-message';
import { POLICY_VERSION } from '../../../../src/share/constants';

export const onRequestPost: PagesFunction<Env> = async (context) => {
  const { request, env } = context;

  const userId = await authenticateRequest(request, env);
  if (!userId) {
    return new Response('Unauthorized', { status: 401 });
  }

  const now = new Date().toISOString();

  await env.DB.prepare(
    `INSERT INTO user_policy_acceptance (user_id, policy_kind, policy_version, accepted_at)
     VALUES (?, 'age_13_plus', ?, ?)
     ON CONFLICT(user_id, policy_kind)
       DO UPDATE SET policy_version = excluded.policy_version,
                     accepted_at    = excluded.accepted_at`,
  )
    .bind(userId, POLICY_VERSION, now)
    .run();

  // Fire-and-forget audit — the UPSERT above is the authoritative
  // record of consent. NOTE: if the UPSERT throws (D1 outage) the
  // audit is also skipped, because we never reach this line — the
  // surface-level failure is the 500 from the awaited UPSERT, which
  // ops sees in Pages logs.
  recordAuditEvent(env.DB, {
    eventType: 'age_confirmation_recorded',
    actor: userId,
    severity: 'info',
    details: { policyVersion: POLICY_VERSION },
  }).catch((err) => {
    console.error(`[account.age-confirmation] audit write failed: ${errorMessage(err)}`);
  });

  return noCacheJson({
    userId,
    policyKind: 'age_13_plus',
    policyVersion: POLICY_VERSION,
    acceptedAt: now,
  });
};
