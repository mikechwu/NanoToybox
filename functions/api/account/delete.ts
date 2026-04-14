/**
 * POST /api/account/delete — authoritative account-wide delete cascade.
 *
 * Ordering (see plan: "Account deletion — authoritative cascade order"):
 *   1. DELETE FROM sessions WHERE user_id = ?
 *   2. DELETE FROM publish_quota_window WHERE user_id = ?
 *   3. For each owned capsule_share row: shared delete core
 *      (actor='owner', reason='account_delete_cascade')
 *   4. DELETE FROM oauth_accounts WHERE user_id = ?
 *   5. UPDATE users SET display_name = NULL, deleted_at = ? WHERE id = ?
 *   6. Emit one 'account_delete' audit event with the summary
 *
 * Each step is idempotent. Failures in a later step do NOT undo earlier
 * steps — the response reports per-step status and per-capsule failures
 * so an operator can act on anything that needs manual cleanup.
 *
 * `steps` accumulates the outcome of EVERY sub-step (including the
 * Step-3 re-scan and the Step-6 audit emission). `ok` in the final
 * response is `true` only when EVERY tracked step is `'ok'` AND no
 * per-capsule failure was recorded — without that, an audit-write
 * failure would silently let `ok:true` ride.
 *
 * After the cascade, the cookie held by the client is an orphan —
 * middleware's LEFT JOIN with `AND u.deleted_at IS NULL` returns
 * user_row_id=null, and the existing orphan-session cleanup path clears
 * it on the next request.
 */

import type { Env } from '../../env';
import { authenticateRequest, clearSessionCookie } from '../../auth-middleware';
import { deleteCapsule } from '../../../src/share/capsule-delete';
import { recordAuditEvent } from '../../../src/share/audit';
import { errorMessage } from '../../../src/share/error-message';

interface CapsuleCodeRow {
  share_code: string;
}

const BATCH_LIMIT = 200;

export const onRequestPost: PagesFunction<Env> = async (context) => {
  const { request, env } = context;

  const userId = await authenticateRequest(request, env);
  if (!userId) {
    return new Response('Unauthorized', { status: 401 });
  }

  const userAgent = request.headers.get('User-Agent') ?? undefined;
  const now = new Date().toISOString();
  const steps: Record<string, 'ok' | string> = {};

  // Per-step helper. Records `'ok'` on success, the error message
  // otherwise. The shape is what the final `anyFailure` check reads,
  // so any non-'ok' value taints the response's `ok` flag.
  const runStep = async (name: string, fn: () => Promise<unknown>): Promise<void> => {
    try {
      await fn();
      steps[name] = 'ok';
    } catch (err) {
      steps[name] = errorMessage(err);
    }
  };

  // Step 1 — revoke sessions.
  await runStep('sessions', () =>
    env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(userId).run(),
  );

  // Step 2 — drop quota rows.
  await runStep('quota', () =>
    env.DB.prepare('DELETE FROM publish_quota_window WHERE user_id = ?').bind(userId).run(),
  );

  // Step 3 — tombstone each owned capsule_share via the shared core.
  // Bounded loop with a re-scan: a concurrent publish that already
  // resolved this user's auth before Step 1 sessions-DELETE could
  // INSERT a capsule_share row mid-cascade. We tombstone the initial
  // SELECT, then re-scan once to catch anything that landed during
  // Step 3, before the users-tombstone in Step 5 starts the auth
  // middleware rejecting on the LEFT JOIN ON `deleted_at IS NULL`.
  let capsuleCount = 0;
  let succeeded = 0;
  const failed: Array<{ code: string; reason: string }> = [];
  const seen = new Set<string>();

  const tombstoneOnce = async (codes: string[]): Promise<void> => {
    for (const code of codes) {
      if (seen.has(code)) continue;
      seen.add(code);
      capsuleCount++;
      try {
        const result = await deleteCapsule(env, code, {
          actor: 'owner',
          userId,
          userAgent,
          reason: 'account_delete_cascade',
        });
        if (!result) failed.push({ code, reason: 'missing' });
        else if (!result.r2Deleted)
          failed.push({ code, reason: `r2_failed: ${result.r2Error ?? 'unknown'}` });
        else succeeded++;
      } catch (err) {
        failed.push({ code, reason: errorMessage(err) });
      }
    }
  };

  const selectCodes = async (): Promise<string[]> => {
    const rows = await env.DB.prepare(
      `SELECT share_code FROM capsule_share
         WHERE owner_user_id = ? AND status != 'deleted'
         ORDER BY created_at ASC
         LIMIT ?`,
    )
      .bind(userId, BATCH_LIMIT)
      .all<CapsuleCodeRow>();
    return rows.results.map((r) => r.share_code);
  };

  // Initial scan + tombstone — wrapped in a step so a SELECT throw
  // doesn't 500 the whole cascade and skip steps 4–6 (which would
  // leave oauth_accounts and the user row un-tombstoned). Without
  // this wrap, a transient D1 read failure on the capsule SELECT
  // would abort with no audit event and no follow-up cleanup.
  await runStep('capsules', async () => {
    await tombstoneOnce(await selectCodes());
  });
  // Re-scan in its own step so a re-scan failure is reported as
  // partial-cascade, NOT as silent drained. The previous version had
  // no try/catch here — a thrown re-scan aborted the whole handler
  // before audit + tombstone, leaving oauth_accounts deleted but the
  // user not tombstoned and no `account_delete` event recorded.
  await runStep('capsules_rescan', async () => {
    const second = await selectCodes();
    if (second.length > 0) await tombstoneOnce(second);
  });
  // Reflect per-capsule outcome in the capsules step. If the SELECT
  // itself threw, runStep already recorded that — don't overwrite it.
  if (steps.capsules === 'ok' && failed.length > 0) {
    steps.capsules = `partial: ${failed.length} failed`;
  }

  // Step 4 — drop oauth_accounts.
  await runStep('oauth', () =>
    env.DB.prepare('DELETE FROM oauth_accounts WHERE user_id = ?').bind(userId).run(),
  );

  // Step 5 — tombstone users row. display_name nulled so audit surfaces
  // don't expose it; deleted_at stamped so the middleware LEFT JOIN
  // ON-condition routes the user through the orphan path.
  await runStep('user', () =>
    env.DB
      .prepare('UPDATE users SET display_name = NULL, deleted_at = ? WHERE id = ?')
      .bind(now, userId)
      .run(),
  );

  // Step 6 — single account_delete audit event. Severity escalates to
  // critical when ANY prior sub-step failed (computed BEFORE this step
  // so the audit reflects the state we're attesting to). The audit
  // attempt is itself tracked as a step — if D1 is the failing
  // resource, the audit insert is exactly the write most likely to
  // throw, and we MUST surface that in the response's `ok` flag rather
  // than silently report success.
  const preAuditFailure =
    Object.values(steps).some((v) => v !== 'ok') || failed.length > 0;
  await runStep('audit', () =>
    recordAuditEvent(env.DB, {
      eventType: 'account_delete',
      actor: userId,
      severity: preAuditFailure ? 'critical' : 'warning',
      reason: 'account_delete',
      userAgent,
      details: { capsuleCount, succeeded, failed, steps: { ...steps } },
    }),
  );

  // Final truthful flag — must include the audit-step outcome.
  const anyFailure =
    Object.values(steps).some((v) => v !== 'ok') || failed.length > 0;

  if (anyFailure) {
    console.error(
      `[account.delete-failed] user=${userId} steps=${JSON.stringify(steps)} failed=${failed.length}`,
    );
  }

  // Clear the session cookie even though the D1 row is gone — the next
  // probe's orphan-cleanup path would do it, but returning a fresh
  // clearing header here makes the UX predictable (no "briefly signed
  // in" window on the client).
  const headers = new Headers();
  headers.set('Content-Type', 'application/json');
  clearSessionCookie(headers, request);
  return new Response(
    JSON.stringify({
      ok: !anyFailure,
      capsuleCount,
      succeeded,
      failed,
      steps,
    }),
    { status: 200, headers },
  );
};
