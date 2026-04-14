/**
 * Tests for functions/signed-intents.ts — generic HMAC-signed intent helper.
 *
 * Covers:
 *   - Round-trip: create → verify succeeds with matching kind + fresh TTL.
 *   - Wrong kind mismatch rejected.
 *   - Expired payload rejected.
 *   - Tampered signature rejected.
 *   - Malformed token rejected.
 *   - createAgeIntent/verifyAgeIntent integration with env.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  createSignedIntent,
  verifySignedIntent,
  SignedIntentError,
  createAgeIntent,
  verifyAgeIntent,
} from '../../functions/signed-intents';
import type { Env } from '../../functions/env';

const SECRET = 'test-secret-key-with-enough-entropy-for-tests';

function env(): Env {
  return { SESSION_SECRET: SECRET } as unknown as Env;
}

afterEach(() => vi.useRealTimers());

describe('signed-intents', () => {
  it('round-trip: create → verify succeeds with matching kind', async () => {
    const token = await createSignedIntent(SECRET, { kind: 'k1' }, 60);
    const payload = await verifySignedIntent(SECRET, token, 'k1');
    expect(payload.kind).toBe('k1');
    expect(typeof payload.nonce).toBe('string');
    expect(payload.nonce.length).toBeGreaterThan(16);
    expect(payload.exp).toBeGreaterThan(payload.iat);
  });

  it('rejects wrong kind', async () => {
    const token = await createSignedIntent(SECRET, { kind: 'k1' }, 60);
    await expect(verifySignedIntent(SECRET, token, 'k2')).rejects.toMatchObject({
      code: 'kind_mismatch',
    });
  });

  it('rejects expired payload', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-14T00:00:00Z'));
    const token = await createSignedIntent(SECRET, { kind: 'k1' }, 5);
    vi.setSystemTime(new Date('2026-04-14T00:00:10Z'));
    await expect(verifySignedIntent(SECRET, token, 'k1')).rejects.toMatchObject({
      code: 'expired',
    });
  });

  it('rejects tampered signature', async () => {
    const token = await createSignedIntent(SECRET, { kind: 'k1' }, 60);
    const [payload, sig] = token.split('.');
    const flipped = sig.slice(0, -1) + (sig.slice(-1) === 'A' ? 'B' : 'A');
    await expect(
      verifySignedIntent(SECRET, `${payload}.${flipped}`, 'k1'),
    ).rejects.toMatchObject({ code: 'invalid_signature' });
  });

  it('rejects malformed token', async () => {
    await expect(verifySignedIntent(SECRET, 'not-a-token', 'k1')).rejects.toMatchObject({
      code: 'invalid_format',
    });
    await expect(verifySignedIntent(SECRET, '', 'k1')).rejects.toMatchObject({
      code: 'invalid_format',
    });
  });

  it('rejects token signed with a different secret', async () => {
    const token = await createSignedIntent(SECRET, { kind: 'k1' }, 60);
    await expect(
      verifySignedIntent('different-secret', token, 'k1'),
    ).rejects.toMatchObject({ code: 'invalid_signature' });
  });

  it('SignedIntentError is thrown', async () => {
    try {
      await verifySignedIntent(SECRET, 'not.a.token.at.all', 'k1');
    } catch (err) {
      expect(err).toBeInstanceOf(SignedIntentError);
      return;
    }
    throw new Error('did not throw');
  });

  it('createAgeIntent / verifyAgeIntent round-trip', async () => {
    const token = await createAgeIntent(env());
    const payload = await verifyAgeIntent(env(), token);
    expect(payload.kind).toBe('age_13_plus_intent');
  });
});
