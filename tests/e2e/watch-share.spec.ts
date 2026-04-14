/**
 * Watch share-link E2E — remote capsule open via share code, URL, and ?c= auto-open.
 *
 * Since E2E tests run against vite preview (static server, no Pages Functions),
 * all /api/capsules/* requests are intercepted via page.route() with mock responses.
 *
 * Uses ?e2e=1 test hooks from watch/js/main.ts:
 *   _getWatchState()                → snapshot fields
 *
 * Covers:
 *   - Landing page shows share input section
 *   - Paste a share code → mock API → capsule loads
 *   - Paste a full share URL → capsule loads
 *   - ?c= query param auto-opens shared capsule on bootstrap
 *   - 404 from metadata API → "not found" error banner, no crash
 *   - Network error on blob fetch → error banner, preserves empty state
 *   - Top bar "Open Share" button appears after file is loaded
 *   - Invalid share code → error message
 */

import { test, expect } from '@playwright/test'
import path from 'path'
import fs from 'fs'

const SHARE_CODE = '7M4K2D8Q9T1V'

const CAPSULE_FIXTURE = path.join(__dirname, 'fixtures', 'share-capsule.json')

function collectErrors(page: import('@playwright/test').Page) {
  const errors: string[] = []
  page.on('pageerror', err => errors.push(`[pageerror] ${err.message}`))
  page.on('console', msg => {
    if (msg.type() === 'error') {
      const text = msg.text()
      // Ignore headless rendering warnings
      if (text.includes('WebGL') || text.includes('GL_INVALID')) return
      // Ignore wasm fallback messages
      if (text.includes('wasm streaming compile failed')) return
      errors.push(`[console.error] ${text}`)
    }
  })
  return errors
}

async function waitForWatchState(page: import('@playwright/test').Page) {
  await expect(async () => {
    const state = await page.evaluate(() => (window as any)._getWatchState?.())
    expect(state).toBeDefined()
  }).toPass({ timeout: 5000 })
  return page.evaluate(() => (window as any)._getWatchState?.())
}

/** Mock metadata response matching ShareMetadataResponse shape. */
const MOCK_METADATA = {
  shareCode: SHARE_CODE,
  kind: 'capsule',
  version: 1,
  sizeBytes: 500,
  frameCount: 3,
  atomCount: 2,
  maxAtomCount: 2,
  durationPs: 50,
  hasAppearance: false,
  hasInteraction: false,
  previewStatus: 'none',
}

/**
 * Install API route mocks for share-link resolution.
 * Uses a single catch-all handler for /api/capsules/* to avoid
 * glob ordering ambiguity in Playwright's route matching.
 */
async function installShareMocks(
  page: import('@playwright/test').Page,
  opts: {
    metadataStatus?: number;
    blobStatus?: number;
    blobBody?: string;
    metadataBody?: object;
  } = {},
) {
  const capsuleJson = fs.readFileSync(CAPSULE_FIXTURE, 'utf-8')

  await page.route(`**/api/capsules/**`, (route) => {
    const url = new URL(route.request().url())
    const pathname = url.pathname

    // Blob endpoint: /api/capsules/:code/blob
    if (pathname === `/api/capsules/${SHARE_CODE}/blob`) {
      const status = opts.blobStatus ?? 200
      if (status !== 200) {
        return route.fulfill({ status, body: 'Not found' })
      }
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: {
          'Content-Disposition': `attachment; filename="atomdojo-capsule-${SHARE_CODE}.atomdojo"`,
          'X-Content-Type-Options': 'nosniff',
        },
        body: opts.blobBody ?? capsuleJson,
      })
    }

    // Metadata endpoint: /api/capsules/:code
    if (pathname === `/api/capsules/${SHARE_CODE}`) {
      const status = opts.metadataStatus ?? 200
      if (status !== 200) {
        return route.fulfill({ status, body: 'Not found' })
      }
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(opts.metadataBody ?? MOCK_METADATA),
      })
    }

    // Unrecognized API path — let it through (will 404 on static server)
    return route.continue()
  })
}

// ── Landing page UI ──

test.describe('Watch share — landing page UI', () => {
  test('landing page shows share input section', async ({ page, baseURL }) => {
    const errors = collectErrors(page)
    await page.goto(`${baseURL}/watch/?e2e=1`)
    await waitForWatchState(page)

    const shareSection = page.locator('.watch-share-input-section')
    await expect(shareSection).toBeVisible()

    const label = page.locator('.watch-share-input-label')
    await expect(label).toContainText('Open Share Link or Code')

    const input = page.locator('.watch-share-input')
    await expect(input).toBeVisible()

    expect(errors).toEqual([])
  })
})

// ── Share code open ──

test.describe('Watch share — open via share code', () => {
  test('paste raw share code → capsule loads', async ({ page, baseURL }) => {
    const errors = collectErrors(page)
    await page.goto(`${baseURL}/watch/?e2e=1`)
    await waitForWatchState(page)
    await installShareMocks(page)

    // Type share code into the input
    const input = page.locator('.watch-share-input')
    await input.fill(SHARE_CODE)

    // Submit the form
    const form = page.locator('.watch-share-input-form')
    await form.locator('button[type="submit"]').click()

    // Wait for the capsule to load
    await expect(async () => {
      const state = await page.evaluate(() => (window as any)._getWatchState?.())
      expect(state?.loaded).toBe(true)
    }).toPass({ timeout: 10000 })

    const state = await waitForWatchState(page)
    expect(state.loaded).toBe(true)
    expect(state.atomCount).toBe(2)
    expect(state.frameCount).toBe(3)
    expect(state.fileKind).toBe('capsule')
    expect(state.error).toBeNull()

    expect(errors).toEqual([])
  })

  test('paste full share URL → capsule loads', async ({ page, baseURL }) => {
    const errors = collectErrors(page)
    await page.goto(`${baseURL}/watch/?e2e=1`)
    await waitForWatchState(page)
    await installShareMocks(page)

    const input = page.locator('.watch-share-input')
    await input.fill(`https://atomdojo.pages.dev/c/${SHARE_CODE}`)

    const form = page.locator('.watch-share-input-form')
    await form.locator('button[type="submit"]').click()

    await expect(async () => {
      const state = await page.evaluate(() => (window as any)._getWatchState?.())
      expect(state?.loaded).toBe(true)
    }).toPass({ timeout: 10000 })

    const state = await waitForWatchState(page)
    expect(state.loaded).toBe(true)
    expect(state.fileKind).toBe('capsule')

    expect(errors).toEqual([])
  })

  test('paste grouped share code → capsule loads', async ({ page, baseURL }) => {
    const errors = collectErrors(page)
    await page.goto(`${baseURL}/watch/?e2e=1`)
    await waitForWatchState(page)
    await installShareMocks(page)

    const input = page.locator('.watch-share-input')
    // Grouped format: 7M4K-2D8Q-9T1V
    await input.fill('7M4K-2D8Q-9T1V')

    const form = page.locator('.watch-share-input-form')
    await form.locator('button[type="submit"]').click()

    await expect(async () => {
      const state = await page.evaluate(() => (window as any)._getWatchState?.())
      expect(state?.loaded).toBe(true)
    }).toPass({ timeout: 10000 })

    expect(errors).toEqual([])
  })
})

// ── Auto-open via ?c= ──

test.describe('Watch share — ?c= bootstrap auto-open', () => {
  test('?c= query param auto-opens shared capsule', async ({ page, baseURL }) => {
    const errors = collectErrors(page)
    await installShareMocks(page)

    // Navigate with ?c= param (plus e2e=1 for test hooks)
    await page.goto(`${baseURL}/watch/?e2e=1&c=${SHARE_CODE}`)

    // Should auto-load the capsule
    await expect(async () => {
      const state = await page.evaluate(() => (window as any)._getWatchState?.())
      expect(state?.loaded).toBe(true)
    }).toPass({ timeout: 10000 })

    const state = await waitForWatchState(page)
    expect(state.loaded).toBe(true)
    expect(state.atomCount).toBe(2)
    expect(state.frameCount).toBe(3)
    expect(state.fileKind).toBe('capsule')

    // Should show the workspace, not the landing page
    const workspace = page.locator('.watch-workspace')
    await expect(workspace).toBeVisible({ timeout: 3000 })

    const landing = page.locator('.watch-landing')
    await expect(landing).not.toBeAttached()

    expect(errors).toEqual([])
  })
})

// ── Error states ──

test.describe('Watch share — error handling', () => {
  test('404 from metadata API → error banner, preserves empty state', async ({ page, baseURL }) => {
    await page.goto(`${baseURL}/watch/?e2e=1`)
    await waitForWatchState(page)
    await installShareMocks(page, { metadataStatus: 404 })

    const input = page.locator('.watch-share-input')
    await input.fill(SHARE_CODE)
    const form = page.locator('.watch-share-input-form')
    await form.locator('button[type="submit"]').click()

    // Wait for error to appear
    await expect(async () => {
      const state = await page.evaluate(() => (window as any)._getWatchState?.())
      expect(state?.error).toBeTruthy()
    }).toPass({ timeout: 10000 })

    const state = await waitForWatchState(page)
    expect(state.loaded).toBe(false)
    expect(state.error).toContain('not found')

    // Error banner should be visible
    const errorBanner = page.locator('.watch-error-banner')
    await expect(errorBanner).toBeVisible()

    // Landing page should still be showing (not crashed)
    const landing = page.locator('.watch-landing')
    await expect(landing).toBeVisible()
  })

  test('blob fetch failure → error banner', async ({ page, baseURL }) => {
    await page.goto(`${baseURL}/watch/?e2e=1`)
    await waitForWatchState(page)
    await installShareMocks(page, { blobStatus: 500 })

    const input = page.locator('.watch-share-input')
    await input.fill(SHARE_CODE)
    const form = page.locator('.watch-share-input-form')
    await form.locator('button[type="submit"]').click()

    await expect(async () => {
      const state = await page.evaluate(() => (window as any)._getWatchState?.())
      expect(state?.error).toBeTruthy()
    }).toPass({ timeout: 10000 })

    const state = await waitForWatchState(page)
    expect(state.loaded).toBe(false)
    expect(state.error).toBeTruthy()
  })

  test('invalid share code → error message', async ({ page, baseURL }) => {
    await page.goto(`${baseURL}/watch/?e2e=1`)
    await waitForWatchState(page)

    const input = page.locator('.watch-share-input')
    await input.fill('not-a-valid-code')
    const form = page.locator('.watch-share-input-form')
    await form.locator('button[type="submit"]').click()

    await expect(async () => {
      const state = await page.evaluate(() => (window as any)._getWatchState?.())
      expect(state?.error).toBeTruthy()
    }).toPass({ timeout: 10000 })

    const state = await waitForWatchState(page)
    expect(state.loaded).toBe(false)
    expect(state.error).toContain('Invalid share code')
  })
})

// ── Top bar share action ──

test.describe('Watch share — top bar', () => {
  test('Open Share button appears in top bar after file load', async ({ page, baseURL }) => {
    const errors = collectErrors(page)
    await page.goto(`${baseURL}/watch/?e2e=1`)
    await waitForWatchState(page)
    await installShareMocks(page)

    // First load a capsule via share code
    const input = page.locator('.watch-share-input')
    await input.fill(SHARE_CODE)
    const form = page.locator('.watch-share-input-form')
    await form.locator('button[type="submit"]').click()

    await expect(async () => {
      const state = await page.evaluate(() => (window as any)._getWatchState?.())
      expect(state?.loaded).toBe(true)
    }).toPass({ timeout: 10000 })

    // Top bar should have an "Open Share" action
    const openShareBtn = page.locator('.review-topbar__action', { hasText: 'Open Share' })
    await expect(openShareBtn).toBeVisible()

    // Click it → inline share input should appear
    await openShareBtn.click()
    const shareInput = page.locator('.review-topbar__share-input')
    await expect(shareInput).toBeVisible()

    // Cancel returns to buttons
    const cancelBtn = page.locator('.review-topbar__action', { hasText: 'Cancel' })
    await cancelBtn.click()
    await expect(shareInput).not.toBeAttached()
    await expect(openShareBtn).toBeVisible()

    expect(errors).toEqual([])
  })
})

// ── Preserves existing document on share error ──

test.describe('Watch share — state preservation on error', () => {
  test('failed share open preserves previously loaded document', async ({ page, baseURL }) => {
    const errors = collectErrors(page)
    await page.goto(`${baseURL}/watch/?e2e=1`)
    await waitForWatchState(page)

    // First, load a file the normal way (via test hook)
    const capsuleJson = fs.readFileSync(CAPSULE_FIXTURE, 'utf-8')
    await page.evaluate(async (args) => {
      await (window as any)._watchOpenFile(args[0], args[1])
    }, [capsuleJson, 'local-test.atomdojo'])

    await expect(async () => {
      const state = await page.evaluate(() => (window as any)._getWatchState?.())
      expect(state?.loaded).toBe(true)
    }).toPass({ timeout: 5000 })

    const beforeState = await waitForWatchState(page)
    expect(beforeState.loaded).toBe(true)
    expect(beforeState.atomCount).toBe(2)

    // Now try to open a share code that 404s
    await installShareMocks(page, { metadataStatus: 404 })

    // Use the top bar share input
    const openShareBtn = page.locator('.review-topbar__action', { hasText: 'Open Share' })
    await openShareBtn.click()
    const shareInput = page.locator('.review-topbar__share-input')
    await shareInput.fill(SHARE_CODE)
    await page.locator('.review-topbar__share-form').locator('button[type="submit"]').click()

    // Wait for error
    await expect(async () => {
      const state = await page.evaluate(() => (window as any)._getWatchState?.())
      expect(state?.error).toBeTruthy()
    }).toPass({ timeout: 10000 })

    // The previous document should still be loaded
    const afterState = await waitForWatchState(page)
    expect(afterState.loaded).toBe(true)
    expect(afterState.atomCount).toBe(2)
    expect(afterState.error).toContain('not found')

    // Filter out the expected "not found" console error from openSharedCapsule
    const unexpected = errors.filter(e => !e.includes('not found') && !e.includes('404'))
    expect(unexpected).toEqual([])
  })
})
