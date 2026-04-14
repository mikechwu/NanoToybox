/**
 * Handler-level tests for functions/api/admin/sweep/orphans.ts.
 *
 * Covers:
 *   - admin gate
 *   - recent objects (< 24h) are preserved
 *   - objects with a matching D1 row are preserved (not orphans)
 *   - dry-run returns candidate list without deleting
 *   - max parameter bounds the delete count
 *   - per-deletion audit event written
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { onRequestPost } from '../../functions/api/admin/sweep/orphans';
import type { Env } from '../../functions/env';

const recordMock = vi.hoisted(() => vi.fn<(...args: unknown[]) => Promise<string>>());
vi.mock('../../src/share/audit', async () => {
  const actual = await vi.importActual<typeof import('../../src/share/audit')>('../../src/share/audit');
  return {
    ...actual,
    recordAuditEvent: (...args: unknown[]) => recordMock(...args),
  };
});

// ── Mocks ──────────────────────────────────────────────────────────────────

interface R2Object {
  key: string;
  uploaded: Date;
}

function makeR2(objects: R2Object[]) {
  const deletedKeys: string[] = [];
  const bucket = {
    async list() {
      return {
        objects: objects.filter((o) => !deletedKeys.includes(o.key)),
        truncated: false,
        delimitedPrefixes: [],
      };
    },
    async delete(key: string) {
      deletedKeys.push(key);
    },
    async get() { return null; },
    async put() { return undefined; },
    _deletedKeys: deletedKeys,
  };
  return bucket as unknown as Env['R2_BUCKET'] & { _deletedKeys: string[] };
}

/** D1 mock — rows with object_key in `matchingKeys` report hit=1. */
function makeDb(matchingKeys: Set<string>) {
  const prepare = (_sql: string) => ({
    _binds: [] as unknown[],
    bind(...values: unknown[]) {
      this._binds = values;
      return this;
    },
    async run() { return { success: true }; },
    async first<T = unknown>(): Promise<T | null> {
      const [key] = this._binds as [string];
      return matchingKeys.has(key) ? ({ hit: 1 } as T) : null;
    },
    async all<T = unknown>() {
      return { success: true, results: [] as T[] };
    },
  });
  return { prepare, async batch() { return []; } } as unknown as Env['DB'];
}

function makeContext(args: {
  objects: R2Object[];
  matchingKeys?: Set<string>;
  query?: string;
  hostname?: string;
  env?: Partial<Env>;
}) {
  const hostname = args.hostname ?? 'localhost';
  const url = `http://${hostname}/api/admin/sweep/orphans${args.query ? '?' + args.query : ''}`;
  const request = new Request(url, { method: 'POST' });
  const r2 = makeR2(args.objects);
  const env: Env = {
    DB: makeDb(args.matchingKeys ?? new Set()),
    R2_BUCKET: r2,
    DEV_ADMIN_ENABLED: 'true',
    ...args.env,
  };
  return {
    request,
    env,
    params: {},
    _r2: r2,
  } as unknown as Parameters<typeof onRequestPost>[0] & { _r2: typeof r2 };
}

function daysAgo(days: number): Date {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('admin orphan sweep', () => {
  beforeEach(() => {
    recordMock.mockReset();
    recordMock.mockResolvedValue('audit-id');
  });
  afterEach(() => vi.clearAllMocks());

  it('returns 404 when admin gate denies', async () => {
    const res = await onRequestPost(
      makeContext({
        objects: [],
        env: { DEV_ADMIN_ENABLED: undefined },
      }),
    );
    expect(res.status).toBe(404);
  });

  it('skips objects younger than 24h (safety threshold)', async () => {
    const ctx = makeContext({
      objects: [
        { key: 'capsules/fresh/capsule.atomdojo', uploaded: daysAgo(0.5) }, // 12h — too new
        { key: 'capsules/very-fresh/capsule.atomdojo', uploaded: new Date() }, // now
      ],
    });
    const res = await onRequestPost(ctx);
    const payload = (await res.json()) as Record<string, unknown>;
    expect(payload.scanned).toBe(2);
    expect(payload.candidates).toBe(0);
    expect(payload.deleted).toBe(0);
    expect(ctx._r2._deletedKeys).toEqual([]);
    expect(recordMock).not.toHaveBeenCalled();
  });

  it('skips objects with a matching D1 row (not orphans)', async () => {
    const ctx = makeContext({
      objects: [{ key: 'capsules/has-row/capsule.atomdojo', uploaded: daysAgo(2) }],
      matchingKeys: new Set(['capsules/has-row/capsule.atomdojo']),
    });
    const res = await onRequestPost(ctx);
    const payload = (await res.json()) as Record<string, unknown>;
    expect(payload.candidates).toBe(0);
    expect(payload.deleted).toBe(0);
    expect(ctx._r2._deletedKeys).toEqual([]);
  });

  it('deletes orphaned objects older than 24h and writes an audit event per deletion', async () => {
    const ctx = makeContext({
      objects: [
        { key: 'capsules/orphan-a/capsule.atomdojo', uploaded: daysAgo(2) },
        { key: 'capsules/orphan-b/capsule.atomdojo', uploaded: daysAgo(3) },
        { key: 'capsules/recent/capsule.atomdojo', uploaded: daysAgo(0.1) }, // too new
      ],
    });
    const res = await onRequestPost(ctx);
    const payload = (await res.json()) as Record<string, unknown>;
    expect(payload.scanned).toBe(3);
    expect(payload.candidates).toBe(2);
    expect(payload.deleted).toBe(2);
    expect(new Set(ctx._r2._deletedKeys)).toEqual(
      new Set(['capsules/orphan-a/capsule.atomdojo', 'capsules/orphan-b/capsule.atomdojo']),
    );

    // One audit event per deletion.
    expect(recordMock).toHaveBeenCalledTimes(2);
    for (const call of recordMock.mock.calls) {
      const input = call[1] as unknown as Record<string, unknown>;
      expect(input.eventType).toBe('orphan_swept');
      expect(input.actor).toBe('sweeper');
    }
  });

  it('dry=1 returns candidate list without deleting', async () => {
    const ctx = makeContext({
      objects: [
        { key: 'capsules/orphan-a/capsule.atomdojo', uploaded: daysAgo(2) },
        { key: 'capsules/orphan-b/capsule.atomdojo', uploaded: daysAgo(3) },
      ],
      query: 'dry=1',
    });
    const res = await onRequestPost(ctx);
    const payload = (await res.json()) as Record<string, unknown>;
    expect(payload.dryRun).toBe(true);
    expect(payload.candidates).toBe(2);
    // deleted length matches candidate count, but R2 was never touched.
    expect(payload.deleted).toBe(2);
    expect(ctx._r2._deletedKeys).toEqual([]);
    // No audit events in dry-run either.
    expect(recordMock).not.toHaveBeenCalled();
  });

  it('max=N bounds the delete count (extra orphans remain as candidates)', async () => {
    const ctx = makeContext({
      objects: [
        { key: 'capsules/a/capsule.atomdojo', uploaded: daysAgo(2) },
        { key: 'capsules/b/capsule.atomdojo', uploaded: daysAgo(2) },
        { key: 'capsules/c/capsule.atomdojo', uploaded: daysAgo(2) },
        { key: 'capsules/d/capsule.atomdojo', uploaded: daysAgo(2) },
      ],
      query: 'max=2',
    });
    const res = await onRequestPost(ctx);
    const payload = (await res.json()) as Record<string, unknown>;
    expect(payload.deleted).toBe(2);
    expect(ctx._r2._deletedKeys.length).toBe(2);
  });

  it('survives a missing obj.uploaded (treats as new → preserves)', async () => {
    const ctx = makeContext({
      objects: [
        // Simulate an R2 API contract change where `uploaded` is missing.
        { key: 'capsules/weird/capsule.atomdojo', uploaded: undefined as unknown as Date },
      ],
    });
    const res = await onRequestPost(ctx);
    const payload = (await res.json()) as Record<string, unknown>;
    expect(payload.deleted).toBe(0);
    expect(ctx._r2._deletedKeys).toEqual([]);
  });
});
