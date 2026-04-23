/**
 * POST /api/capsules/:code/report — abuse report (unauthenticated).
 *
 * Body (optional JSON): { reason?: string }
 *
 * Phase 5: persists to capsule_share_audit with de-dup on (code, ip_hash)
 * within a 24-hour window. The raw IP is never stored — only a salted
 * SHA-256 hash that is stable within the server's SESSION_SECRET lifetime.
 *
 * Returns 200 {received: true} on both first-of-the-day accept and
 * subsequent duplicate suppression (the user can't tell the difference —
 * this is intentional and consistent with other public-endpoint
 * indistinguishability policies in this system).
 */

import type { Env } from '../../../env';
import { normalizeShareInput } from '../../../../src/share/share-code';
import { isAccessibleShare } from '../../../../src/share/share-record';
import type { ShareRecordStatus } from '../../../../src/share/share-record';
import {
  recordAuditEvent,
  hasRecentAuditEvent,
  hashIp,
  getClientIp,
} from '../../../../src/share/audit';

export const onRequestPost: PagesFunction<Env> = async (context) => {
  const { request, env } = context;

  const rawCode = context.params.code;
  if (typeof rawCode !== 'string') {
    return new Response('Not found', { status: 404 });
  }

  const code = normalizeShareInput(rawCode);
  if (!code) {
    return new Response('Not found', { status: 404 });
  }

  // Same accessibility check as metadata/blob — deleted/rejected return 404
  const row = await env.DB.prepare(
    'SELECT id, status, expires_at FROM capsule_share WHERE share_code = ?',
  )
    .bind(code)
    .first<{ id: string; status: ShareRecordStatus; expires_at: string | null }>();

  if (!row || !isAccessibleShare(row, new Date().toISOString())) {
    return new Response('Not found', { status: 404 });
  }

  // Parse optional body for reason string.
  let reason: string | undefined;
  try {
    const text = await request.text();
    if (text.length > 0) {
      const parsed = JSON.parse(text);
      // Truncation is enforced inside recordAuditEvent — pass through raw.
      if (parsed && typeof parsed.reason === 'string') {
        reason = parsed.reason;
      }
    }
  } catch {
    // Malformed JSON — ignore, accept the report without a reason.
  }

  // Hash the reporter's IP. If SESSION_SECRET isn't configured we still
  // accept the report (avoids leaking secret-config state via 500 to
  // unauthenticated callers) but skip de-dup — and log loudly so the
  // misconfiguration surfaces in ops dashboards. Never returns the
  // missing-secret state to the caller.
  const ip = getClientIp(request);
  let ipHash: string | undefined;
  if (ip && !env.SESSION_SECRET) {
    console.error(
      '[report] SESSION_SECRET missing — abuse-report de-dup disabled [id=REPORT_DEDUP_DISABLED]',
    );
  }
  if (ip && env.SESSION_SECRET) {
    ipHash = await hashIp(ip, env.SESSION_SECRET);

    // De-dup: suppress subsequent identical reports within 24h.
    const duplicate = await hasRecentAuditEvent(env.DB, {
      shareCode: code,
      ipHash,
      eventType: 'abuse_report',
    });
    if (duplicate) {
      return Response.json({ received: true });
    }
  }

  await recordAuditEvent(env.DB, {
    shareId: row.id,
    shareCode: code,
    eventType: 'abuse_report',
    actor: 'anonymous',
    severity: 'info',
    reason,
    ipHash,
    userAgent: request.headers.get('User-Agent') ?? undefined,
  });

  return Response.json({ received: true });
};
