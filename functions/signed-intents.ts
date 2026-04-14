/**
 * Generic short-lived HMAC-signed intent tokens.
 *
 * A signed intent is a small JSON payload whose shape includes a
 * `kind` (namespace) + `iat`/`exp` freshness pair, HMAC-signed with a
 * server secret and base64url-encoded as `<payloadB64>.<signatureB64>`.
 *
 * Used by:
 *   - /api/account/age-confirmation/intent → auth/{provider}/start
 *     (kind='age_13_plus_intent', TTL 5 min)
 *   - /api/privacy-request/nonce → /api/privacy-request
 *     (kind='privacy_request_intent', TTL 10 min)
 *
 * The OAuth state token is intentionally NOT a consumer of this helper
 * — it carries provider + returnTo payload and has its own validator —
 * but `hmacSign` / `hmacVerify` here and in oauth-state.ts are literal
 * duplicates of the same primitive. A later refactor could move
 * oauth-state.ts over without changing its on-the-wire shape.
 */

import type { Env } from './env';
import { b64urlEncode, b64urlDecode } from '../src/share/b64url';

export interface SignedIntentPayload {
  kind: string;
  iat: number;
  exp: number;
  nonce: string;
  [key: string]: unknown;
}

async function hmacSign(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  return btoa(String.fromCharCode(...new Uint8Array(sig)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

async function hmacVerify(secret: string, data: string, signature: string): Promise<boolean> {
  const expected = await hmacSign(secret, data);
  if (expected.length !== signature.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  }
  return diff === 0;
}

// b64url helpers live in src/share/b64url.ts — both this module and
// the cursor pagination encoder use them.

export async function createSignedIntent(
  secret: string,
  extra: { kind: string } & Record<string, unknown>,
  ttlSeconds: number,
): Promise<string> {
  if (!secret) throw new Error('createSignedIntent: secret is required');

  const nonceBytes = crypto.getRandomValues(new Uint8Array(16));
  const nonce = Array.from(nonceBytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  const now = Math.floor(Date.now() / 1000);

  const payload: SignedIntentPayload = {
    ...extra,
    kind: extra.kind,
    iat: now,
    exp: now + ttlSeconds,
    nonce,
  };

  const payloadB64 = b64urlEncode(JSON.stringify(payload));
  const signature = await hmacSign(secret, payloadB64);
  return `${payloadB64}.${signature}`;
}

export class SignedIntentError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'SignedIntentError';
  }
}

export async function verifySignedIntent(
  secret: string,
  token: string,
  expectedKind: string,
): Promise<SignedIntentPayload> {
  if (!secret) throw new Error('verifySignedIntent: secret is required');
  if (typeof token !== 'string' || token.length === 0) {
    throw new SignedIntentError('invalid_format', 'Empty intent token');
  }

  const parts = token.split('.');
  if (parts.length !== 2) {
    throw new SignedIntentError('invalid_format', 'Malformed intent token');
  }

  const [payloadB64, signature] = parts;
  const valid = await hmacVerify(secret, payloadB64, signature);
  if (!valid) {
    throw new SignedIntentError('invalid_signature', 'Bad intent signature');
  }

  let payload: SignedIntentPayload;
  try {
    payload = JSON.parse(b64urlDecode(payloadB64));
  } catch {
    throw new SignedIntentError('invalid_format', 'Undecodable intent payload');
  }

  if (typeof payload.kind !== 'string' || payload.kind !== expectedKind) {
    throw new SignedIntentError('kind_mismatch', 'Intent kind mismatch');
  }

  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== 'number' || payload.exp < now) {
    throw new SignedIntentError('expired', 'Intent expired');
  }

  return payload;
}

/** Convenience for age-gate: returns the raw token string issued with
 *  `kind='age_13_plus_intent'` and a 5-minute TTL. */
export function createAgeIntent(env: Env): Promise<string> {
  const secret = env.SESSION_SECRET;
  if (!secret) throw new Error('SESSION_SECRET not configured');
  return createSignedIntent(secret, { kind: 'age_13_plus_intent' }, 5 * 60);
}

export function verifyAgeIntent(env: Env, token: string): Promise<SignedIntentPayload> {
  const secret = env.SESSION_SECRET;
  if (!secret) throw new Error('SESSION_SECRET not configured');
  return verifySignedIntent(secret, token, 'age_13_plus_intent');
}

/** Privacy-request CSRF nonce — 10-minute TTL.
 *  Issued by `GET /api/privacy-request/nonce`, consumed by
 *  `POST /api/privacy-request`. */
export function createPrivacyRequestIntent(env: Env): Promise<string> {
  const secret = env.SESSION_SECRET;
  if (!secret) throw new Error('SESSION_SECRET not configured');
  return createSignedIntent(secret, { kind: 'privacy_request_intent' }, 10 * 60);
}

export function verifyPrivacyRequestIntent(env: Env, token: string): Promise<SignedIntentPayload> {
  const secret = env.SESSION_SECRET;
  if (!secret) throw new Error('SESSION_SECRET not configured');
  return verifySignedIntent(secret, token, 'privacy_request_intent');
}
