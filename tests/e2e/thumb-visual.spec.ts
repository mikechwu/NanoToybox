/**
 * Browser-level visual regression for the account-row thumbnail.
 *
 * The vitest render gate (`tests/unit/current-thumb-render.test.tsx`)
 * locks the SVG source AND regenerates an HTML harness per named
 * fixture under `tests/e2e/fixtures/thumb-visual/` on every pass.
 * This spec navigates to each harness via `file://`, screenshots
 * the 96 × 96 thumb cell, and compares to a committed baseline PNG.
 *
 * Why the harness-file indirection: Playwright's test loader wraps
 * imported modules (adds a `__pw_type` fixture layer) which collides
 * with React's element equality checks. Routing through a
 * pre-rendered HTML file keeps React + SSR entirely inside the
 * vitest pass, where they work normally. There is no snapshot-text
 * scraping — both gates pin to the same code path via the shared
 * `src/share/__fixtures__/thumb-visual-fixtures.tsx` helper.
 *
 * ## Platform-baseline policy (current state)
 *
 * Committed baselines under
 * `tests/e2e/thumb-visual.spec.ts-snapshots/` are Chromium + Darwin
 * only. Running the spec on Linux (CI) will treat a missing
 * `*-chromium-linux.png` as "baseline missing" and write it on
 * `--update-snapshots`. The cross-platform strategy is deliberately
 * **local/manual**: this spec is a local review gate for operators
 * working on the preview pipeline on macOS; Linux CI baselines can
 * be added when the repo adds a pinned CI image, via
 * `npm run test:e2e -- thumb-visual.spec.ts --update-snapshots`
 * from that environment.
 *
 * Running:
 *   npm run test:e2e -- thumb-visual.spec.ts
 *   npm run test:e2e -- thumb-visual.spec.ts --update-snapshots
 */

import { test, expect } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

const HARNESS_DIR = path.resolve(__dirname, 'fixtures', 'thumb-visual');

type FixtureName = 'c60' | 'graphene' | 'glycine';
const FIXTURES: FixtureName[] = ['c60', 'graphene', 'glycine'];

async function gotoHarness(
  page: import('@playwright/test').Page,
  fixture: FixtureName,
): Promise<void> {
  const harness = path.join(HARNESS_DIR, `${fixture}.html`);
  if (!fs.existsSync(harness)) {
    throw new Error(
      `harness missing: ${harness}\n`
        + `run the vitest render gate first: `
        + `\`npx vitest run tests/unit/current-thumb-render.test.tsx\``,
    );
  }
  await page.goto(pathToFileURL(harness).href, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#thumb-host')).toBeVisible();
}

test.describe('account-row thumb — browser-level visual regression', () => {
  for (const fixture of FIXTURES) {
    test(`${fixture} thumb renders consistently at the shipped size`, async ({ page }) => {
      await gotoHarness(page, fixture);
      await expect(page.locator('#thumb-host')).toHaveScreenshot(
        `${fixture}.png`,
        { maxDiffPixelRatio: 0.02 },
      );
    });
  }
});
