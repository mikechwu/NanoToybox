/**
 * Playwright config — Pages-dev lane.
 *
 * The default `playwright.config.ts` runs the suite against
 * `vite preview` (a static file server). That's fast and covers the
 * static surfaces (privacy/, terms/, account/ shell, smoke routing),
 * but it CANNOT exercise:
 *
 *   - the Pages Functions in `functions/api/...` (the OAuth start
 *     routes, the publish 428 path, the account API, the
 *     privacy-request endpoint)
 *   - the redirects emitted by those routes
 *   - the popup-complete handshake which requires real network paths
 *
 * Anything that depends on a live backend goes through `wrangler
 * pages dev` instead. This config wires that lane up so the
 * transfer/auth path can be exercised end-to-end before deploy.
 *
 * Treated as a deployment-confidence layer (run locally before a
 * release) — NOT wired into the default `npm run test:e2e` to avoid
 * forcing every contributor to install wrangler. Invoke with:
 *
 *     npm run test:e2e:pages-dev
 *
 * Prereqs:
 *   - wrangler installed (`npx wrangler --version` works)
 *   - SESSION_SECRET set in `.dev.vars` (or the wrangler default
 *     dev environment) so signed-intent endpoints work
 *
 * Specs that are gated on the Pages-dev lane (currently a single
 * placeholder + the static suite) can opt in via:
 *
 *     test.skip(test.info().project.name !== 'pages-dev', ...)
 */

import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 60_000,
  use: {
    baseURL: 'http://127.0.0.1:8788',
    headless: true,
  },
  webServer: {
    // `wrangler pages dev` serves dist/ over a real Pages runtime,
    // including all functions/* handlers + cookie semantics.
    command: 'npx wrangler pages dev dist --port 8788 --ip 127.0.0.1',
    url: 'http://127.0.0.1:8788/lab/',
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
  projects: [
    { name: 'pages-dev', use: { browserName: 'chromium' } },
  ],
});
