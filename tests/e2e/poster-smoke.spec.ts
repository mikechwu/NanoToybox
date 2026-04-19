/**
 * Capsule preview poster — Pages-dev smoke (spec §Dependency addition).
 *
 * Three deterministic checks against the real Cloudflare runtime
 * (`wrangler pages dev`):
 *
 *   (a) Module-load probe: GET an unknown share code and assert 404. This
 *       only proves the route module's *top-level* imports resolve under
 *       workerd (`Env` types, share-record import, etc.). It does NOT
 *       reach the lazy `_lib/capsule-preview-image` import or Satori.
 *
 *   (b) Static asset: `/og-fallback.png` is reachable and its PNG header
 *       reports exactly 1200×630. Catches public/ asset-bundling
 *       regressions.
 *
 *   (c) Real dynamic render: seed the checked-in fixture via the local-
 *       only admin endpoint, then GET the dynamic poster. Asserts 200,
 *       `image/png`, valid PNG signature, and IHDR width/height of
 *       1200×630. This is the test that actually exercises the lazy
 *       import, font asset, and `ImageResponse`/Satori path.
 *
 * Skipped under the static `vite preview` lane.
 *
 * The pages-dev wrangler is launched with `--binding DEV_ADMIN_ENABLED=true`
 * (see playwright.pages-dev.config.ts) so (c) is a deterministic gate,
 * not a "skips when env is not prepared" probe.
 */

import { test, expect } from '@playwright/test';
import path from 'path';
import fs from 'fs';

const PAGES_DEV = 'pages-dev';
const FIXTURE_PATH = path.join(__dirname, 'fixtures', 'poster-smoke-capsule.json');

function assertPngDimensions(body: Buffer, width: number, height: number) {
  // PNG magic
  expect(body.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe(true);
  // IHDR is always immediately after the signature: width @16, height @20 BE u32
  expect(body.readUInt32BE(16)).toBe(width);
  expect(body.readUInt32BE(20)).toBe(height);
}

test.describe('Capsule preview poster — pages-dev smoke', () => {
  test.beforeEach(({}, testInfo) => {
    test.skip(
      testInfo.project.name !== PAGES_DEV,
      'Requires wrangler pages dev — skipped under the static preview lane',
    );
  });

  test('poster route module loads (unknown code → 404, no top-level import failure)', async ({ request, baseURL }) => {
    const res = await request.get(`${baseURL}/api/capsules/UNKNOWN0CODE/preview/poster`);
    expect(res.status()).toBe(404);
  });

  test('/og-fallback.png is bundled and is a 1200×630 PNG', async ({ request, baseURL }) => {
    const res = await request.get(`${baseURL}/og-fallback.png`);
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toMatch(/^image\/png/i);
    assertPngDimensions(Buffer.from(await res.body()), 1200, 630);
  });

  test('seeded capsule → dynamic Satori render returns 1200×630 PNG', async ({ request, baseURL }) => {
    // Deterministic: pages-dev wrangler is launched with
    // DEV_ADMIN_ENABLED:true (playwright.pages-dev.config.ts), so the
    // admin seed endpoint is reachable from localhost. If this fails, the
    // pages-dev environment was misconfigured — that is a real failure,
    // not a "skip when env not prepared" surface.
    const fixtureBody = fs.readFileSync(FIXTURE_PATH, 'utf8');
    const seed = await request.post(`${baseURL}/api/admin/seed`, {
      data: fixtureBody,
      headers: { 'Content-Type': 'application/json' },
    });
    expect(seed.status(), `seed should succeed (admin gate enabled?). body=${await seed.text()}`).toBe(200);
    const { shareCode } = (await seed.json()) as { shareCode: string };
    expect(shareCode).toMatch(/^[A-Z0-9]{12}$/);

    // The seeded row has preview_status='none' (no Satori-side stored
    // asset), so the route lands in the dynamic-fallback branch — the
    // exact path that lazy-imports _lib/capsule-preview-image.
    const poster = await request.get(`${baseURL}/api/capsules/${shareCode}/preview/poster`);
    expect(poster.status()).toBe(200);
    expect(poster.headers()['content-type']).toMatch(/^image\/png/i);
    expect(poster.headers()['cache-control']).toMatch(/max-age=300/);
    expect(poster.headers()['etag']).toMatch(/^"v\d+-[0-9a-f]{8}"$/);
    const body = Buffer.from(await poster.body());
    expect(body.length).toBeGreaterThan(1000); // sanity — not the 1×1 fallback
    assertPngDimensions(body, 1200, 630);
  });
});
