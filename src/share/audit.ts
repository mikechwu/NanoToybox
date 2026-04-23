/**
 * Audit log + usage-counter helpers.
 *
 * Writes to the capsule_share_audit table (append-only per event) and
 * to usage_counter (day-bucketed). Shared by both the abuse-report
 * endpoint and the publish/moderation endpoints so audit semantics stay
 * consistent across the request surface.
 *
 * PII policy: raw IP addresses are never stored. Reporter IPs are
 * hashed with SHA-256 + a server-provided salt (SESSION_SECRET) to give
 * us a stable de-dup key without reversible exposure.
 *
 * Owns:        AuditEventType enum, recordAuditEvent, hasRecentAuditEvent,
 *              hashIp, getClientIp, incrementUsageCounter, dayKey
 * Depends on:  src/share/d1-types.ts
 * Called by:   functions/api/capsules/[code]/report.ts,
 *              functions/api/capsules/publish.ts (quota + publish events),
 *              functions/api/admin/capsules/[code]/delete.ts,
 *              functions/api/admin/sweep/audit.ts (audit_swept),
 *              functions/api/account/age-confirmation/index.ts,
 *              functions/api/account/delete.ts (account_delete),
 *              functions/api/privacy-request.ts (hashIp / getClientIp),
 *              src/share/capsule-delete.ts (owner/moderation deletes)
 */

import type { D1Database } from './d1-types';

export type AuditEventType =
  | 'abuse_report'
  | 'moderation_delete'
  | 'moderation_block'
  | 'publish_success'
  | 'publish_rejected_quota'
  // Post-persist quota-accounting failure — the publish succeeded but
  // the counter increment failed. Emitted with severity='critical' so
  // reconciliation tooling can backfill the counter. This is NOT a
  // rejection — the user's shareCode is live.
  | 'publish_quota_accounting_failed'
  | 'publish_rejected_size'
  | 'publish_rejected_invalid'
  | 'orphan_swept'
  | 'orphan_sweep_failed'
  | 'session_swept'
  // Self-service capsule deletion (distinct from 'moderation_delete'
  // so forensic queries can separate owner-initiated deletes from
  // admin moderation).
  | 'owner_delete'
  // Account-wide deletion. One emitted per account-delete cascade
  // run; details_json carries { capsuleCount, succeeded, failed }.
  | 'account_delete'
  // Age-gate acceptance recorded. Emitted from
  // /api/account/age-confirmation (first acceptance or retro-ack).
  | 'age_confirmation_recorded'
  // Class-based audit retention sweep. Emitted ONCE per sweep run
  // (mode=scrub or mode=delete-abuse-reports) with a summary of
  // affected rows. Per-row audit-on-audit would self-inflate.
  | 'audit_swept'
  // Preview scene-store backfill pass. Emitted ONCE per admin-endpoint
  // invocation (POST /api/admin/backfill-preview-scenes) with a
  // summary of the BackfillSummary shape. Severity mapping:
  //   - 'info'     — summary.failed.length === 0
  //   - 'warning'  — some rows failed but at least one updated
  //   - 'critical' — pure failure (updated === 0, failed > 0)
  // details_json shape (kept compact so audit rows don't blow up on
  // pathological failures — per-row detail stays in [backfill] logs):
  //   { dryRun, force, pageSize, currentThumbRev,
  //     scanned, updated, skipped, failedCount }
  | 'preview_backfill_run'
  // Guest Quick Share audit stream — kept distinct from the auth-path
  // publish events so abuse dashboards don't conflate guest and auth
  // signals. Actor is the literal 'guest' for all of these.
  | 'guest_publish_success'
  | 'guest_publish_age_attested'
  | 'guest_publish_rejected_turnstile'
  | 'guest_publish_rejected_quota'
  | 'guest_publish_rejected_size'
  | 'guest_publish_rejected_invalid'
  | 'guest_publish_expired';

export type AuditSeverity = 'info' | 'warning' | 'critical';

/**
 * Maximum length of the free-form `reason` field across all audit callers.
 * Centralized here so all endpoints share one truncation policy and cannot
 * drift (e.g. an admin endpoint bumping to 1000 while the public report
 * endpoint stays at 500).
 */
export const MAX_AUDIT_REASON_LENGTH = 500;

export interface AuditEventInput {
  shareId?: string | null;
  shareCode?: string | null;
  eventType: AuditEventType;
  actor: string;
  severity?: AuditSeverity;
  reason?: string;
  ipHash?: string;
  userAgent?: string;
  details?: Record<string, unknown>;
}

/** Append an audit event. Append-only — callers never update existing rows. */
export async function recordAuditEvent(
  db: D1Database,
  input: AuditEventInput,
  now: Date = new Date(),
): Promise<string> {
  const id = crypto.randomUUID();
  await db
    .prepare(
      `INSERT INTO capsule_share_audit (
        id, share_id, share_code, event_type, actor,
        severity, reason, ip_hash, user_agent, created_at, details_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      input.shareId ?? null,
      input.shareCode ?? null,
      input.eventType,
      input.actor,
      input.severity ?? 'info',
      input.reason ? input.reason.slice(0, MAX_AUDIT_REASON_LENGTH) : null,
      input.ipHash ?? null,
      input.userAgent ? input.userAgent.slice(0, 500) : null,
      now.toISOString(),
      input.details ? JSON.stringify(input.details) : null,
    )
    .run();
  return id;
}

/**
 * De-dup guard: has the given (shareCode, ipHash) reported the same
 * eventType within the last `windowSeconds`? Callers use this to reject
 * duplicate abuse reports from the same reporter on the same day.
 */
export async function hasRecentAuditEvent(
  db: D1Database,
  args: {
    shareCode: string;
    ipHash: string;
    eventType: AuditEventType;
    windowSeconds?: number;
  },
  now: Date = new Date(),
): Promise<boolean> {
  const window = args.windowSeconds ?? 24 * 60 * 60; // 24h default
  const cutoff = new Date(now.getTime() - window * 1000).toISOString();
  const row = await db
    .prepare(
      `SELECT 1 AS hit FROM capsule_share_audit
        WHERE share_code = ? AND ip_hash = ? AND event_type = ? AND created_at >= ?
        LIMIT 1`,
    )
    .bind(args.shareCode, args.ipHash, args.eventType, cutoff)
    .first<{ hit: number }>();
  return row !== null;
}

/** SHA-256 of `ip + salt`, returned as lowercase hex. Salt is mandatory. */
export async function hashIp(ip: string, salt: string): Promise<string> {
  if (!salt) throw new Error('hashIp: salt is required');
  const bytes = new TextEncoder().encode(`${ip}\u0000${salt}`);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const arr = new Uint8Array(digest);
  let out = '';
  for (let i = 0; i < arr.length; i++) {
    out += arr[i].toString(16).padStart(2, '0');
  }
  return out;
}

/** Best-effort extraction of the caller IP from a Cloudflare request. */
export function getClientIp(request: Request): string {
  return (
    request.headers.get('CF-Connecting-IP') ??
    request.headers.get('X-Forwarded-For')?.split(',')[0]?.trim() ??
    ''
  );
}

// ── Usage counters ─────────────────────────────────────────────────────────

/** YYYY-MM-DD day key in UTC. */
export function dayKey(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/**
 * Increment a named usage counter for today (UTC). Upsert — creates the
 * row if missing. Safe to call from any hot path; no PII is stored.
 */
export async function incrementUsageCounter(
  db: D1Database,
  metric: string,
  now: Date = new Date(),
  delta: number = 1,
): Promise<void> {
  const day = dayKey(now);
  await db
    .prepare(
      `INSERT INTO usage_counter (metric, day, count)
       VALUES (?, ?, ?)
       ON CONFLICT(metric, day) DO UPDATE SET count = count + excluded.count`,
    )
    .bind(metric, day, delta)
    .run();
}
