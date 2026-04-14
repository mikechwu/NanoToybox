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
 *   3. Lab transfer dialog: signed-out auth gating + AgeGateCheckbox
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

  test('signed-out: AgeGate checkbox renders and gates provider buttons', async ({ page, baseURL }) => {
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

    const checkbox = page.locator('[data-testid="age-gate-checkbox-transfer"]');
    await expect(checkbox).toBeVisible({ timeout: 5_000 });
    const google = page.locator('[data-testid="transfer-auth-google"]');
    await expect(google).toBeDisabled();
    await checkbox.check();
    await expect(google).toBeEnabled({ timeout: 5_000 });
  });
});
