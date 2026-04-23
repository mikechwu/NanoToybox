/**
 * POST /api/capsules/guest-publish — anonymous Quick Share.
 *
 * Mirrors the order-of-operations of the auth publish path, swapping the
 * session auth + user quota + age-acceptance precondition for:
 *   - feature-flag gate (404 when disabled)
 *   - X-Age-Attested: 1 clickwrap assertion (400 on missing)
 *   - X-Turnstile-Token header + server-side Siteverify (400 / 503)
 *   - per-hashed-IP D1 quota (429 with Retry-After)
 *
 * Byte-identity invariant: the request body is the RAW capsule JSON,
 * byte-for-byte identical to the auth endpoint body. Turnstile token
 * and age attestation travel in request headers — they must NOT be
 * parsed out of the body. See implementation plan §Guest Publish
 * Request Contract.
 *
 * Audit stream is distinct from the auth publish events (actor='guest').
 */

import type { Env } from '../../env';
import { scheduleBackground } from '../../_lib/wait-until';
import {
  preparePublishRecord,
  persistRecord,
  PublishValidationError,
} from '../../../src/share/publish-core';
import {
  checkGuestPublishQuota,
  consumeGuestPublishQuota,
  resolveGuestPublishQuota,
} from '../../../src/share/rate-limit';
import {
  recordAuditEvent,
  incrementUsageCounter,
  hashIp,
  getClientIp,
} from '../../../src/share/audit';
import type { AuditEventType } from '../../../src/share/audit';
import {
  MAX_PUBLISH_BYTES,
  PAYLOAD_TOO_LARGE_MESSAGE,
  type PayloadTooLargeBody,
} from '../../../src/share/constants';
import { isGuestPublishEnabled } from '../../../src/share/guest-publish-flag';
import { verifyTurnstileToken } from '../../../src/share/turnstile';

/** 72 hours in milliseconds — guest share lifetime per §Guest Publish Row Semantics. */
const GUEST_EXPIRY_MS = 72 * 60 * 60 * 1000;

/** Error-body shape for the 400 failure modes on this endpoint. */
interface GuestFailureBody {
  error:
    | 'turnstile_missing'
    | 'turnstile_failed'
    | 'turnstile_unavailable'
    | 'age_attestation_required'
    | 'server_not_configured'
    | 'invalid_payload';
  message: string;
}

function payloadTooLargeResponse(actualBytes?: number): Response {
  const body: PayloadTooLargeBody = {
    error: 'payload_too_large',
    message: PAYLOAD_TOO_LARGE_MESSAGE,
    maxBytes: MAX_PUBLISH_BYTES,
    ...(actualBytes !== undefined ? { actualBytes } : {}),
  };
  return Response.json(body, {
    status: 413,
    headers: { 'X-Max-Publish-Bytes': String(MAX_PUBLISH_BYTES) },
  });
}

export const onRequestPost: PagesFunction<Env> = async (context) => {
  const { request, env } = context;

  // 1. Feature-flag gate. Must run BEFORE any state read so a disabled
  //    endpoint looks exactly like a missing route from the outside.
  if (!isGuestPublishEnabled(env)) {
    return new Response('Not found', { status: 404 });
  }

  // 2. Age attestation — literal "1" only.
  const attested = request.headers.get('X-Age-Attested');
  if (attested !== '1') {
    audit(context, {
      eventType: 'guest_publish_rejected_invalid',
      severity: 'warning',
      reason: 'age_attestation_missing',
    });
    return Response.json(
      {
        error: 'age_attestation_required',
        message:
          'Please confirm you are at least 13 years old before publishing.',
      } satisfies GuestFailureBody,
      { status: 400 },
    );
  }

  // 3. Turnstile token header. Absent → 400; invalid/expired → later 400
  //    after Siteverify call.
  const token = request.headers.get('X-Turnstile-Token') ?? '';
  if (!token) {
    audit(context, {
      eventType: 'guest_publish_rejected_turnstile',
      severity: 'warning',
      reason: 'turnstile_missing',
    });
    return Response.json(
      { error: 'turnstile_missing', message: 'Verification required.' } satisfies GuestFailureBody,
      { status: 400 },
    );
  }

  // Fail-closed for misconfigured deployments: without a secret we
  // cannot verify the token server-side, and a silent allow would be an
  // abuse channel. 500 (not 400) because this is operator error, not
  // user error.
  if (!env.TURNSTILE_SECRET_KEY) {
    console.error(
      '[guest-publish] TURNSTILE_SECRET_KEY missing — endpoint fail-closed [id=GUEST_PUBLISH_NO_SECRET]',
    );
    return Response.json(
      {
        error: 'server_not_configured',
        message: 'Quick Share is temporarily unavailable.',
      } satisfies GuestFailureBody,
      { status: 500 },
    );
  }

  // 4. Client IP + hash for the per-IP quota lookup. Same helpers the
  //    privacy-request endpoint uses; salt is SESSION_SECRET.
  //
  //    Fail-closed posture (tightened 2026-04-23 per audit P1 #2). The
  //    prior build fell through to "no quota enforced" when either
  //    SESSION_SECRET or CF-Connecting-IP was missing. For an
  //    anonymous abuse-sensitive endpoint that was materially weaker
  //    than the plan's "strict IP quota" rule — a misconfigured
  //    deploy would become an open unlimited publish lane.
  //
  //    Now: both SESSION_SECRET and CF-Connecting-IP are treated as
  //    required. Missing either one = 500 server_not_configured
  //    (operator error, not user error). Audited so reconciliation
  //    tooling can catch a deploy that flips the flag to "on" while
  //    a prerequisite is unset.
  //
  //    Cloudflare always sets CF-Connecting-IP for traffic arriving
  //    at a Pages Function, so the IP branch should never fire in
  //    prod; in dev (e.g. curl against `wrangler pages dev`) the
  //    caller must supply it explicitly. Privacy-request kept its
  //    graceful degrade because its flow doesn't gate abuse the same
  //    way — the quota there is a secondary rail behind a
  //    human-readable form; here the quota IS the rail.
  if (!env.SESSION_SECRET) {
    console.error(
      '[guest-publish] SESSION_SECRET missing — endpoint fail-closed [id=GUEST_PUBLISH_NO_SESSION_SECRET]',
    );
    audit(context, {
      eventType: 'guest_publish_rejected_invalid',
      severity: 'critical',
      reason: 'session_secret_missing',
    });
    return Response.json(
      {
        error: 'server_not_configured',
        message: 'Quick Share is temporarily unavailable.',
      } satisfies GuestFailureBody,
      { status: 500 },
    );
  }
  const ip = getClientIp(request);
  if (!ip) {
    console.error(
      '[guest-publish] CF-Connecting-IP missing — cannot derive quota identity [id=GUEST_PUBLISH_NO_IP]',
    );
    audit(context, {
      eventType: 'guest_publish_rejected_invalid',
      severity: 'warning',
      reason: 'client_ip_unavailable',
    });
    return Response.json(
      {
        error: 'server_not_configured',
        message: 'Quick Share is temporarily unavailable.',
      } satisfies GuestFailureBody,
      { status: 500 },
    );
  }
  const ipHash = await hashIp(ip, env.SESSION_SECRET);

  // 5. Pre-body quota check — cheap reject before reading the body.
  const quotaConfig = resolveGuestPublishQuota(env);
  {
    const quota = await checkGuestPublishQuota(env.DB, ipHash, quotaConfig);
    if (!quota.allowed) {
      audit(context, {
        eventType: 'guest_publish_rejected_quota',
        severity: 'warning',
        reason: `quota ${quota.currentCount}/${quota.limit}`,
        ipHash,
        details: { currentCount: quota.currentCount, limit: quota.limit },
      });
      const retryAfter = Math.max(
        0,
        quota.retryAtSeconds - Math.floor(Date.now() / 1000),
      );
      return new Response(
        'Quick Share limit reached. Try again later or sign in to save links to your account.',
        {
          status: 429,
          headers: {
            'Retry-After': String(retryAfter),
            'X-RateLimit-Limit': String(quota.limit),
            'X-RateLimit-Remaining': '0',
          },
        },
      );
    }
  }

  // 6. Content-Length preflight (identical to the auth path).
  const contentLength = request.headers.get('Content-Length');
  if (contentLength && parseInt(contentLength, 10) > MAX_PUBLISH_BYTES) {
    audit(context, {
      eventType: 'guest_publish_rejected_size',
      severity: 'warning',
      reason: `content-length ${contentLength}`,
      ipHash,
    });
    return payloadTooLargeResponse();
  }

  // 7. Read raw body — this IS the capsule JSON, byte-identical to the
  //    auth path (§Guest Publish Request Contract). A client-aborted
  //    stream (lost connection, backgrounded mobile tab after a stale
  //    Turnstile solve) throws; surface 400 invalid_payload rather
  //    than a 500 so clients see an actionable error.
  let body: string;
  try {
    body = await request.text();
  } catch (err) {
    audit(context, {
      eventType: 'guest_publish_rejected_invalid',
      severity: 'warning',
      reason: `body_read_failed: ${err instanceof Error ? err.message.slice(0, 100) : String(err).slice(0, 100)}`,
      ipHash,
    });
    return Response.json(
      { error: 'invalid_payload', message: 'Publish body could not be read.' } satisfies GuestFailureBody,
      { status: 400 },
    );
  }
  const actualSize = new TextEncoder().encode(body).byteLength;
  if (actualSize > MAX_PUBLISH_BYTES) {
    audit(context, {
      eventType: 'guest_publish_rejected_size',
      severity: 'warning',
      reason: `actual ${actualSize}`,
      ipHash,
    });
    return payloadTooLargeResponse(actualSize);
  }

  // 8. Turnstile Siteverify with explicit 8 s timeout. Timeout / network
  //    failure → 503 turnstile_unavailable. NEVER allow bypass.
  const verify = await verifyTurnstileToken(token, ip, env.TURNSTILE_SECRET_KEY);
  if (!verify.ok) {
    if (verify.reason === 'siteverify_timeout' || verify.reason === 'siteverify_network') {
      audit(context, {
        eventType: 'guest_publish_rejected_turnstile',
        severity: 'warning',
        reason: verify.reason,
        ipHash,
      });
      return Response.json(
        {
          error: 'turnstile_unavailable',
          message:
            'Verification is temporarily unavailable. Please try again in a minute.',
        } satisfies GuestFailureBody,
        { status: 503 },
      );
    }
    audit(context, {
      eventType: 'guest_publish_rejected_turnstile',
      severity: 'warning',
      reason: (verify.errorCodes ?? [verify.reason]).join(','),
      ipHash,
    });
    return Response.json(
      {
        error: 'turnstile_failed',
        message: 'Verification failed. Please try again.',
      } satisfies GuestFailureBody,
      { status: 400 },
    );
  }

  // 9. Record the age attestation immediately AFTER Turnstile passes but
  //    BEFORE validation / persistence. This keeps the attestation
  //    audit row on the record even if the capsule itself fails to
  //    validate — the user did cross the clickwrap UI.
  audit(context, {
    eventType: 'guest_publish_age_attested',
    severity: 'info',
    reason: 'clickwrap',
    ipHash,
  });

  // 10. Validate + prepare.
  const now = new Date();
  const expiresAt = new Date(now.getTime() + GUEST_EXPIRY_MS).toISOString();
  let prepared;
  try {
    prepared = await preparePublishRecord({
      capsuleJson: body,
      ownerUserId: null,
      shareMode: 'guest',
      expiresAt,
      appVersion: '0.1.0',
    });
  } catch (err) {
    if (err instanceof PublishValidationError) {
      audit(context, {
        eventType: 'guest_publish_rejected_invalid',
        severity: 'warning',
        reason: err.message,
        ipHash,
      });
      return new Response(err.message, { status: 400 });
    }
    throw err;
  }

  // 11. R2 put.
  await env.R2_BUCKET.put(prepared.objectKey, prepared.blob);

  // 12. D1 persist (share code with collision retry, unchanged).
  let persisted;
  try {
    persisted = await persistRecord(env.DB, prepared);
  } catch (err) {
    await env.R2_BUCKET.delete(prepared.objectKey).catch((cleanupErr) => {
      console.error(
        `[guest-publish] R2 rollback failed for key=${prepared.objectKey}: ${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)}`,
      );
    });
    throw err;
  }

  // 13. Consume quota (post-persist, same split as auth path). Drop-
  //     failures are tolerable here: a single extra guest publish is
  //     much less costly than the auth flow's audit reconciliation,
  //     since guest rows self-expire within 72 h. `ipHash` is
  //     guaranteed non-null because step 4 now fails closed before
  //     reaching this point.
  try {
    await consumeGuestPublishQuota(env.DB, ipHash, quotaConfig);
  } catch (err) {
    console.error(
      `[guest-publish] quota consume failed post-persist for share=${persisted.shareCode}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // 14. Audit + daily counter.
  audit(context, {
    shareId: persisted.id,
    shareCode: persisted.shareCode,
    eventType: 'guest_publish_success',
    severity: 'info',
    ipHash,
    details: {
      sizeBytes: persisted.sizeBytes,
      atomCount: persisted.metadata.atomCount,
      frameCount: persisted.metadata.frameCount,
      expiresAt,
    },
  });
  waitUntil(
    context,
    incrementUsageCounter(env.DB, 'guest_publish_success').catch((err) => {
      console.error(
        `[guest-publish] counter increment failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }),
  );

  const shareUrl = new URL(`/c/${persisted.shareCode}`, request.url).toString();

  return Response.json(
    {
      shareCode: persisted.shareCode,
      shareUrl,
      sizeBytes: persisted.sizeBytes,
      expiresAt,
    },
    { status: 201 },
  );
};

function audit(
  context: Parameters<typeof onRequestPost>[0],
  input: {
    shareId?: string;
    shareCode?: string;
    eventType: AuditEventType;
    severity: 'info' | 'warning' | 'critical';
    reason?: string;
    ipHash?: string | null;
    details?: Record<string, unknown>;
  },
): void {
  waitUntil(
    context,
    recordAuditEvent(context.env.DB, {
      shareId: input.shareId,
      shareCode: input.shareCode,
      eventType: input.eventType,
      actor: 'guest',
      severity: input.severity,
      reason: input.reason,
      ipHash: input.ipHash ?? undefined,
      details: input.details,
    }).catch((err) => {
      console.error(
        `[guest-publish] audit write failed [event=${input.eventType}]: ${err instanceof Error ? err.message : String(err)}`,
      );
    }),
  );
}

function waitUntil(
  context: Parameters<typeof onRequestPost>[0],
  promise: Promise<unknown>,
): void {
  scheduleBackground(
    context as unknown as { waitUntil?: (p: Promise<unknown>) => void },
    promise,
    'guest-publish',
  );
}
