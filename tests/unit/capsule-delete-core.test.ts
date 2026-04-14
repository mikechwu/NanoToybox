/**
 * Tests for src/share/capsule-delete.ts — shared delete core.
 *
 * Covers the contract used by BOTH admin moderation and owner self-service:
 *   - unknown code → null (caller 404s)
 *   - fresh delete: status flipped, content fields NULLed, object_key cleared
 *   - R2 success clears object_key; R2 failure leaves object_key intact
 *   - already-deleted: still re-attempts R2, emits audit with alreadyDeleted=true
 *   - actor='admin' → audit event_type='moderation_delete', actor='admin'
 *   - actor='owner' → audit event_type='owner_delete', actor=<userId>
 *   - R2 failure escalates audit severity='critical'
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { deleteCapsule } from '../../src/share/capsule-delete';

const recordMock = vi.hoisted(() => vi.fn<(...args: unknown[]) => Promise<string>>());
vi.mock('../../src/share/audit', async () => {
  const actual = await vi.importActual<typeof import('../../src/share/audit')>('../../src/share/audit');
  return { ...actual, recordAuditEvent: (...args: unknown[]) => recordMock(...args) };
});

interface FakeRow {
  id: string;
  share_code: string;
  status: string;
  object_key: string | null;
}

function makeEnv(row: FakeRow | null, r2Fails = false) {
  const updates: Array<{ sql: string; binds: unknown[] }> = [];
  const deletedKeys: string[] = [];
  const prepare = (sql: string) => ({
    _binds: [] as unknown[],
    bind(...vs: unknown[]) { this._binds = vs; return this; },
    async run() { updates.push({ sql, binds: this._binds }); return { success: true }; },
    async first<T = unknown>(): Promise<T | null> { return row as unknown as T; },
    async all<T = unknown>() { return { success: true, results: [] as T[] }; },
  });
  const env = {
    DB: { prepare, async batch() { return []; } },
    R2_BUCKET: {
      async delete(k: string) {
        if (r2Fails) throw new Error('r2 boom');
        deletedKeys.push(k);
      },
    },
    _updates: updates,
    _deletedKeys: deletedKeys,
  };
  return env;
}

beforeEach(() => {
  recordMock.mockReset();
  recordMock.mockResolvedValue('audit-id');
});

describe('deleteCapsule', () => {
  it('returns null when the code is unknown', async () => {
    const env = makeEnv(null);
    const result = await deleteCapsule(env, 'ABCDEFGHJKMN', { actor: 'admin' });
    expect(result).toBeNull();
    expect(recordMock).not.toHaveBeenCalled();
  });

  it('admin fresh delete: flips status + NULLs content fields + clears object_key + audit warning', async () => {
    const env = makeEnv({
      id: 's1',
      share_code: 'ABCDEFGHJKMN',
      status: 'ready',
      object_key: 'capsules/s1/c.atomdojo',
    });
    const result = await deleteCapsule(env, 'ABCDEFGHJKMN', {
      actor: 'admin',
      reason: 'spam',
    });
    expect(result).toMatchObject({
      alreadyDeleted: false,
      r2Deleted: true,
      shareCode: 'ABCDEFGHJKMN',
    });
    expect(env._deletedKeys).toEqual(['capsules/s1/c.atomdojo']);
    // UPDATE for status flip (contains content-field NULLs) + UPDATE to clear object_key
    const sqls = env._updates.map((u) => u.sql);
    expect(sqls.some((s) => s.includes("status             = 'deleted'"))).toBe(true);
    expect(sqls.some((s) => s.includes('object_key = NULL'))).toBe(true);
    expect(recordMock).toHaveBeenCalledTimes(1);
    const input = recordMock.mock.calls[0][1] as Record<string, unknown>;
    expect(input.eventType).toBe('moderation_delete');
    expect(input.actor).toBe('admin');
    expect(input.severity).toBe('warning');
  });

  it('owner fresh delete: event_type=owner_delete, actor=<userId>', async () => {
    const env = makeEnv({
      id: 's1',
      share_code: 'ABCDEFGHJKMN',
      status: 'ready',
      object_key: 'capsules/s1/c.atomdojo',
    });
    await deleteCapsule(env, 'ABCDEFGHJKMN', { actor: 'owner', userId: 'user-42' });
    const input = recordMock.mock.calls[0][1] as Record<string, unknown>;
    expect(input.eventType).toBe('owner_delete');
    expect(input.actor).toBe('user-42');
  });

  it('R2 failure: r2Deleted=false, severity=critical, object_key retained', async () => {
    const env = makeEnv(
      {
        id: 's1',
        share_code: 'ABCDEFGHJKMN',
        status: 'ready',
        object_key: 'capsules/s1/c.atomdojo',
      },
      true,
    );
    const result = await deleteCapsule(env, 'ABCDEFGHJKMN', { actor: 'admin' });
    expect(result?.r2Deleted).toBe(false);
    expect(result?.r2Error).toContain('r2 boom');
    // object_key is NOT cleared on R2 failure.
    const sqls = env._updates.map((u) => u.sql);
    expect(sqls.some((s) => s.includes('object_key = NULL'))).toBe(false);
    const input = recordMock.mock.calls[0][1] as Record<string, unknown>;
    expect(input.severity).toBe('critical');
  });

  it('idempotent retry on already-deleted row: still re-attempts R2, audit marks alreadyDeleted=true', async () => {
    const env = makeEnv({
      id: 's1',
      share_code: 'ABCDEFGHJKMN',
      status: 'deleted',
      object_key: 'capsules/s1/c.atomdojo',
    });
    const result = await deleteCapsule(env, 'ABCDEFGHJKMN', { actor: 'owner', userId: 'u1' });
    expect(result?.alreadyDeleted).toBe(true);
    expect(result?.r2Deleted).toBe(true);
    expect(env._deletedKeys).toEqual(['capsules/s1/c.atomdojo']);
    const details = (recordMock.mock.calls[0][1] as { details: Record<string, unknown> }).details;
    expect(details.alreadyDeleted).toBe(true);
  });
});
