/**
 * OAuth state parameter: HMAC-signed, short-lived, provider-bound.
 * Carries CSRF protection, return path, and freshness proof.
 */

import type { Env } from './env';

interface OAuthStatePayload {
  provider: string;
  returnTo: string;
  nonce: string;
  iat: number;
  exp: number;
}

const STATE_TTL_SECONDS = 600; // 10 minutes

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
  // Constant-time comparison
  if (expected.length !== signature.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * Validate a returnTo path: must be a same-origin relative path starting with /.
 */
export function validateReturnTo(returnTo: string | null): string {
  if (
    !returnTo ||
    !returnTo.startsWith('/') ||
    returnTo.startsWith('//') ||
    returnTo.includes(':')
  ) {
    return '/lab/';
  }
  return returnTo;
}

export async function createOAuthState(
  env: Env,
  provider: string,
  returnTo: string,
): Promise<string> {
  const secret = env.SESSION_SECRET;
  if (!secret) throw new Error('SESSION_SECRET not configured');

  const nonceBytes = crypto.getRandomValues(new Uint8Array(16));
  const nonce = Array.from(nonceBytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  const now = Math.floor(Date.now() / 1000);

  const payload: OAuthStatePayload = {
    provider,
    returnTo: validateReturnTo(returnTo),
    nonce,
    iat: now,
    exp: now + STATE_TTL_SECONDS,
  };

  const payloadB64 = btoa(JSON.stringify(payload))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  const signature = await hmacSign(secret, payloadB64);
  return `${payloadB64}.${signature}`;
}

export async function verifyOAuthState(
  env: Env,
  state: string,
  expectedProvider: string,
): Promise<OAuthStatePayload> {
  const secret = env.SESSION_SECRET;
  if (!secret) throw new Error('SESSION_SECRET not configured');

  const parts = state.split('.');
  if (parts.length !== 2) throw new Error('Invalid state format');

  const [payloadB64, signature] = parts;
  const valid = await hmacVerify(secret, payloadB64, signature);
  if (!valid) throw new Error('Invalid state signature');

  const raw = atob(payloadB64.replace(/-/g, '+').replace(/_/g, '/'));
  const payload: OAuthStatePayload = JSON.parse(raw);

  if (payload.provider !== expectedProvider) {
    throw new Error('Provider mismatch');
  }

  const now = Math.floor(Date.now() / 1000);
  if (payload.exp < now) {
    throw new Error('State expired');
  }

  return payload;
}
