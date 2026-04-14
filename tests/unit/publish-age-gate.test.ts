/**
 * Test the age-gate precondition added to /api/capsules/publish.
 *
 * Contract (plan Phase B "Server-authoritative enforcement"):
 *   An authenticated user with no user_policy_acceptance row for
 *   policy_kind='age_13_plus' must receive 428 Precondition Required
 *   with the structured body `{error, message, policyVersion}` — NOT
 *   a 413/429/500. The Transfer dialog catches this parallel to 413.
 *
 * The other publish paths (quota, size, invalid capsule) already have
 * dedicated tests; this file only exercises the 428 branch.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { onRequestPost } from '../../functions/api/capsules/publish';
import type { Env } from '../../functions/env';

const authMock = vi.hoisted(() => vi.fn<(...args: unknown[]) => Promise<string | null>>());
vi.mock('../../functions/auth-middleware', () => ({
  authenticateRequest: (...args: unknown[]) => authMock(...args),
}));

function makeDb(hasAcceptance: boolean) {
  const prepare = (sql: string) => ({
    bind() { return this; },
    async run() { return { success: true }; },
    async first<T = unknown>(): Promise<T | null> {
      if (sql.includes('user_policy_acceptance')) {
        return (hasAcceptance ? ({ ok: 1 } as unknown as T) : null);
      }
      return null;
    },
    async all<T = unknown>() { return { success: true, results: [] as T[] }; },
  });
  return { prepare, async batch() { return []; } } as unknown as Env['DB'];
}

function makeContext(args: { hasAcceptance: boolean }) {
  const request = new Request('https://example.test/api/capsules/publish', {
    method: 'POST',
    body: '{}',
  });
  const env: Env = {
    DB: makeDb(args.hasAcceptance),
    R2_BUCKET: {} as unknown as Env['R2_BUCKET'],
  } as Env;
  return { request, env } as unknown as Parameters<typeof onRequestPost>[0];
}

beforeEach(() => {
  authMock.mockReset();
});

describe('/api/capsules/publish — age-gate precondition', () => {
  it('returns 428 with structured body when acceptance is missing', async () => {
    authMock.mockResolvedValue('user-42');
    const res = await onRequestPost(makeContext({ hasAcceptance: false }));
    expect(res.status).toBe(428);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe('age_confirmation_required');
    expect(typeof body.message).toBe('string');
    expect(typeof body.policyVersion).toBe('string');
  });

  it('401 when signed-out (age check never runs)', async () => {
    authMock.mockResolvedValue(null);
    const res = await onRequestPost(makeContext({ hasAcceptance: true }));
    expect(res.status).toBe(401);
  });
});
