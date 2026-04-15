/**
 * Tests for `functions/oauth-state.ts` — sign + verify round-trip with
 * the new D120 fields (`age13PlusConfirmed`, `agePolicyVersion`).
 *
 * The two new fields are optional so verifying a payload minted before
 * the fields existed (in-flight users at deploy time) succeeds; the
 * callback uses `=== true` to refuse silent fall-through.
 *
 * Tampering protection: any byte-level mutation of the serialized
 * payload (including injection of the marker on a state that didn't
 * carry it) MUST fail the HMAC check.
 */

import { describe, it, expect } from 'vitest';
import { createOAuthState, verifyOAuthState } from '../../functions/oauth-state';
import type { Env } from '../../functions/env';

const SECRET = 'x'.repeat(32);
const env = { SESSION_SECRET: SECRET } as unknown as Env;

describe('oauth-state — D120 round-trip', () => {
  it('round-trip preserves age13PlusConfirmed: true', async () => {
    const token = await createOAuthState(env, 'google', '/lab/', {
      age13PlusConfirmed: true,
    });
    const payload = await verifyOAuthState(env, token, 'google');
    expect(payload.age13PlusConfirmed).toBe(true);
  });

  it('round-trip preserves agePolicyVersion when supplied', async () => {
    const token = await createOAuthState(env, 'google', '/lab/', {
      age13PlusConfirmed: true,
      agePolicyVersion: '2026-04-14.snapshot',
    });
    const payload = await verifyOAuthState(env, token, 'google');
    expect(payload.agePolicyVersion).toBe('2026-04-14.snapshot');
  });

  it('omitting both options yields a payload without the new fields (backward-compat)', async () => {
    // Mirrors an in-flight pre-deploy state OR a re-auth-from-session
    // path that doesn't carry clickwrap confirmation.
    const token = await createOAuthState(env, 'google', '/lab/');
    const payload = await verifyOAuthState(env, token, 'google');
    expect(payload.age13PlusConfirmed).toBeUndefined();
    expect(payload.agePolicyVersion).toBeUndefined();
  });

  it('marker present but version absent yields marker-true + version-undefined', async () => {
    // The callback then falls back to current POLICY_VERSION — see
    // findOrCreateUserWithPolicyAcceptance's branch (B).
    const token = await createOAuthState(env, 'google', '/lab/', {
      age13PlusConfirmed: true,
    });
    const payload = await verifyOAuthState(env, token, 'google');
    expect(payload.age13PlusConfirmed).toBe(true);
    expect(payload.agePolicyVersion).toBeUndefined();
  });

  it('tampered payload (marker injected at byte level) fails the HMAC check', async () => {
    // Mint a payload WITHOUT the marker, then forge the marker into the
    // serialized payload and verify. The forged token MUST be rejected.
    const cleanToken = await createOAuthState(env, 'google', '/lab/');
    const [payloadB64, signature] = cleanToken.split('.');
    // Decode → mutate JSON → re-encode → keep the same signature.
    const decoded = atob(payloadB64.replace(/-/g, '+').replace(/_/g, '/'));
    const obj = JSON.parse(decoded);
    obj.age13PlusConfirmed = true;
    const tamperedPayload = btoa(JSON.stringify(obj))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    const tamperedToken = `${tamperedPayload}.${signature}`;
    await expect(verifyOAuthState(env, tamperedToken, 'google'))
      .rejects.toThrow();
  });

  it('payload still carries the original 5 fields (provider, returnTo, nonce, iat, exp)', async () => {
    const token = await createOAuthState(env, 'github', '/lab/?authReturn=1');
    const payload = await verifyOAuthState(env, token, 'github');
    expect(payload.provider).toBe('github');
    expect(payload.returnTo).toBe('/lab/?authReturn=1');
    expect(typeof payload.nonce).toBe('string');
    expect(payload.nonce.length).toBeGreaterThan(0);
    expect(typeof payload.iat).toBe('number');
    expect(typeof payload.exp).toBe('number');
    expect(payload.exp).toBeGreaterThan(payload.iat);
  });
});
