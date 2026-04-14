/**
 * POST /api/capsules/publish — authenticated capsule publish.
 *
 * Validates capsule in-memory, writes only valid capsules to R2.
 * Single-step proxy upload (no presigned URL, no quarantine).
 *
 * Phase 5 additions:
 *   - Per-user publish quota (429 + Retry-After on exceeded).
 *   - Audit events for every terminal state (success, quota-reject,
 *     size-reject, invalid-reject).
 *   - Daily usage counter increment on success.
 *
 * Audit writes use context.waitUntil() so they do not couple the response
 * to D1 write latency but still have a proper async lifetime — the
 * runtime will retry / surface failures rather than silently dropping
 * the event.
 */

import type { Env } from '../../env';
import { authenticateRequest } from '../../auth-middleware';
import {
  preparePublishRecord,
  persistRecord,
  PublishValidationError,
} from '../../../src/share/publish-core';
import {
  checkPublishQuota,
  consumePublishQuota,
  DEFAULT_PUBLISH_QUOTA,
} from '../../../src/share/rate-limit';
import {
  recordAuditEvent,
  incrementUsageCounter,
} from '../../../src/share/audit';
import type { AuditEventType } from '../../../src/share/audit';

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024; // 10 MB

export const onRequestPost: PagesFunction<Env> = async (context) => {
  const { request, env } = context;

  // Require authentication
  const userId = await authenticateRequest(request, env);
  if (!userId) {
    return new Response('Unauthorized', { status: 401 });
  }

  // Per-user publish quota — preflight check BEFORE reading the body so
  // an exceeded user is rejected cheaply. Quota is NOT consumed here;
  // that happens only after persistRecord succeeds (see "Quota commit"
  // below). Failed attempts (size, validation, R2/D1 error) never spend
  // the user's quota.
  const quota = await checkPublishQuota(env.DB, userId);
  if (!quota.allowed) {
    audit(context, userId, {
      eventType: 'publish_rejected_quota',
      severity: 'warning',
      reason: `quota ${quota.currentCount}/${quota.limit}`,
      details: { currentCount: quota.currentCount, limit: quota.limit },
    });

    const retryAfter = Math.max(0, quota.retryAtSeconds - Math.floor(Date.now() / 1000));
    return new Response('Publish quota exceeded. Try again later.', {
      status: 429,
      headers: {
        'Retry-After': String(retryAfter),
        'X-RateLimit-Limit': String(quota.limit),
        'X-RateLimit-Remaining': '0',
      },
    });
  }

  // Size enforcement layer 1: fast reject via Content-Length header
  const contentLength = request.headers.get('Content-Length');
  if (contentLength && parseInt(contentLength, 10) > MAX_UPLOAD_BYTES) {
    audit(context, userId, {
      eventType: 'publish_rejected_size',
      severity: 'warning',
      reason: `content-length ${contentLength}`,
    });
    return new Response('Payload too large', { status: 413 });
  }

  // Read body
  const body = await request.text();

  // Size enforcement layer 2: authoritative check on actual bytes
  const actualSize = new TextEncoder().encode(body).byteLength;
  if (actualSize > MAX_UPLOAD_BYTES) {
    audit(context, userId, {
      eventType: 'publish_rejected_size',
      severity: 'warning',
      reason: `actual ${actualSize}`,
    });
    return new Response('Payload too large', { status: 413 });
  }

  // Validate and prepare
  let prepared;
  try {
    prepared = await preparePublishRecord({
      capsuleJson: body,
      ownerUserId: userId,
      appVersion: '0.1.0',
    });
  } catch (err) {
    if (err instanceof PublishValidationError) {
      audit(context, userId, {
        eventType: 'publish_rejected_invalid',
        severity: 'warning',
        reason: err.message,
      });
      return new Response(err.message, { status: 400 });
    }
    throw err;
  }

  // Write validated blob to R2 (single write, no quarantine)
  await env.R2_BUCKET.put(prepared.objectKey, prepared.blob);

  // Persist D1 record with collision-safe share code
  let persisted;
  try {
    persisted = await persistRecord(env.DB, prepared);
  } catch (err) {
    // Rollback: delete orphaned R2 object
    await env.R2_BUCKET.delete(prepared.objectKey).catch((cleanupErr) => {
      console.error(`[publish] R2 rollback failed for key=${prepared.objectKey}: ${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)}`);
    });
    throw err;
  }

  // Quota commit — charge one unit against the user's rolling window.
  // Awaited synchronously so the quota remains an authoritative control
  // rather than a best-effort metric.
  //
  // If the quota write fails AFTER persistRecord succeeded, the publish
  // is already real (R2 blob + D1 row exist). Returning 500 here would
  // lie to the client — the most likely user response is a retry, which
  // creates duplicate shared capsules and operator cleanup work.
  //
  // Instead, we still return 201 (the publish IS successful) but:
  //   - include a `warnings: ['quota_accounting_failed']` field so
  //     well-behaved clients can surface the inconsistency
  //   - emit a `critical`-severity audit event so ops reconciliation
  //     tooling can detect the dropped increment
  //
  // The inconsistency is bounded: one "free" publish per dropped write.
  // Reconciliation can be done by comparing `publish_success` audit
  // rows against the quota-window counter and backfilling any delta.
  const quotaWarnings: string[] = [];
  try {
    await consumePublishQuota(env.DB, userId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      `[publish] quota consume failed post-persist for user=${userId} share=${persisted.shareCode}: ${message}`,
    );
    quotaWarnings.push('quota_accounting_failed');
    // Critical: the audit write itself is a D1 write — the very
    // resource most likely to be flapping when a quota consume fails.
    // waitUntil() would drop the reconciliation signal under exactly
    // the conditions ops needs it. Await synchronously here, and if
    // THAT also fails, emit a grep-able PUBLISH_RECONCILE_LOST tag so
    // alerting can catch the unrecoverable state.
    try {
      await recordAuditEvent(env.DB, {
        shareId: persisted.id,
        shareCode: persisted.shareCode,
        // Distinct event type. `publish_rejected_quota` means the request
        // was DENIED (429 path); this one means the publish succeeded but
        // the counter increment missed. Reconciliation reads these as two
        // separate streams so dashboards don't conflate a rejection with
        // a successful publish.
        eventType: 'publish_quota_accounting_failed',
        actor: userId,
        severity: 'critical',
        reason: `quota_accounting_failed: ${message.slice(0, 200)}`,
        details: { reconciliationNeeded: true, quotaConsumeError: message.slice(0, 200) },
      });
    } catch (auditErr) {
      const auditMessage = auditErr instanceof Error ? auditErr.message : String(auditErr);
      console.error(
        `[publish] RECONCILE LOST [id=PUBLISH_RECONCILE_LOST share=${persisted.shareCode} user=${userId}]: audit write failed after consume failure: ${auditMessage}`,
      );
      // Second warning code so the client can forward BOTH signals to
      // error tracking. The publish is still real; the share URL still
      // works; but neither the counter nor the audit row landed.
      quotaWarnings.push('audit_write_failed');
    }
  }

  // Audit trail for the successful publish. Plan (line 655-660) lists
  // "publish attempts" as an audit category; this closes that gap so
  // moderation tooling can reconstruct full publish history from the
  // audit table without joining to capsule_share.
  audit(context, userId, {
    shareId: persisted.id,
    shareCode: persisted.shareCode,
    eventType: 'publish_success',
    severity: 'info',
    details: {
      sizeBytes: persisted.sizeBytes,
      atomCount: persisted.metadata.atomCount,
      frameCount: persisted.metadata.frameCount,
    },
  });

  // Daily success counter — aggregate metric, no PII.
  waitUntil(
    context,
    incrementUsageCounter(env.DB, 'publish_success').catch((err) => {
      console.error(`[publish] counter increment failed: ${err instanceof Error ? err.message : String(err)}`);
    }),
  );

  const shareUrl = new URL(`/c/${persisted.shareCode}`, request.url).toString();

  return Response.json(
    {
      shareCode: persisted.shareCode,
      shareUrl,
      sizeBytes: persisted.sizeBytes,
      // Only present when something non-fatal went wrong during an
      // otherwise successful publish (e.g. quota counter write failed).
      // Clients may surface this to the user or forward to error tracking;
      // the publish itself is real and the shareCode/URL are usable.
      ...(quotaWarnings.length > 0 ? { warnings: quotaWarnings } : {}),
    },
    { status: 201 },
  );
};

/** Fire-and-observe audit helper. Uses context.waitUntil so the audit
 *  write has a proper async lifetime — the runtime gives it a chance
 *  to complete after the response is sent, and catches surface in ops
 *  dashboards rather than getting silently dropped on request completion. */
function audit(
  context: Parameters<typeof onRequestPost>[0],
  userId: string,
  input: {
    shareId?: string;
    shareCode?: string;
    eventType: AuditEventType;
    severity: 'info' | 'warning' | 'critical';
    reason?: string;
    details?: Record<string, unknown>;
  },
): void {
  waitUntil(
    context,
    recordAuditEvent(context.env.DB, {
      shareId: input.shareId,
      shareCode: input.shareCode,
      eventType: input.eventType,
      actor: userId,
      severity: input.severity,
      reason: input.reason,
      details: input.details,
    }).catch((err) => {
      console.error(
        `[publish] audit write failed [id=PUBLISH_AUDIT_FAIL event=${input.eventType}]: ${err instanceof Error ? err.message : String(err)}`,
      );
    }),
  );
}

/** Safe wrapper: some minimal test contexts omit waitUntil. Fall back to
 *  a detached catch so fire-and-forget still works. */
function waitUntil(
  context: Parameters<typeof onRequestPost>[0],
  promise: Promise<unknown>,
): void {
  const ctx = context as unknown as { waitUntil?: (p: Promise<unknown>) => void };
  if (typeof ctx.waitUntil === 'function') {
    ctx.waitUntil(promise);
  } else {
    promise.catch(() => {});
  }
}
