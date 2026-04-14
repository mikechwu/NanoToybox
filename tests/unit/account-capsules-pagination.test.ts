/**
 * Tests for cursor pagination on /api/account/capsules.
 *
 * Most importantly: cursor base64url decoding must restore the padding
 * the encoder strips. atob() in Workers / strict runtimes rejects
 * unpadded base64 inputs whose length is not a multiple of 4, so a
 * cursor encoded from a typical timestamp+code (length 33 bytes raw →
 * 44 chars unpadded base64) would silently become a 400 "Invalid
 * cursor" without the fix.
 *
 * We exercise the encoder via the endpoint (calling onRequestGet to get
 * a real `nextCursor` token), then feed that token back in and assert
 * the second page proceeds without a 400.
 */

import { describe, it, expect, vi } from 'vitest';
import { onRequestGet } from '../../functions/api/account/capsules/index';
import type { Env } from '../../functions/env';

vi.mock('../../functions/auth-middleware', () => ({
  authenticateRequest: async () => 'user-1',
}));

interface Row {
  share_code: string;
  created_at: string;
  size_bytes: number;
  frame_count: number;
  atom_count: number;
  title: string | null;
  kind: string;
  status: string;
  preview_status: string;
}

function makeDb(allRows: Row[]) {
  // Approximates the keyset behaviour used by the real D1 query: bind
  // shape is either (userId, LIMIT) for the first page or
  // (userId, createdAt, createdAt, shareCode, LIMIT) for cursor pages.
  const prepare = (sql: string) => ({
    _binds: [] as unknown[],
    bind(...vs: unknown[]) { this._binds = vs; return this; },
    async run() { return { success: true }; },
    async first<T = unknown>(): Promise<T | null> { return null; },
    async all<T = unknown>() {
      const isCursorPage = this._binds.length === 5;
      const limit = Number(this._binds[this._binds.length - 1]);
      let pool = [...allRows].sort((a, b) => {
        if (a.created_at !== b.created_at) return a.created_at < b.created_at ? 1 : -1;
        return a.share_code < b.share_code ? 1 : -1;
      });
      if (isCursorPage) {
        const createdAt = String(this._binds[1]);
        const shareCode = String(this._binds[3]);
        pool = pool.filter((r) =>
          r.created_at < createdAt ||
          (r.created_at === createdAt && r.share_code < shareCode),
        );
      }
      return { success: true, results: pool.slice(0, limit) as unknown as T[] };
    },
  });
  return { prepare, async batch() { return []; } } as unknown as Env['DB'];
}

function row(shareCode: string, createdAt: string): Row {
  return {
    share_code: shareCode,
    created_at: createdAt,
    size_bytes: 1,
    frame_count: 0,
    atom_count: 0,
    title: null,
    kind: 'snapshot',
    status: 'ready',
    preview_status: 'none',
  };
}

function context(url: string, db: Env['DB']) {
  const request = new Request(url);
  return { request, env: { DB: db } as unknown as Env } as unknown as Parameters<typeof onRequestGet>[0];
}

describe('GET /api/account/capsules — cursor pagination', () => {
  it('round-trips a cursor whose unpadded base64 length is not divisible by 4', async () => {
    // 60 unique rows (>50 page size) so the first page returns a real
    // nextCursor that exercises the encoder/decoder pair.
    const rows: Row[] = [];
    for (let i = 0; i < 60; i++) {
      const seq = String(i).padStart(3, '0');
      rows.push(row(`SHARECODE${seq}`, `2026-04-14T10:${seq.slice(0, 2)}:00.${seq.slice(2)}Z`));
    }
    const db = makeDb(rows);

    const first = await onRequestGet(context('https://x.test/api/account/capsules', db));
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as {
      capsules: Array<{ shareCode: string }>;
      hasMore: boolean;
      nextCursor: string | null;
    };
    expect(firstBody.hasMore).toBe(true);
    expect(firstBody.nextCursor).not.toBeNull();
    expect(firstBody.capsules.length).toBe(50);

    // The encoder strips '=' padding. A 33-byte raw payload (e.g.
    // "2026-04-14T10:01:00.001Z|SHARECODE001") maps to 44 unpadded
    // chars (length % 4 === 0 → no padding needed), but a 32-byte
    // payload would be 43 chars (length % 4 === 3, requires one '=').
    // Either way, the decoder must accept the unpadded form.
    const cursor = firstBody.nextCursor!;
    expect(cursor.length % 4).not.toBe(0); // sanity: this fixture exercises the unpadded case

    const second = await onRequestGet(
      context(`https://x.test/api/account/capsules?cursor=${encodeURIComponent(cursor)}`, db),
    );
    expect(second.status).toBe(200); // would be 400 without the padding fix
    const secondBody = (await second.json()) as {
      capsules: Array<{ shareCode: string }>;
      hasMore: boolean;
    };
    expect(secondBody.capsules.length).toBe(10); // 60 total − 50 first page
    expect(secondBody.hasMore).toBe(false);

    // No row appears on both pages (keyset seek correctness check).
    const firstSet = new Set(firstBody.capsules.map((c) => c.shareCode));
    for (const c of secondBody.capsules) {
      expect(firstSet.has(c.shareCode), `duplicate code across pages: ${c.shareCode}`).toBe(false);
    }
  });

  it('returns 400 for a genuinely malformed cursor', async () => {
    const db = makeDb([row('AAA', '2026-04-14T10:00:00Z')]);
    const res = await onRequestGet(
      context('https://x.test/api/account/capsules?cursor=%21%21%21not-a-token%21%21%21', db),
    );
    expect(res.status).toBe(400);
  });

  it('first page (no cursor) returns hasMore=false when results fit in one page', async () => {
    const db = makeDb([row('AAA', '2026-04-14T10:00:00Z')]);
    const res = await onRequestGet(context('https://x.test/api/account/capsules', db));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { capsules: unknown[]; hasMore: boolean; nextCursor: string | null };
    expect(body.capsules.length).toBe(1);
    expect(body.hasMore).toBe(false);
    expect(body.nextCursor).toBeNull();
  });
});
