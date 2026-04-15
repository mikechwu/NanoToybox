/**
 * Shared policy-acceptance helpers for the 13+ age-confirmation flow.
 *
 * Two responsibilities:
 *
 *   1. `recordAge13PlusAcceptance(db, userId, version)` — idempotent
 *      UPSERT into `user_policy_acceptance` + best-effort audit emission.
 *      Single source of truth for "the user crossed the 13+ clickwrap";
 *      consumed by both the legacy/remediation endpoint
 *      (`POST /api/account/age-confirmation`) and the existing-user
 *      branch of `findOrCreateUserWithPolicyAcceptance` below.
 *
 *   2. `findOrCreateUserWithPolicyAcceptance(db, info, age)` — replaces
 *      `findOrCreateUser` in OAuth callbacks. For NEW users, writes
 *      `users` + `oauth_accounts` + `user_policy_acceptance` in a SINGLE
 *      `db.batch([...])` so the database never holds account-linked
 *      personal data without the matching acceptance row. For EXISTING
 *      users, falls through to the shared helper.
 *
 * `redirectToAuthError(request, provider, reason)` is the matching
 * failure-path helper used by callbacks when acceptance recording
 * cannot proceed (e.g., `MissingAge13PlusError` on a brand-new account
 * whose state payload predates this deploy, or any DB failure).
 *
 * Acceptance invariant — precise wording (see plan §2 backend):
 *
 *   1. New-account creation through the post-clickwrap flow ⇒ acceptance.
 *      Brand-new OAuth accounts are created in a single transactional
 *      batch that includes the acceptance row.
 *   2. Callback acceptance failure ⇒ no session. The callback bails
 *      before `createSessionAndRedirect`.
 *   3. Legacy / pre-deploy existing sessions are still publish-gated.
 *      The unchanged `428 age_confirmation_required` backstop covers
 *      the population that this helper does not.
 */

import type { Env } from './env';
import type { OAuthUserInfo } from './oauth-helpers';
import { recordAuditEvent } from '../src/share/audit';
import { errorMessage } from '../src/share/error-message';
import { POLICY_VERSION } from '../src/share/constants';

/** Database key for the durable minimum-age acceptance row.
 *
 *  The literal string `'age_13_plus'` is retained for schema + historical
 *  compatibility — migration `0006_user_policy_acceptance.sql` indexes on
 *  `policy_kind` and an earlier generation of the product named the
 *  baseline after the US COPPA 13+ rule. The row now represents the
 *  broader claim recorded by the clickwrap: "I am at least 13 years
 *  old, or older if required by the laws of my country of residence"
 *  (see `privacy/index.html` "Minimum age" and `terms/index.html`
 *  "Minimum age" for the full legal wording the user sees). Some
 *  jurisdictions under the GDPR / UK GDPR set the digital-consent age
 *  as high as 16; the user's clickwrap confirmation covers those
 *  cases without a second database row.
 *
 *  Do NOT rename the constant without an accompanying migration — the
 *  publish-428 backstop and ops runbook both join on this key. If the
 *  policy ever bumps to a hard numerical age (e.g., 16 globally), bump
 *  `POLICY_VERSION` so the existing acceptance rows are superseded and
 *  users are re-prompted via the publish-clickwrap fallback. */
export const MINIMUM_AGE_POLICY_KIND = 'age_13_plus';

/** Thrown by `findOrCreateUserWithPolicyAcceptance` when a brand-new
 *  OAuth identity arrives without `age13PlusConfirmed` in the OAuth
 *  state payload. The callback catches this and redirects to
 *  `/auth/error?reason=acceptance_failed` rather than creating a
 *  session or any account-linked rows. */
export class MissingAge13PlusError extends Error {
  readonly kind = 'missing-age-13-plus' as const;
  constructor(message = 'Cannot create new account without 13+ confirmation in OAuth state') {
    super(message);
    this.name = 'MissingAge13PlusError';
  }
}

/** Result returned by `findOrCreateUserWithPolicyAcceptance`. Carries
 *  enough metadata for callback tests to distinguish the new-user vs
 *  existing-user paths and to assert the acceptance invariants. */
export interface FindOrCreateResult {
  userId: string;
  /** True iff this call wrote the `users` row (new account). */
  createdUser: boolean;
  /** True iff this call wrote (or updated) the `user_policy_acceptance` row. */
  acceptanceRecorded: boolean;
}

/** Best-effort audit emission. The audit log is a journal — duplicate
 *  `age_confirmation_recorded` events across surfaces (callback +
 *  legacy endpoint) are acceptable and preferable to suppression.
 *  Audit-write failure does NOT throw; the durable acceptance row is
 *  the authoritative record of consent. */
async function emitAgeConfirmationRecorded(
  db: D1Database,
  userId: string,
  policyVersion: string,
): Promise<void> {
  try {
    await recordAuditEvent(db, {
      eventType: 'age_confirmation_recorded',
      actor: userId,
      severity: 'info',
      details: { policyVersion },
    });
  } catch (err) {
    // Log + swallow. Ops sees this in Pages logs; the user is
    // unaffected because the acceptance row already exists.
    console.error(`[policy-acceptance] audit write failed: ${errorMessage(err)}`);
  }
}

/** Idempotent UPSERT into `user_policy_acceptance` + best-effort audit.
 *  Single source of truth for "the user crossed the 13+ clickwrap."
 *
 *  Used by:
 *    - existing-user branch of `findOrCreateUserWithPolicyAcceptance`
 *    - legacy/remediation endpoint `POST /api/account/age-confirmation`
 *
 *  NOT used by the new-user branch — that path inlines the same INSERT
 *  inside a `db.batch([...])` for atomicity (see helper below). The
 *  duplicated SQL there is the one allowed exception to "all writes
 *  go through `recordAge13PlusAcceptance`."
 *
 *  Throws if the UPSERT fails (caller decides session/redirect handling). */
export async function recordAge13PlusAcceptance(
  db: D1Database,
  userId: string,
  policyVersion: string = POLICY_VERSION,
): Promise<void> {
  const now = new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO user_policy_acceptance (user_id, policy_kind, policy_version, accepted_at)
       VALUES (?, 'age_13_plus', ?, ?)
       ON CONFLICT(user_id, policy_kind)
         DO UPDATE SET policy_version = excluded.policy_version,
                       accepted_at    = excluded.accepted_at`,
    )
    .bind(userId, policyVersion, now)
    .run();
  await emitAgeConfirmationRecorded(db, userId, policyVersion);
}

/** Replaces `findOrCreateUser` in OAuth callbacks. Folds the acceptance
 *  write into the new-user creation batch so the database never holds
 *  account-linked personal data without the matching acceptance row.
 *
 *  Branches on the OAuth state payload's `age13PlusConfirmed` marker:
 *
 *    (A) marker absent + new account:
 *        throws `MissingAge13PlusError`. The callback catches and
 *        redirects to `/auth/error?reason=acceptance_failed`. No
 *        `users` or `oauth_accounts` row is written.
 *
 *    (B) marker absent + existing account:
 *        no acceptance write — the user reaches the Lab signed-in via
 *        `createSessionAndRedirect` and the publish-428 backstop covers
 *        them on first publish.
 *
 *    (C) marker present + new account:
 *        single `db.batch([...])` writes `users` + `oauth_accounts` +
 *        `user_policy_acceptance` atomically. Audit emission happens
 *        out-of-batch (failures don't roll back the row).
 *
 *    (D) marker present + existing account:
 *        delegates to `recordAge13PlusAcceptance` (single-statement
 *        UPSERT, no batch needed). */
export async function findOrCreateUserWithPolicyAcceptance(
  db: D1Database,
  info: OAuthUserInfo,
  age: { age13PlusConfirmed: boolean; policyVersion: string },
): Promise<FindOrCreateResult> {
  const existing = await db
    .prepare('SELECT user_id FROM oauth_accounts WHERE provider = ? AND provider_account_id = ?')
    .bind(info.provider, info.providerAccountId)
    .first<{ user_id: string }>();

  if (existing) {
    // `=== true` (defense in depth) — both callbacks normalise to a
    // boolean at the call site, but a future caller passing the raw
    // OAuth state payload directly would need this literal check to
    // refuse silent fall-through if the marker were ever serialized
    // as a non-boolean (e.g. the string "true").
    if (age.age13PlusConfirmed === true) {
      // Branch (D)
      await recordAge13PlusAcceptance(db, existing.user_id, age.policyVersion);
      return { userId: existing.user_id, createdUser: false, acceptanceRecorded: true };
    }
    // Branch (B)
    return { userId: existing.user_id, createdUser: false, acceptanceRecorded: false };
  }

  // No oauth_accounts row exists — this would be a new user creation.
  if (age.age13PlusConfirmed !== true) {
    // Branch (A) — refuse to write any account-linked rows. The
    // callback redirects to /auth/error; the user retries with fresh
    // post-deploy state and succeeds atomically on the second try.
    throw new MissingAge13PlusError();
  }

  // Branch (C) — atomic three-statement batch.
  //
  // The acceptance INSERT here is intentionally inlined (NOT a call to
  // `recordAge13PlusAcceptance`) so D1's `db.batch` can hold the three
  // statements as a single transactional unit. Splitting the
  // acceptance write into a separate awaited helper call would
  // re-introduce the gap this helper closes — `users` +
  // `oauth_accounts` could be committed without the acceptance row if
  // the second await throws. This is the one allowed exception to the
  // "all writes go through `recordAge13PlusAcceptance`" rule.
  const userId = crypto.randomUUID();
  const oauthId = crypto.randomUUID();
  const now = new Date().toISOString();
  await db.batch([
    db
      .prepare('INSERT INTO users (id, display_name, created_at) VALUES (?, ?, ?)')
      .bind(userId, info.displayName, now),
    db
      .prepare(
        `INSERT INTO oauth_accounts (id, user_id, provider, provider_account_id, email, email_verified)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        oauthId,
        userId,
        info.provider,
        info.providerAccountId,
        info.email,
        info.emailVerified ? 1 : 0,
      ),
    db
      .prepare(
        `INSERT INTO user_policy_acceptance (user_id, policy_kind, policy_version, accepted_at)
         VALUES (?, 'age_13_plus', ?, ?)
         ON CONFLICT(user_id, policy_kind)
           DO UPDATE SET policy_version = excluded.policy_version,
                         accepted_at    = excluded.accepted_at`,
      )
      .bind(userId, age.policyVersion, now),
  ]);
  // Audit out-of-batch — duplicate emissions across surfaces are OK.
  await emitAgeConfirmationRecorded(db, userId, age.policyVersion);
  return { userId, createdUser: true, acceptanceRecorded: true };
}

/** Builds the absolute URL for `/auth/error` and returns a 302 to it.
 *
 *  Always uses `new URL('/auth/error', request.url)` rather than a
 *  bare relative path — Workers' `Response.redirect` accepts only
 *  absolute URLs uniformly across runtimes. URLSearchParams handles
 *  query-value encoding so `provider`/`reason` can never break the URL
 *  grammar. The matching landing route at `functions/auth/error.ts`
 *  whitelists both values; arbitrary input is mapped to a generic copy.
 *
 *  Used by OAuth callbacks on any acceptance-failure branch. The
 *  callback bails before `createSessionAndRedirect`, so the response
 *  carries NO `Set-Cookie` header. */
export function redirectToAuthError(
  request: Request,
  provider: 'google' | 'github',
  reason: 'acceptance_failed' | 'oauth_failed',
): Response {
  const errorUrl = new URL('/auth/error', request.url);
  errorUrl.searchParams.set('reason', reason);
  errorUrl.searchParams.set('provider', provider);
  return Response.redirect(errorUrl.toString(), 302);
}

/** Re-export for compatibility / convenience — callers needing the
 *  current policy version can import it from here without pulling the
 *  src/ constants module directly. */
export { POLICY_VERSION };

/** Used in tests to suppress the audit emission's expected console
 *  warning when the audit table itself is mocked-failing. Real
 *  callers must not import this. */
export const __test_only_emitAgeConfirmationRecorded = emitAgeConfirmationRecorded;
