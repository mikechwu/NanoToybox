/**
 * Tests for functions/api/account/capsules/[code]/index.ts — owner delete.
 *
 * Critical security contract:
 *   - 404 (not 403) when a user tries to delete someone else's capsule.
 *     Returning 403 would disclose existence; the 404 makes a wrong-owner
 *     response indistinguishable from a missing code.
 *   - 401 when unauthenticated.
 *   - Owner-matched: delegates to shared core with actor='owner'.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { onRequestDelete } from '../../functions/api/account/capsules/[code]/index';
import type { Env } from '../../functions/env';

const authMock = vi.hoisted(() => vi.fn<(...args: unknown[]) => Promise<string | null>>());
vi.mock('../../functions/auth-middleware', () => ({
  authenticateRequest: (...args: unknown[]) => authMock(...args),
}));

const deleteMock = vi.hoisted(() => vi.fn());
vi.mock('../../src/share/capsule-delete', () => ({
  deleteCapsule: (...args: unknown[]) => deleteMock(...args),
}));

function makeDb(ownerRow: { owner_user_id: string | null } | null) {
  const prepare = (_sql: string) => ({
    bind() { return this; },
    async run() { return { success: true }; },
    async first<T = unknown>(): Promise<T | null> { return ownerRow as unknown as T; },
    async all<T = unknown>() { return { success: true, results: [] as T[] }; },
  });
  return { prepare, async batch() { return []; } } as unknown as Env['DB'];
}

function makeContext(args: { code: string; ownerRow: { owner_user_id: string | null } | null }) {
  const request = new Request(`https://example.test/api/account/capsules/${args.code}`, {
    method: 'DELETE',
  });
  const env: Env = {
    DB: makeDb(args.ownerRow),
    R2_BUCKET: {
      async delete() {},
    } as unknown as Env['R2_BUCKET'],
  } as Env;
  return { request, env, params: { code: args.code } } as unknown as Parameters<typeof onRequestDelete>[0];
}

beforeEach(() => {
  authMock.mockReset();
  deleteMock.mockReset();
});

describe('owner delete endpoint', () => {
  it('401 when unauthenticated', async () => {
    authMock.mockResolvedValue(null);
    const res = await onRequestDelete(makeContext({ code: 'ABCDEFGHJKMN', ownerRow: null }));
    expect(res.status).toBe(401);
  });

  it('404 when the code is unknown', async () => {
    authMock.mockResolvedValue('user-1');
    const res = await onRequestDelete(makeContext({ code: 'ABCDEFGHJKMN', ownerRow: null }));
    expect(res.status).toBe(404);
    expect(deleteMock).not.toHaveBeenCalled();
  });

  it('404 (not 403) when another user owns the capsule — no existence disclosure', async () => {
    authMock.mockResolvedValue('user-A');
    const res = await onRequestDelete(
      makeContext({ code: 'ABCDEFGHJKMN', ownerRow: { owner_user_id: 'user-B' } }),
    );
    expect(res.status).toBe(404);
    expect(deleteMock).not.toHaveBeenCalled();
  });

  it('owner match → delegates to shared core with actor=owner + userId', async () => {
    authMock.mockResolvedValue('user-1');
    deleteMock.mockResolvedValue({
      shareId: 's1',
      shareCode: 'ABCDEFGHJKMN',
      alreadyDeleted: false,
      r2Deleted: true,
    });
    const res = await onRequestDelete(
      makeContext({ code: 'ABCDEFGHJKMN', ownerRow: { owner_user_id: 'user-1' } }),
    );
    expect(res.status).toBe(200);
    const payload = (await res.json()) as Record<string, unknown>;
    expect(payload.shareCode).toBe('ABCDEFGHJKMN');
    expect(payload.status).toBe('deleted');
    expect(deleteMock).toHaveBeenCalledTimes(1);
    const opts = deleteMock.mock.calls[0][2] as Record<string, unknown>;
    expect(opts.actor).toBe('owner');
    expect(opts.userId).toBe('user-1');
  });
});
