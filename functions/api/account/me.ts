/**
 * GET /api/account/me — authenticated-user detail.
 *
 * Returns identity + provider summary + age-confirmation status for the
 * signed-in user. 401 when signed out (unlike /api/auth/session which
 * returns a 200 discriminator — this endpoint is specifically for the
 * Account page and isn't a probe).
 */

import type { Env } from '../../env';
import { authenticateRequest } from '../../auth-middleware';
import { noCacheHeaders, noCacheJson } from '../../http-cache';

export const onRequestGet: PagesFunction<Env> = async (context) => {
  const userId = await authenticateRequest(context.request, context.env);
  if (!userId) {
    return new Response('Unauthorized', { status: 401, headers: noCacheHeaders() });
  }

  // ORDER BY provider gives a deterministic pick when a user has both
  // Google AND GitHub accounts linked (current schema permits this even
  // though the UI doesn't yet expose linking). Without the ORDER BY,
  // the row D1 returns is unspecified, and the Account page's
  // displayed "Signed in via X" flips between requests.
  const user = await context.env.DB.prepare(
    `SELECT u.id, u.display_name, u.created_at,
            oa.provider AS provider
       FROM users u
       LEFT JOIN oauth_accounts oa ON oa.user_id = u.id
      WHERE u.id = ?
      ORDER BY oa.provider ASC
      LIMIT 1`,
  )
    .bind(userId)
    .first<{
      id: string;
      display_name: string | null;
      created_at: string;
      provider: string | null;
    }>();

  if (!user) {
    return new Response('Unauthorized', { status: 401, headers: noCacheHeaders() });
  }

  const acceptance = await context.env.DB.prepare(
    `SELECT policy_version, accepted_at
       FROM user_policy_acceptance
      WHERE user_id = ? AND policy_kind = 'age_13_plus'
      LIMIT 1`,
  )
    .bind(userId)
    .first<{ policy_version: string; accepted_at: string }>();

  return noCacheJson({
    userId: user.id,
    displayName: user.display_name,
    createdAt: user.created_at,
    provider: user.provider,
    ageConfirmedAt: acceptance?.accepted_at ?? null,
    policyVersion: acceptance?.policy_version ?? null,
  });
};
