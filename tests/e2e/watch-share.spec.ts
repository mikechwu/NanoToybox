/**
 * Watch share-link E2E — remote capsule open via share code, URL, and ?c= auto-open.
 *
 * Since E2E tests run against vite preview (static server, no Pages Functions),
 * all /api/capsules/* requests are intercepted via page.route() with mock responses.
 *
 * Uses ?e2e=1 test hooks from watch/js/app/main.ts:
 *   _getWatchState()                → snapshot fields
 *
 * Covers:
 *   - Empty state renders workspace + open panel (no landing page)
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

// ── Empty-state open panel UI ──

test.describe('Watch share — empty-state open panel', () => {
  test('empty state shows open panel with share input and workspace shell', async ({ page, baseURL }) => {
    const errors = collectErrors(page)
    await page.goto(`${baseURL}/watch/?e2e=1`)
    await waitForWatchState(page)

    // Workspace shell is ALWAYS rendered now — the former
    // `.watch-landing` page is deleted. The open panel overlays
    // the canvas area until a file is loaded.
    const workspace = page.locator('.watch-workspace')
    await expect(workspace).toBeVisible()

    const panel = page.locator('.watch-open-panel')
    await expect(panel).toBeVisible()

    const title = panel.locator('.watch-open-panel__title')
    await expect(title).toContainText('Open a shared capsule')

    const input = panel.locator('.watch-open-panel__input')
    await expect(input).toBeVisible()

    // Right rail is hidden in empty state.
    await expect(page.locator('.watch-analysis')).not.toBeAttached()

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
    const input = page.locator('.watch-open-panel__input')
    await input.fill(SHARE_CODE)

    // Submit the form
    const form = page.locator('.watch-open-panel__form')
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

    const input = page.locator('.watch-open-panel__input')
    await input.fill(`https://atomdojo.pages.dev/c/${SHARE_CODE}`)

    const form = page.locator('.watch-open-panel__form')
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

    const input = page.locator('.watch-open-panel__input')
    // Grouped format: 7M4K-2D8Q-9T1V
    await input.fill('7M4K-2D8Q-9T1V')

    const form = page.locator('.watch-open-panel__form')
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

    // Workspace stays rendered; the open panel disappears after load.
    const workspace = page.locator('.watch-workspace')
    await expect(workspace).toBeVisible({ timeout: 3000 })

    const panel = page.locator('.watch-open-panel')
    await expect(panel).not.toBeAttached()

    expect(errors).toEqual([])
  })

  test('?c= auto-open shows workspace + loading panel BEFORE blob resolves', async ({ page, baseURL }) => {
    // Gated blob route: holds the response until we signal release.
    // Without gating, fast mocks race past the loading phase and the
    // AC "/watch/?c= shows workspace and loading panel immediately"
    // would be unobservable.
    const capsuleJson = fs.readFileSync(CAPSULE_FIXTURE, 'utf-8')
    let releaseBlob: ((value: void) => void) | null = null
    const blobGate = new Promise<void>((resolve) => { releaseBlob = resolve })

    await page.route(`**/api/capsules/**`, async (route) => {
      const url = new URL(route.request().url())
      if (url.pathname === `/api/capsules/${SHARE_CODE}`) {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(MOCK_METADATA),
        })
      }
      if (url.pathname === `/api/capsules/${SHARE_CODE}/blob`) {
        await blobGate
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: capsuleJson,
        })
      }
      return route.continue()
    })

    await page.goto(`${baseURL}/watch/?e2e=1&c=${SHARE_CODE}`)

    // While the blob is still deferred: the workspace shell must
    // already be present AND the open panel must be visible AND the
    // snapshot must report loading in progress.
    await expect(page.locator('.watch-workspace')).toBeVisible({ timeout: 3000 })
    await expect(page.locator('.watch-open-panel')).toBeVisible()
    await expect(page.locator('.watch-open-panel__title')).toContainText('Opening shared capsule')

    await expect(async () => {
      const state = await page.evaluate(() => (window as any)._getWatchState?.())
      expect(state?.loaded).toBe(false)
      expect(state?.openProgress?.kind).toBe('share')
    }).toPass({ timeout: 3000 })

    // Release the blob; panel disappears, state flips to loaded.
    releaseBlob!()

    await expect(async () => {
      const state = await page.evaluate(() => (window as any)._getWatchState?.())
      expect(state?.loaded).toBe(true)
    }).toPass({ timeout: 10000 })

    await expect(page.locator('.watch-open-panel')).not.toBeAttached()
  })
})

// ── Error states ──

test.describe('Watch share — error handling', () => {
  test('404 from metadata API → error banner, preserves empty state', async ({ page, baseURL }) => {
    await page.goto(`${baseURL}/watch/?e2e=1`)
    await waitForWatchState(page)
    await installShareMocks(page, { metadataStatus: 404 })

    const input = page.locator('.watch-open-panel__input')
    await input.fill(SHARE_CODE)
    const form = page.locator('.watch-open-panel__form')
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

    // Open panel remains visible in empty state after a 404 (the
    // failed load did not wipe the input; user can correct + retry).
    const panel = page.locator('.watch-open-panel')
    await expect(panel).toBeVisible()
  })

  test('blob fetch failure → error banner', async ({ page, baseURL }) => {
    await page.goto(`${baseURL}/watch/?e2e=1`)
    await waitForWatchState(page)
    await installShareMocks(page, { blobStatus: 500 })

    const input = page.locator('.watch-open-panel__input')
    await input.fill(SHARE_CODE)
    const form = page.locator('.watch-open-panel__form')
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

    const input = page.locator('.watch-open-panel__input')
    await input.fill('not-a-valid-code')
    const form = page.locator('.watch-open-panel__form')
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
    const input = page.locator('.watch-open-panel__input')
    await input.fill(SHARE_CODE)
    const form = page.locator('.watch-open-panel__form')
    await form.locator('button[type="submit"]').click()

    await expect(async () => {
      const state = await page.evaluate(() => (window as any)._getWatchState?.())
      expect(state?.loaded).toBe(true)
    }).toPass({ timeout: 10000 })

    // Toolbar should have an "Open share link" action (icon button).
    const openShareBtn = page.locator('.watch-topbar__action[aria-label="Open share link"]')
    await expect(openShareBtn).toBeVisible()

    // Click it → inline share input should appear
    await openShareBtn.click()
    const shareInput = page.locator('.watch-topbar__input')
    await expect(shareInput).toBeVisible()

    // Close (✕) returns to buttons
    const closeBtn = page.locator('.watch-topbar__form .watch-topbar__action').last()
    await closeBtn.click()
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

    // Use the toolbar's share input (link icon + paste).
    const openShareBtn = page.locator('.watch-topbar__action[aria-label="Open share link"]')
    await openShareBtn.click()
    const shareInput = page.locator('.watch-topbar__input')
    await shareInput.fill(SHARE_CODE)
    await page.locator('.watch-topbar__form').locator('button[type="submit"]').click()

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
