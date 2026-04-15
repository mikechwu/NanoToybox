/**
 * E2E — policy + account route surfaces (Phase 7).
 *
 * The vite preview server is a static file server, so /api/* endpoints
 * are NOT live. These tests verify ONLY the static surfaces the build
 * is responsible for emitting:
 *
 *   - /privacy/ and /terms/ render with Phase A markup
 *   - data-policy-segment="A" present, B/D/E/F absent
 *   - /account/ shell loads (will paint signed-out fallback because no API)
 *   - Cross-page links between /privacy and /terms work
 *   - The AgeClickwrapNotice (D120) renders inside the Lab Transfer dialog
 *     signed-out panel (verified separately under the unit suite for full
 *     state machine; here we just confirm the DOM hook is present)
 *
 * Future: when E2E gets a wrangler-pages-dev backend, expand this file
 * to cover age-gate + delete flows end-to-end.
 */

import { test, expect, type Page } from '@playwright/test';
import { ACTIVE_POLICY_SEGMENTS } from '../../src/policy/policy-config';

const ALL_SEGMENTS = ['A', 'B', 'C', 'D', 'E', 'F', 'G'] as const;

/**
 * Read the build-injected `<meta name="policy-active-segments">` tag
 * and verify it matches the source-of-truth (src/policy/policy-config.ts).
 * This guards against a build that didn't run the policy plugin.
 */
async function readActiveSegments(page: Page): Promise<string[]> {
  const content = await page.locator('meta[name="policy-active-segments"]').getAttribute('content');
  expect(content, 'meta[name="policy-active-segments"] missing — policyConfigPlugin not wired?').not.toBeNull();
  return content!.split(',').map((s) => s.trim()).filter(Boolean);
}

test.describe('Phase 7 — policy routes', () => {
  /**
   * Per-page contract: each page renders SOME subset of the active
   * segments (Privacy carries A/B/D/E/F; Terms carries A/B/D — there
   * is nothing the Terms page needs to say about audit retention or
   * account-deletion mechanics that doesn't belong in the Privacy
   * Policy). Both pages MUST agree on the meta tag's active list, and
   * neither page may leak a segment that's NOT in the active list.
   */

  test('/privacy injects the policy meta and renders A + every gated segment it owns', async ({ page, baseURL }) => {
    await page.goto(`${baseURL}/privacy/`);
    await expect(page.locator('h1', { hasText: 'Privacy Policy' })).toBeVisible();
    const active = await readActiveSegments(page);
    expect(active).toEqual([...ACTIVE_POLICY_SEGMENTS]);

    // Privacy is the long-form page — it carries every active segment.
    for (const seg of active) {
      const present = await page.locator(`[data-policy-segment="${seg}"]`).count();
      expect(present, `active segment ${seg} should appear on /privacy`).toBeGreaterThan(0);
    }
    // Inactive segments must NOT leak into the markup.
    for (const seg of ALL_SEGMENTS) {
      if (active.includes(seg)) continue;
      const leaked = await page.locator(`[data-policy-segment="${seg}"]`).count();
      expect(leaked, `inactive segment ${seg} must not appear on /privacy`).toBe(0);
    }
    // Verbatim affirmative statement (always required).
    await expect(page.getByText('We do not sell your personal information')).toBeVisible();
  });

  test('/terms shares the same meta and never leaks an inactive segment', async ({ page, baseURL }) => {
    await page.goto(`${baseURL}/terms/`);
    await expect(page.locator('h1', { hasText: 'Terms' })).toBeVisible();
    const active = await readActiveSegments(page);
    expect(active).toEqual([...ACTIVE_POLICY_SEGMENTS]);

    // Phase A is the descriptive baseline — Terms must always carry it.
    expect(await page.locator('[data-policy-segment="A"]').count()).toBeGreaterThan(0);

    // Inactive segments must NOT leak. The Terms page does not have to
    // mention every active segment (audit-retention SLAs belong on
    // /privacy), so we only enforce the non-leak direction here.
    for (const seg of ALL_SEGMENTS) {
      if (active.includes(seg)) continue;
      const leaked = await page.locator(`[data-policy-segment="${seg}"]`).count();
      expect(leaked, `inactive segment ${seg} must not appear on /terms`).toBe(0);
    }
    // Phase B copy is required once the age-gate is live.
    if (active.includes('B')) {
      await expect(page.getByText(/at least 13 years old/i)).toBeVisible();
    }
  });

  test('/privacy ↔ /terms cross-link both directions', async ({ page, baseURL }) => {
    await page.goto(`${baseURL}/privacy/`);
    await page.locator('nav.policy-nav a', { hasText: 'Terms' }).first().click();
    await expect(page).toHaveURL(/\/terms\/?$/);
    await expect(page.locator('h1', { hasText: 'Terms' })).toBeVisible();

    await page.locator('nav.policy-nav a', { hasText: 'Privacy' }).first().click();
    await expect(page).toHaveURL(/\/privacy\/?$/);
    await expect(page.locator('h1', { hasText: 'Privacy Policy' })).toBeVisible();
  });

  test('/account loads the shell (signed-out fallback under preview server)', async ({ page, baseURL }) => {
    // The redesigned page renders different headings per load state, so we
    // assert against chrome that's present in every state: the top-bar
    // wordmark + the "account" crumb. This is enough to confirm the route
    // was emitted and the React module booted. Detailed UX (uploads,
    // danger zone) requires live /api/* endpoints which the static preview
    // lacks; the React module hits /api/account/me, gets a 404, and
    // falls through to the signed-out view.
    await page.goto(`${baseURL}/account/`);
    await expect(page.locator('.acct__wordmark')).toBeVisible({ timeout: 5000 });
    await expect(page.locator('.acct__crumbs')).toContainText(/account/i);
  });

  test('policy version meta tag is consistent with policy-config', async ({ page, baseURL }) => {
    const { POLICY_VERSION } = await import('../../src/policy/policy-config');
    await page.goto(`${baseURL}/privacy/`);
    const version = await page.locator('meta[name="policy-version"]').getAttribute('content');
    expect(version, '<meta name="policy-version"> missing — Vite plugin not wired?').toBe(POLICY_VERSION);
    // The visible Effective: line should also carry the version (substituted
    // by the same Vite plugin from the same constant).
    await expect(page.locator('#policy-version')).toHaveText(POLICY_VERSION);
  });
});

test.describe('D120 — Lab signed-out transfer dialog clickwrap hook', () => {
  test('signed-out Share panel renders the AgeClickwrapNotice + provider buttons', async ({ page, baseURL }) => {
    // Force signed-out by intercepting the session probe.
    await page.route('**/api/auth/session', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: { 'Cache-Control': 'no-store' },
        body: JSON.stringify({ status: 'signed-out' }),
      }),
    );
    // Stub the age-intent endpoint so the runtime's JIT fetch resolves
    // when a provider button is clicked (D120 flow — no checkbox).
    await page.route('**/api/account/age-confirmation/intent', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ageIntent: 'e2e-token', ttlSeconds: 300 }),
      }),
    );

    const url = new URL(`${baseURL}/lab/`);
    url.searchParams.set('e2e', '1');
    await page.goto(url.toString());

    // Wait for the toolbar so the Lab is initialized.
    await expect(
      page.getByRole('toolbar', { name: 'Simulation controls' }),
    ).toBeAttached({ timeout: 10000 });

    // Open the Transfer dialog. The trigger only renders when share is
    // available; if it's not in this build we skip rather than fail.
    const trigger = page.locator('.timeline-transfer-trigger');
    if ((await trigger.count()) === 0) {
      test.skip(true, 'transfer trigger not present in this build');
      return;
    }
    await trigger.click();

    // The signed-out auth prompt should render the shared AgeClickwrapNotice
    // (D120 — supersedes D118) + provider buttons. No checkbox — buttons
    // are enabled immediately; clicking IS the consent.
    const clickwrap = page.locator('#age-clickwrap-share');
    await expect(clickwrap).toBeVisible({ timeout: 5000 });
    await expect(clickwrap).toContainText('at least 13');

    // Provider buttons are enabled and reference the clickwrap via
    // aria-describedby so screen readers hear it as context.
    const google = page.locator('[data-testid="transfer-auth-google"]');
    await expect(google).toBeEnabled();
    await expect(google).toHaveAttribute('aria-describedby', 'age-clickwrap-share');
  });
});
