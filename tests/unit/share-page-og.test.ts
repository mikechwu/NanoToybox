/**
 * Tests for functions/c/[code].ts share-page HTML route (spec §9, §13).
 *
 * Validates AC #1, #13, #15:
 *   - og:image / twitter:image emitted for accessible capsule when flag on
 *   - og:image absent when flag off (pre-V1 behavior)
 *   - "AtomDojo" (no space) drift removed
 */

import { describe, it, expect } from 'vitest';
import { onRequestGet } from '../../functions/c/[code]';
import type { CapsuleShareRow } from '../../src/share/share-record';

function makeRow(over: Partial<CapsuleShareRow> = {}): CapsuleShareRow {
  return {
    id: 'id-1',
    share_code: '7M4K2D8Q9T1V',
    status: 'ready',
    owner_user_id: 'u',
    object_key: 'capsules/x/capsule.atomdojo',
    format: 'atomdojo-history',
    version: 1,
    kind: 'capsule',
    app_version: '0.1.0',
    sha256: 'abc',
    size_bytes: 100,
    frame_count: 60,
    atom_count: 32,
    max_atom_count: 32,
    duration_ps: 1.0,
    has_appearance: 0,
    has_interaction: 0,
    title: null,
    preview_status: 'pending',
    preview_poster_key: null,
    preview_motion_key: null,
    created_at: '2026-04-13T00:00:00Z',
    uploaded_at: '2026-04-13T00:00:00Z',
    published_at: '2026-04-13T00:00:00Z',
    last_accessed_at: null,
    rejection_reason: null,
    ...over,
  };
}

function makeContext(row: CapsuleShareRow | null, flag?: string) {
  return {
    env: {
      DB: {
        prepare: () => ({ bind: () => ({ first: async () => row }) }),
      },
      CAPSULE_PREVIEW_DYNAMIC_FALLBACK: flag,
    } as any,
    request: new Request('https://example.com/c/7M4K2D8Q9T1V'),
    params: { code: '7M4K2D8Q9T1V' },
    waitUntil: () => {},
    next: () => new Response(),
    data: {},
  } as any;
}

describe('GET /c/:code', () => {
  it('AC#1: flag on + accessible row → emits og:image, twitter:image, summary_large_image', async () => {
    const res = await onRequestGet(makeContext(makeRow(), 'on'));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('property="og:image"');
    expect(html).toContain('property="og:image:width" content="1200"');
    expect(html).toContain('property="og:image:height" content="630"');
    expect(html).toContain('property="og:image:alt"');
    expect(html).toContain('name="twitter:card" content="summary_large_image"');
    expect(html).toContain('name="twitter:image:alt"');
    // Absolute URL
    expect(html).toMatch(/og:image" content="https:\/\/example\.com\/api\/capsules\/7M4K2D8Q9T1V\/preview\/poster\?v=t\d+"/);
  });

  it('AC#13: flag off + accessible row without stored asset → no og:image, summary card', async () => {
    const res = await onRequestGet(makeContext(makeRow(), 'off'));
    const html = await res.text();
    expect(html).not.toContain('property="og:image"');
    expect(html).toContain('name="twitter:card" content="summary"');
  });

  it('flag on + stored asset → og:image with stored cache key (?v=p…)', async () => {
    const res = await onRequestGet(
      makeContext(
        makeRow({
          preview_status: 'ready',
          preview_poster_key: 'capsules/abcdef0123/preview-poster.png',
        }),
        'on',
      ),
    );
    const html = await res.text();
    expect(html).toMatch(/og:image" content="https:\/\/example\.com\/api\/capsules\/7M4K2D8Q9T1V\/preview\/poster\?v=p[0-9a-f]{8}"/);
  });

  it('AC#15: no "AtomDojo" (no-space) drift in user-visible output', async () => {
    const res = await onRequestGet(makeContext(makeRow(), 'on'));
    const html = await res.text();
    expect(html).not.toMatch(/\bAtomDojo\b/);
    // canonical brand uses the space
    expect(html).toContain('Atom Dojo');
  });

  it('inaccessible row → 404', async () => {
    const res = await onRequestGet(makeContext(makeRow({ status: 'rejected' }), 'on'));
    expect(res.status).toBe(404);
  });

  it('unknown row → 404', async () => {
    const res = await onRequestGet(makeContext(null, 'on'));
    expect(res.status).toBe(404);
  });
});
