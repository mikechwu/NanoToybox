/**
 * POST /api/privacy-request — public privacy contact channel (Phase 7 Option B).
 *
 * Public form submission. Records a row in `privacy_requests` for the
 * operator to action via the runbook (D1 query). Anonymous and
 * signed-in submissions are both accepted — the form is a published
 * channel for users who may have been locked out or never signed in.
 *
 * Validation:
 *   - JSON body required
 *   - request_type ∈ PRIVACY_REQUEST_TYPES
 *   - contact_value 1..256 chars
 *   - message 1..MAX_PRIVACY_REQUEST_CHARS chars (.length, not bytes)
 *   - nonce: signed-intent with kind='privacy_request_intent'
 *   - honeypot: must be empty (silent 200 no-op when filled)
 *
 * Abuse controls:
 *   - Honeypot field that legitimate users leave blank.
 *   - Per-IP D1 sliding-window rate limit (5 / 24h) — defense in
 *     depth alongside the Cloudflare WAF rule documented in
 *     wrangler.toml.
 *   - Body-dedup: SHA-256(contact + message), 24h window, identical
 *     resubmits return the prior id without writing a second row.
 *
 * PII:
 *   - Raw IP is NEVER stored. The Function computes
 *     HMAC(SESSION_SECRET, CF-Connecting-IP) and stores the hash in
 *     `client_ip_hash` purely for abuse-investigation comparisons.
 *
 * Retention:
 *   - 180 days after `resolved_at` (or after `created_at` for
 *     unresolved rows). The Phase F audit-retention sweeper extends
 *     to cover this table.
 */

import type { Env } from '../env';
import { authenticateRequest } from '../auth-middleware';
import { verifyPrivacyRequestIntent, SignedIntentError } from '../signed-intents';
import {
  checkPrivacyRequestQuota,
  consumePrivacyRequestQuota,
} from '../../src/share/rate-limit';
import { hashIp, getClientIp } from '../../src/share/audit';
import {
  MAX_PRIVACY_REQUEST_CHARS,
  MESSAGE_TOO_LONG_MESSAGE,
  PRIVACY_REQUEST_TYPES,
  type PrivacyRequestType,
} from '../../src/share/constants';
import { errorMessage } from '../../src/share/error-message';

interface RequestBody {
  contact_value?: unknown;
  request_type?: unknown;
  message?: unknown;
  nonce?: unknown;
  honeypot?: unknown;
}

const MAX_CONTACT_VALUE_CHARS = 256;
const DEDUP_WINDOW_SECONDS = 24 * 60 * 60;

function isPrivacyRequestType(v: unknown): v is PrivacyRequestType {
  return typeof v === 'string' && (PRIVACY_REQUEST_TYPES as readonly string[]).includes(v);
}

async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const arr = new Uint8Array(digest);
  let out = '';
  for (let i = 0; i < arr.length; i++) out += arr[i].toString(16).padStart(2, '0');
  return out;
}

export const onRequestPost: PagesFunction<Env> = async (context) => {
  const { request, env } = context;

  if (!env.SESSION_SECRET) {
    return new Response('Server not configured', { status: 500 });
  }

  // Parse body. Malformed JSON → 400.
  let body: RequestBody;
  try {
    body = (await request.json()) as RequestBody;
  } catch {
    return Response.json(
      { error: 'invalid_request', message: 'Body must be JSON.' },
      { status: 400 },
    );
  }

  // Honeypot — non-empty values get a silent 200 no-op.
  if (typeof body.honeypot === 'string' && body.honeypot.length > 0) {
    return Response.json({ ok: true, id: 'honeypot' }, { status: 200 });
  }

  // CSRF nonce — required, must be a fresh privacy_request_intent.
  if (typeof body.nonce !== 'string' || body.nonce.length === 0) {
    return Response.json({ error: 'invalid_nonce' }, { status: 401 });
  }
  try {
    await verifyPrivacyRequestIntent(env, body.nonce);
  } catch (err) {
    const code = err instanceof SignedIntentError ? err.code : 'invalid';
    return Response.json({ error: 'invalid_nonce', code }, { status: 401 });
  }

  // Field validation.
  if (!isPrivacyRequestType(body.request_type)) {
    return Response.json(
      { error: 'invalid_request', message: 'Unknown request_type.' },
      { status: 400 },
    );
  }
  if (
    typeof body.contact_value !== 'string' ||
    body.contact_value.length === 0 ||
    body.contact_value.length > MAX_CONTACT_VALUE_CHARS
  ) {
    return Response.json(
      {
        error: 'invalid_request',
        message: `contact_value must be 1..${MAX_CONTACT_VALUE_CHARS} characters.`,
      },
      { status: 400 },
    );
  }
  if (typeof body.message !== 'string' || body.message.length === 0) {
    return Response.json(
      { error: 'invalid_request', message: 'message is required.' },
      { status: 400 },
    );
  }
  if (body.message.length > MAX_PRIVACY_REQUEST_CHARS) {
    return Response.json(
      {
        error: 'message_too_long',
        message: MESSAGE_TOO_LONG_MESSAGE,
        maxChars: MAX_PRIVACY_REQUEST_CHARS,
        actualChars: body.message.length,
      },
      { status: 400 },
    );
  }

  const requestType: PrivacyRequestType = body.request_type;
  const contactValue: string = body.contact_value;
  const message: string = body.message;

  // Hash the IP and check the layer-2 D1 quota. Layer 1 (Cloudflare
  // WAF) blocks before reaching here in production; the D1 quota is
  // the in-code fallback if the WAF rule is misconfigured/removed.
  const ip = getClientIp(request);
  const ipHash = ip ? await hashIp(ip, env.SESSION_SECRET) : '';
  if (ipHash) {
    const quota = await checkPrivacyRequestQuota(env.DB, ipHash);
    if (!quota.allowed) {
      const retryAfter = Math.max(0, quota.retryAtSeconds - Math.floor(Date.now() / 1000));
      return new Response(JSON.stringify({ error: 'rate_limited' }), {
        status: 429,
        headers: {
          'Content-Type': 'application/json',
          'Retry-After': String(retryAfter),
        },
      });
    }
  }

  // Optional auth — record the user_id if a session cookie is present.
  // Not required: a locked-out or never-signed-in user can still file.
  const userId = await authenticateRequest(request, env);

  // Body-dedup: an identical (contact_value, message) submitted in the
  // last 24h returns the prior id without writing a second row.
  const dedupHash = await sha256Hex(`${contactValue}\u0000${message}`);
  const cutoffSeconds = Math.floor(Date.now() / 1000) - DEDUP_WINDOW_SECONDS;
  const existing = await env.DB.prepare(
    `SELECT id FROM privacy_requests
       WHERE created_at >= ?
         AND contact_value = ?
         AND message = ?
       LIMIT 1`,
  )
    .bind(cutoffSeconds, contactValue, message)
    .first<{ id: string }>();
  if (existing) {
    return Response.json(
      { ok: true, id: existing.id, submittedAt: cutoffSeconds, deduped: true },
      { status: 200 },
    );
  }

  // Insert the row.
  const id = crypto.randomUUID();
  const nowSeconds = Math.floor(Date.now() / 1000);
  try {
    await env.DB.prepare(
      `INSERT INTO privacy_requests (
         id, created_at, user_id, contact_value, request_type,
         message, client_ip_hash, status
       ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')`,
    )
      .bind(id, nowSeconds, userId ?? null, contactValue, requestType, message, ipHash || null)
      .run();
  } catch (err) {
    console.error(`[privacy-request] D1 insert failed: ${errorMessage(err)}`);
    return Response.json(
      { error: 'server_error', message: 'Could not record your request.' },
      { status: 500 },
    );
  }

  // Charge one unit against the per-IP quota AFTER the write succeeds.
  // Same split-quota pattern as publish: rejected requests do not spend
  // the IP's allowance.
  if (ipHash) {
    consumePrivacyRequestQuota(env.DB, ipHash).catch((err) => {
      console.error(`[privacy-request] quota consume failed: ${errorMessage(err)}`);
    });
  }

  // Response intentionally omits dedupHash — it identifies a submission
  // by its contact+message content and should not be echoed back.
  return Response.json({ ok: true, id, submittedAt: nowSeconds }, { status: 200 });
};
