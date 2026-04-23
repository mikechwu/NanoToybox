/**
 * Handler-level tests for GET /api/account/capsules/count.
 *
 * Pins:
 *   1. 401 when unauthenticated (no DB reads)
 *   2. returns `{ count: N }` for the signed-in user
 *   3. SQL WHERE includes `share_mode = 'account'` (guest rows hidden)
 *   4. SQL WHERE includes `status != 'deleted'` (tombstones hidden)
 *   5. no-store cache headers so the count stays authoritative
 */

import { describe, it, expect, vi } from 'vitest';
import { onRequestGet } from '../../functions/api/account/capsules/count';
import type { Env } from '../../functions/env';

const authMock = vi.hoisted(() => vi.fn<() => Promise<string | null>>());
vi.mock('../../functions/auth-middleware', () => ({
  authenticateRequest: (...args: unknown[]) => authMock(...args as Parameters<typeof authMock>),
}));

function makeDb(rowCount: number) {
  const capturedSql: string[] = [];
  const capturedBinds: unknown[][] = [];
  const env = {
    DB: {
      prepare(sql: string) {
        capturedSql.push(sql);
        return {
          bind(...args: unknown[]) {
            capturedBinds.push(args);
            return {
              async first() { return { count: rowCount }; },
            };
          },
        };
      },
    } as unknown as Env['DB'],
    R2_BUCKET: undefined as unknown as Env['R2_BUCKET'],
  } as Env;
  return { env, capturedSql, capturedBinds };
}

function makeContext(env: Env) {
  return {
    request: new Request('http://localhost/api/account/capsules/count'),
    env,
  } as unknown as Parameters<typeof onRequestGet>[0];
}

describe('GET /api/account/capsules/count', () => {
  it('returns 401 when unauthenticated and never touches D1', async () => {
    authMock.mockResolvedValueOnce(null);
    const { env, capturedSql } = makeDb(0);
    const res = await onRequestGet(makeContext(env));
    expect(res.status).toBe(401);
    expect(capturedSql).toEqual([]);
  });

  it('returns the COUNT(*) for the signed-in user', async () => {
    authMock.mockResolvedValueOnce('user-42');
    const { env, capturedBinds } = makeDb(7);
    const res = await onRequestGet(makeContext(env));
    expect(res.status).toBe(200);
    const body = await res.json() as { count: number };
    expect(body).toEqual({ count: 7 });
    // user id is the sole bind parameter
    expect(capturedBinds[0]).toEqual(['user-42']);
  });

  it('filters by share_mode=account so guest rows cannot inflate the count', async () => {
    authMock.mockResolvedValueOnce('user-42');
    const { env, capturedSql } = makeDb(0);
    await onRequestGet(makeContext(env));
    expect(capturedSql[0]).toMatch(/share_mode\s*=\s*'account'/);
  });

  it("excludes tombstoned rows (status != 'deleted')", async () => {
    authMock.mockResolvedValueOnce('user-42');
    const { env, capturedSql } = makeDb(0);
    await onRequestGet(makeContext(env));
    expect(capturedSql[0]).toMatch(/status\s*!=\s*'deleted'/);
  });

  it('is no-store + Vary: Cookie so the count never stales across users', async () => {
    authMock.mockResolvedValueOnce('user-42');
    const { env } = makeDb(3);
    const res = await onRequestGet(makeContext(env));
    expect(res.headers.get('Cache-Control')).toContain('no-store');
    expect(res.headers.get('Vary')).toBe('Cookie');
  });

  it('falls back to 0 when the DB row is unexpectedly null', async () => {
    authMock.mockResolvedValueOnce('user-42');
    const env = {
      DB: {
        prepare: () => ({ bind: () => ({ first: async () => null }) }),
      } as unknown as Env['DB'],
      R2_BUCKET: undefined as unknown as Env['R2_BUCKET'],
    } as Env;
    const res = await onRequestGet(makeContext(env));
    const body = await res.json() as { count: number };
    expect(body.count).toBe(0);
  });
});
