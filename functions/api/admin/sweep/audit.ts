/**
 * POST /api/admin/sweep/audit — class-based audit-retention sweeper.
 *
 * `capsule_share_audit` is the operational chain-of-custody for every
 * event in `AuditEventType` — moderation, publish, quota, sweep, etc.
 * Deleting whole rows after 180 days would destroy forensic data whose
 * only sensitive field is `ip_hash` or `user_agent`. Retention is
 * therefore per-data-class:
 *
 *   mode=scrub (default)
 *     NULL `ip_hash`, `user_agent`, and (for abuse_report +
 *     moderation_delete only) `reason` on rows older than
 *     `maxAgeDays` (default 180). Event skeleton (event_type,
 *     share_code, created_at, severity, actor, details_json) is
 *     retained indefinitely for operational forensics.
 *
 *   mode=delete-abuse-reports
 *     Row-delete `event_type='abuse_report'` audit rows older than
 *     the threshold. This event class is dominated by the IP-hash
 *     de-dup signal and has limited value after the window expires.
 *     Also row-deletes `privacy_requests` rows past the same
 *     threshold (180-day SLA disclosed in /privacy) — cutoff applies
 *     to `resolved_at` when set, else `created_at`.
 *
 *   Independent of mode, every run also calls
 *   `prunePrivacyRequestQuota` to drop expired quota buckets.
 *
 * One `audit_swept` event is emitted per sweep RUN (not per row) with
 * `details_json = { mode, scrubbed?, deleted?, maxAgeDays }` so the
 * audit table does not self-inflate.
 *
 * Protection: admin-gated (same dev-local / CRON_SECRET contract as
 * other sweeps).
 */

import type { Env } from '../../../env';
import { requireAdminOr404 } from '../../../admin-gate';
import { recordAuditEvent } from '../../../../src/share/audit';
import { prunePrivacyRequestQuota } from '../../../../src/share/rate-limit';

const DEFAULT_MAX_AGE_DAYS = 180;

type Mode = 'scrub' | 'delete-abuse-reports';

function parseMode(value: string | null): Mode {
  if (value === 'delete-abuse-reports') return 'delete-abuse-reports';
  return 'scrub';
}

function parseMaxAgeDays(value: string | null): number {
  const n = value ? Number.parseInt(value, 10) : Number.NaN;
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_MAX_AGE_DAYS;
  // Never let a stray query param pull the cutoff under 7 days — that
  // would be an operational footgun even from an admin-gated endpoint.
  return Math.max(7, Math.min(n, 10 * 365));
}

export const onRequestPost: PagesFunction<Env> = async (context) => {
  const { request, env } = context;
  const denied = requireAdminOr404(request, env);
  if (denied) return denied;

  const url = new URL(request.url);
  const mode = parseMode(url.searchParams.get('mode'));
  const maxAgeDays = parseMaxAgeDays(url.searchParams.get('maxAgeDays'));
  const now = new Date();
  const cutoff = new Date(
    now.getTime() - maxAgeDays * 24 * 60 * 60 * 1000,
  ).toISOString();

  let scrubbed: number | undefined;
  let deleted: number | undefined;

  if (mode === 'scrub') {
    // Count eligible rows first (D1's Result meta is shim-shaped here —
    // a SELECT COUNT gives us an authoritative number for the audit).
    const count = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM capsule_share_audit
         WHERE created_at < ?
           AND (ip_hash IS NOT NULL
                OR user_agent IS NOT NULL
                OR (event_type IN ('abuse_report','moderation_delete') AND reason IS NOT NULL))`,
    )
      .bind(cutoff)
      .first<{ n: number }>();
    scrubbed = count?.n ?? 0;

    // NULL sensitive fields on rows older than the cutoff. `reason` is
    // preserved for system-emitted events (publish_*, *_swept, etc.)
    // where it contains operational counters, not user prose.
    //
    // The WHERE filter mirrors the COUNT predicate above so we only
    // touch rows that actually have something to scrub. Without it
    // every old row would be re-written every week, even ones already
    // scrubbed on a previous pass — wasted D1 writes for no behaviour
    // change.
    await env.DB.prepare(
      `UPDATE capsule_share_audit
          SET ip_hash    = NULL,
              user_agent = NULL,
              reason     = CASE
                             WHEN event_type IN ('abuse_report','moderation_delete')
                               THEN NULL
                             ELSE reason
                           END
        WHERE created_at < ?
          AND (ip_hash IS NOT NULL
               OR user_agent IS NOT NULL
               OR (event_type IN ('abuse_report','moderation_delete') AND reason IS NOT NULL))`,
    )
      .bind(cutoff)
      .run();
  } else {
    const count = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM capsule_share_audit
         WHERE event_type = 'abuse_report' AND created_at < ?`,
    )
      .bind(cutoff)
      .first<{ n: number }>();
    deleted = count?.n ?? 0;

    await env.DB.prepare(
      `DELETE FROM capsule_share_audit
         WHERE event_type = 'abuse_report' AND created_at < ?`,
    )
      .bind(cutoff)
      .run();

    // Privacy-request retention: row-delete privacy_requests rows past
    // the same threshold (180-day SLA disclosed in /privacy). The
    // `created_at` column on this table is unix seconds, so the cutoff
    // ISO string from above isn't directly comparable — convert.
    const cutoffSeconds = Math.floor(
      now.getTime() / 1000 - maxAgeDays * 24 * 60 * 60,
    );
    await env.DB.prepare(
      `DELETE FROM privacy_requests
         WHERE (resolved_at IS NOT NULL AND resolved_at < ?)
            OR (resolved_at IS NULL AND created_at < ?)`,
    )
      .bind(cutoffSeconds, cutoffSeconds)
      .run();
  }

  // Always prune the privacy-request quota window — independent of
  // mode, cheap O(log N), keeps the table from accumulating buckets
  // older than the 24h sliding window + a 24h grace.
  await prunePrivacyRequestQuota(env.DB);

  // Audit emission is best-effort: the destructive UPDATE / DELETE
  // already ran. If the audit insert itself fails we still want
  // operators to see the data-class operation succeeded — but with a
  // `warnings` field so the audit-log gap is observable.
  let auditWarning: string | undefined;
  try {
    await recordAuditEvent(env.DB, {
      eventType: 'audit_swept',
      actor: 'sweeper',
      severity: 'info',
      reason: `mode=${mode} maxAgeDays=${maxAgeDays}`,
      details: {
        mode,
        maxAgeDays,
        ...(scrubbed !== undefined ? { scrubbed } : {}),
        ...(deleted !== undefined ? { deleted } : {}),
      },
    });
  } catch (err) {
    auditWarning = err instanceof Error ? err.message : String(err);
    console.error(`[admin.sweep.audit] audit_swept event write failed: ${auditWarning}`);
  }

  return Response.json({
    ok: true,
    ranAt: now.toISOString(),
    mode,
    maxAgeDays,
    ...(scrubbed !== undefined ? { scrubbed } : {}),
    ...(deleted !== undefined ? { deleted } : {}),
    ...(auditWarning ? { warnings: ['audit_failed'] } : {}),
  });
};
