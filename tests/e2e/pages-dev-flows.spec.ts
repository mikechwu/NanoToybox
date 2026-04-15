/**
 * E2E specs that REQUIRE a live Pages backend (wrangler pages dev).
 *
 * The default `vite preview` lane covers static surfaces (route
 * scaffolding, policy meta, /account shell, /privacy-request form
 * markup) but cannot exercise:
 *
 *   - functions/api/* (publish 428, account API, privacy-request
 *     POST + nonce, age-confirmation intent + UPSERT)
 *   - the OAuth start redirects
 *   - the popup-complete handshake
 *
 * Run via `npm run test:e2e:pages-dev` (NOT the default test:e2e).
 * Tests in this file are skipped under the static preview lane so
 * they don't fail when invoked from the wrong config.
 *
 * Coverage today:
 *   1. /privacy-request: nonce → form submit → 200 + reference id
 *   2. /privacy-request: missing nonce → 401 invalid_nonce
 *   3. Lab transfer dialog: signed-out auth gating + AgeClickwrapNotice
 *      rendering against a real backend (the static lane skipped
 *      this because the publishable timeline isn't installed).
 */

import { test, expect } from '@playwright/test';

const PAGES_DEV = 'pages-dev';

test.describe('Pages-dev — privacy-request endpoint', () => {
  test.beforeEach(({}, testInfo) => {
    test.skip(
      testInfo.project.name !== PAGES_DEV,
      'Requires wrangler pages dev — skipped under the static preview lane',
    );
  });

  test('GET /api/privacy-request/nonce returns a token', async ({ request, baseURL }) => {
    const res = await request.get(`${baseURL}/api/privacy-request/nonce`);
    expect(res.status()).toBe(200);
    const body = (await res.json()) as { nonce: string; ttlSeconds: number };
    expect(body.ttlSeconds).toBe(600);
    expect(body.nonce).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  });

  test('POST /api/privacy-request without nonce → 401 invalid_nonce', async ({ request, baseURL }) => {
    const res = await request.post(`${baseURL}/api/privacy-request`, {
      data: {
        contact_value: 'noone@example.test',
        request_type: 'access',
        message: 'hi',
      },
    });
    expect(res.status()).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('invalid_nonce');
  });

  test('end-to-end: nonce → submit → 200 with id', async ({ request, baseURL }) => {
    const nonceRes = await request.get(`${baseURL}/api/privacy-request/nonce`);
    const { nonce } = (await nonceRes.json()) as { nonce: string };

    const res = await request.post(`${baseURL}/api/privacy-request`, {
      data: {
        contact_value: 'e2e@example.test',
        request_type: 'access',
        message: `pages-dev e2e at ${Date.now()}`,
        nonce,
      },
    });
    expect(res.status()).toBe(200);
    const body = (await res.json()) as { ok: boolean; id: string };
    expect(body.ok).toBe(true);
    expect(body.id).toMatch(/^[0-9a-f-]{36}$/i);
  });

  test('POST /api/privacy-request with 2001-char message → 400 message_too_long (no "capsule" wording)', async ({
    request,
    baseURL,
  }) => {
    const nonceRes = await request.get(`${baseURL}/api/privacy-request/nonce`);
    const { nonce } = (await nonceRes.json()) as { nonce: string };

    const res = await request.post(`${baseURL}/api/privacy-request`, {
      data: {
        contact_value: 'too-long@example.test',
        request_type: 'access',
        message: 'x'.repeat(2001),
        nonce,
      },
    });
    expect(res.status()).toBe(400);
    const body = (await res.json()) as { error: string; maxChars: number; message: string };
    expect(body.error).toBe('message_too_long');
    expect(body.maxChars).toBe(2000);
    expect(body.message).not.toMatch(/capsule/i);
  });
});

test.describe('Pages-dev — Lab transfer dialog signed-out gating', () => {
  test.beforeEach(({}, testInfo) => {
    test.skip(
      testInfo.project.name !== PAGES_DEV,
      'Requires wrangler pages dev so /api/auth/session can resolve',
    );
  });

  test('signed-out: clickwrap notice renders and provider buttons are gated by aria-describedby (D120)', async ({ page, context, baseURL }) => {
    // Short-circuit /auth/google/start BEFORE navigating so the popup
    // the runtime opens after the JIT intent fetch never enters the
    // real provider redirect chain. Without this, the popup keeps
    // running after the assertion and can create CI flakes (dangling
    // pages + network calls into accounts.google.com). The 204 body
    // resolves the popup's navigation without setting any cookies or
    // changing app state.
    await context.route('**/auth/google/start**', (route) =>
      route.fulfill({
        status: 204,
        headers: { 'Cache-Control': 'no-store' },
        body: '',
      }),
    );

    // Force signed-out via the real session probe — wrangler-dev
    // returns `{status:'signed-out'}` when no cookie is present.
    const url = new URL(`${baseURL}/lab/`);
    url.searchParams.set('e2e', '1');
    await page.goto(url.toString());

    await expect(
      page.getByRole('toolbar', { name: 'Simulation controls' }),
    ).toBeAttached({ timeout: 10_000 });

    const trigger = page.locator('.timeline-transfer-trigger');
    if ((await trigger.count()) === 0) {
      test.skip(true, 'transfer trigger not present in this build');
      return;
    }
    await trigger.click();

    // D120 — AgeClickwrapNotice replaces the deleted AgeGateCheckbox.
    // Provider buttons are enabled immediately; clicking is the consent.
    const clickwrap = page.locator('#age-clickwrap-share');
    await expect(clickwrap).toBeVisible({ timeout: 5_000 });
    await expect(clickwrap).toContainText('at least 13');

    const google = page.locator('[data-testid="transfer-auth-google"]');
    const github = page.locator('[data-testid="transfer-auth-github"]');
    await expect(google).toBeEnabled();
    await expect(github).toBeEnabled();
    await expect(google).toHaveAttribute('aria-describedby', 'age-clickwrap-share');
    await expect(github).toHaveAttribute('aria-describedby', 'age-clickwrap-share');

    // Clicking a provider triggers the JIT age-intent fetch. We
    // capture the popup via `context.waitForEvent('page')` so we can
    // close it deterministically after the assertion, avoiding
    // dangling pages in the context after the test ends.
    const popupPromise = context.waitForEvent('page', { timeout: 5_000 }).catch(() => null);
    const intentRequest = page.waitForRequest((req) =>
      req.url().includes('/api/account/age-confirmation/intent') && req.method() === 'POST',
      { timeout: 5_000 },
    );
    await google.click();
    const req = await intentRequest;
    expect(req.url()).toContain('/api/account/age-confirmation/intent');

    const popup = await popupPromise;
    if (popup) {
      // Wait for the intercepted 204 to land so we don't race the close.
      await popup.waitForLoadState('load').catch(() => {});
      await popup.close();
    }
  });
});
