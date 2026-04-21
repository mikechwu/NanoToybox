/**
 * Tests for the `persisted` field on {@link HealResult} success
 * variants (ADR D135 follow-up, 2026-04-21).
 *
 * The in-memory rebake and the D1 UPDATE are independent — the render
 * is already computed once the projection resolves, and the write
 * failing doesn't roll that back. `persisted` lets the caller report
 * `rebaked` (in-memory projections) and `persisted` (committed
 * writes) separately, so ops can distinguish a D1-pressure regression
 * from a rebake-logic regression.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { rebakeSceneFromR2 } from '../../src/share/capsule-preview-heal';
import { makeC60Capsule } from '../../src/share/__fixtures__/capsule-preview-structures';

interface MakeEnvOpts {
  dbThrows?: boolean;
  dbChanges?: number;
  /** When set, the returned env's `run()` omits `meta` entirely,
   *  exercising the `d1-shape-unknown` degraded-signal path. */
  dbOmitMeta?: boolean;
  /** When set, `R2_BUCKET.get()` throws instead of returning the blob,
   *  exercising the `blob-fetch-failed` outer-try/catch path. */
  r2GetThrows?: boolean;
}

function makeEnvWith(
  blob: string,
  opts: MakeEnvOpts = {},
): Parameters<typeof rebakeSceneFromR2>[0] {
  return {
    DB: {
      prepare(_sql: string) {
        return {
          bind(..._binds: unknown[]) {
            return {
              async run() {
                if (opts.dbThrows) throw new Error('D1 write pressure');
                if (opts.dbOmitMeta) return { success: true };
                // Default to `changes: 1` so a successful write is
                // reported as persisted. Tests that want to exercise
                // the zero-row branch pass `dbChanges: 0`.
                return { success: true, meta: { changes: opts.dbChanges ?? 1 } };
              },
            };
          },
        };
      },
    },
    R2_BUCKET: {
      async get(_key: string) {
        if (opts.r2GetThrows) throw new Error('R2 binding transient error');
        return { async text() { return blob; } };
      },
    },
  };
}

describe('rebakeSceneFromR2 — persisted field', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it('success + D1 write resolves → ok:true, persisted:true', async () => {
    const capsule = makeC60Capsule();
    const env = makeEnvWith(JSON.stringify(capsule));
    const result = await rebakeSceneFromR2(
      env,
      { id: 42, object_key: 'capsules/42/capsule.atomdojo' },
      { overwrite: true },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.persisted).toBe(true);
    }
  });

  it('success + D1 write throws → ok:true, persisted:false, write-failed logged', async () => {
    const capsule = makeC60Capsule();
    const env = makeEnvWith(JSON.stringify(capsule), { dbThrows: true });
    const warnSpy = vi.spyOn(console, 'warn');
    const result = await rebakeSceneFromR2(
      env,
      { id: 42, object_key: 'capsules/42/capsule.atomdojo' },
      { overwrite: true },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.persisted).toBe(false);
    }
    const logged = warnSpy.mock.calls
      .map((c) => String(c[0]))
      .find((s) => s.includes('[preview-heal] write-failed'));
    expect(logged).toBeDefined();
  });

  it('success + D1 write affects zero rows → persisted:false (concurrent-delete race)', async () => {
    // UPDATE resolves without throwing but `meta.changes === 0`
    // (e.g., the row was deleted between SELECT and UPDATE). The
    // rebake is still `ok: true` because the in-memory scene is valid,
    // but `persisted` must reflect reality so monitoring sees the
    // `rebaked > persisted` divergence.
    const capsule = makeC60Capsule();
    const env = makeEnvWith(JSON.stringify(capsule), { dbChanges: 0 });
    const result = await rebakeSceneFromR2(
      env,
      { id: 42, object_key: 'capsules/42/capsule.atomdojo' },
      { overwrite: true },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.persisted).toBe(false);
    }
  });

  it('R2 get() throws → ok:false with blob-fetch-failed reason (no uncaught throw)', async () => {
    // Regression guard for SFH #12: `env.R2_BUCKET.get(key)` can
    // throw on network / permission faults. The helper must return
    // the documented `{ok:false}` shape so the poster route and the
    // account-list background batch never see an uncaught exception
    // propagate out of `rebakeSceneFromR2`.
    const env = makeEnvWith('{}', { r2GetThrows: true });
    const result = await rebakeSceneFromR2(
      env,
      { id: 42, object_key: 'capsules/42/capsule.atomdojo' },
      { overwrite: true },
    );
    expect(result.ok).toBe(false);
    const failed = result as { ok: false; reason: string };
    expect(failed.reason).toMatch(/^blob-fetch-failed:/);
  });

  it('D1 run() returns no meta → persisted:false AND d1-shape-unknown log fires', async () => {
    // Regression guard for SFH #11: an older Workers runtime (or a
    // misbehaving mocked binding) that returns `{ success: true }`
    // with no `meta` property must degrade to `persisted=false` AND
    // emit a visible `d1-shape-unknown` warn — otherwise the
    // `rebaked > persisted` divergence alert would silently lie.
    const capsule = makeC60Capsule();
    const env = makeEnvWith(JSON.stringify(capsule), { dbOmitMeta: true });
    const warnSpy = vi.spyOn(console, 'warn');
    const result = await rebakeSceneFromR2(
      env,
      { id: 42, object_key: 'capsules/42/capsule.atomdojo' },
      { overwrite: true },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.persisted).toBe(false);
    }
    const logged = warnSpy.mock.calls
      .map((c) => String(c[0]))
      .find((s) => s.includes('[preview-heal] d1-shape-unknown'));
    expect(logged).toBeDefined();
  });

  it('non-ok paths unchanged — reason propagates, no persisted field', async () => {
    // Malformed JSON → capsule-parse-failed; result is {ok:false,reason}
    // with no persisted field regardless of overwrite semantics.
    const env = makeEnvWith('{not valid json');
    const result = await rebakeSceneFromR2(
      env,
      { id: 42, object_key: 'capsules/42/capsule.atomdojo' },
      { overwrite: true },
    );
    expect(result.ok).toBe(false);
    const failed = result as { ok: false; reason: string; persisted?: boolean };
    expect(failed.reason).toMatch(/capsule-parse-failed/);
    expect(failed.persisted).toBeUndefined();
  });
});
