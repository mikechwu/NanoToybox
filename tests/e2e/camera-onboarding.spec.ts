import { test, expect } from '@playwright/test'
import { gotoApp } from './helpers'

/** Shared error collection — fails on console.error, pageerror, and request failures. */
function collectErrors(page: import('@playwright/test').Page) {
  const errors: string[] = []
  page.on('pageerror', err => errors.push(`[pageerror] ${err.message}`))
  page.on('console', msg => {
    if (msg.type() === 'error') {
      const text = msg.text()
      if (text.includes('WebGL') || text.includes('GL_INVALID')) return
      // Wasm fallback and aborted fetches are expected during rapid page reloads
      if (text.includes('wasm streaming compile failed') || text.includes('falling back to ArrayBuffer')) return
      if (text.includes('Failed to fetch')) return
      errors.push(`[console.error] ${text}`)
    }
  })
  page.on('requestfailed', req => {
    // Wasm and structure fetch aborts during page reload are not real errors
    if (req.url().includes('.wasm') || req.failure()?.errorText === 'net::ERR_ABORTED') return
    errors.push(`[request failed] ${req.url()} — ${req.failure()?.errorText}`)
  })
  return errors
}

/** Dismiss onboarding overlay, waiting for it to appear first then disappear after click. */
async function dismissOnboardingIfPresent(page: import('@playwright/test').Page) {
  const overlay = page.locator('[data-onboarding]')
  // Wait briefly for overlay to appear (reactive gate may need a tick)
  try {
    await expect(overlay).toBeAttached({ timeout: 3000 })
  } catch {
    return // overlay never appeared (e.g. suppressed by ?e2e=1)
  }
  await overlay.click()
  await expect(overlay).not.toBeAttached({ timeout: 5000 })
}

/** Navigate with ?e2e=1 to suppress onboarding. */
async function skipOnboarding(page: import('@playwright/test').Page, baseURL: string) {
  await gotoApp(page, baseURL, '/page/')
}

test.describe('Phase 1 — Object View Controls', () => {

  test('no Orbit label, no ? button in camera controls', async ({ page, baseURL }) => {
    const errors = collectErrors(page)
    await skipOnboarding(page, baseURL!)
    await expect(page.getByRole('toolbar', { name: 'Simulation controls' })).toBeAttached({ timeout: 10000 })
    await page.waitForTimeout(1000)

    // Camera controls region should exist
    const camCtrl = page.locator('[data-camera-controls]')
    await expect(camCtrl).toBeAttached({ timeout: 5000 })

    // No "Orbit" text inside camera controls
    const camText = await camCtrl.textContent()
    expect(camText).not.toContain('Orbit')

    // No "?" text inside camera controls
    expect(camText).not.toContain('?')

    expect(errors).toEqual([])
  })

  test('Center and Follow buttons exist in orbit mode', async ({ page, baseURL }) => {
    const errors = collectErrors(page)
    await skipOnboarding(page, baseURL!)
    await expect(page.getByRole('toolbar', { name: 'Simulation controls' })).toBeAttached({ timeout: 10000 })
    await page.waitForTimeout(1000)

    // Center button exists with correct aria-label
    const centerBtn = page.getByRole('button', { name: 'Center Object' })
    await expect(centerBtn).toBeAttached({ timeout: 5000 })

    // Follow button exists
    const followBtn = page.getByRole('button', { name: 'Follow' })
    await expect(followBtn).toBeAttached({ timeout: 5000 })

    expect(errors).toEqual([])
  })

  test('Follow button toggles orbitFollowEnabled', async ({ page, baseURL }) => {
    const errors = collectErrors(page)
    await skipOnboarding(page, baseURL!)
    await expect(page.getByRole('toolbar', { name: 'Simulation controls' })).toBeAttached({ timeout: 10000 })
    await page.waitForTimeout(1000)

    // Initial state: follow off
    let ui = await page.evaluate(() => (window as any)._getUIState?.())
    expect(ui?.orbitFollowEnabled).toBe(false)

    // Click Follow — enables
    await page.getByRole('button', { name: 'Follow' }).click()
    ui = await page.evaluate(() => (window as any)._getUIState?.())
    expect(ui?.orbitFollowEnabled).toBe(true)

    // Follow button now shows active state
    const activeBtn = page.getByRole('button', { name: /Following target/ })
    await expect(activeBtn).toBeAttached({ timeout: 2000 })

    // Click again — disables
    await activeBtn.click()
    ui = await page.evaluate(() => (window as any)._getUIState?.())
    expect(ui?.orbitFollowEnabled).toBe(false)

    expect(errors).toEqual([])
  })

  test('dock Atom/Move/Rotate controls unchanged', async ({ page, baseURL }) => {
    const errors = collectErrors(page)
    await skipOnboarding(page, baseURL!)
    const toolbar = page.getByRole('toolbar', { name: 'Simulation controls' })
    await expect(toolbar).toBeAttached({ timeout: 10000 })

    // All three mode radios present
    await expect(toolbar.getByRole('radio', { name: 'Atom' })).toBeAttached()
    await expect(toolbar.getByRole('radio', { name: 'Move' })).toBeAttached()
    await expect(toolbar.getByRole('radio', { name: 'Rotate' })).toBeAttached()

    expect(errors).toEqual([])
  })
})

test.describe('Phase 3 — Onboarding Overlay', () => {

  test('onboarding overlay appears on page load and dismisses on click', async ({ page, baseURL }) => {
    const errors = collectErrors(page)

    await page.goto(`${baseURL}/page/`)
    await expect(page.getByRole('toolbar', { name: 'Simulation controls' })).toBeAttached({ timeout: 10000 })
    await page.waitForTimeout(500)

    // Onboarding overlay should be visible (page-lifetime, no localStorage gate)
    const overlay = page.locator('[data-onboarding]')
    await expect(overlay).toBeAttached({ timeout: 5000 })

    // Should contain title text
    await expect(page.locator('.onboarding-title')).toContainText('NanoToybox')

    // Click to dismiss
    await overlay.click()

    // Wait for overlay to disappear (animationend or fallback timeout)
    await expect(overlay).not.toBeAttached({ timeout: 5000 })

    expect(errors).toEqual([])
  })

  test('onboarding reappears on page reload (page-lifetime dismissal)', async ({ page, baseURL }) => {
    const errors = collectErrors(page)

    await page.goto(`${baseURL}/page/`)
    await expect(page.getByRole('toolbar', { name: 'Simulation controls' })).toBeAttached({ timeout: 10000 })

    // Dismiss onboarding
    await dismissOnboardingIfPresent(page)

    // Reload — onboarding should reappear (no persistent storage)
    await page.reload()
    await expect(page.getByRole('toolbar', { name: 'Simulation controls' })).toBeAttached({ timeout: 10000 })
    await page.waitForTimeout(500)

    const overlay = page.locator('[data-onboarding]')
    await expect(overlay).toBeAttached({ timeout: 5000 })

    // Dismiss again for cleanup
    await dismissOnboardingIfPresent(page)

    expect(errors).toEqual([])
  })

  test('onboarding does not block interaction after dismiss', async ({ page, baseURL }) => {
    const errors = collectErrors(page)

    await page.goto(`${baseURL}/page/`)
    await expect(page.getByRole('toolbar', { name: 'Simulation controls' })).toBeAttached({ timeout: 10000 })

    // Dismiss onboarding and wait for it to fully disappear
    await dismissOnboardingIfPresent(page)
    await page.waitForTimeout(200)

    // Should be able to interact with dock
    const settingsBtn = page.getByRole('toolbar', { name: 'Simulation controls' }).getByRole('button', { name: 'Settings' })
    await settingsBtn.click({ timeout: 10000 })
    const sheet = page.locator('.sheet').filter({ hasText: 'Settings' })
    await expect(sheet).toBeAttached({ timeout: 5000 })

    expect(errors).toEqual([])
  })
})

test.describe('Phase 4 — Help in Settings', () => {

  test('Settings > Controls has Object View help content', async ({ page, baseURL }) => {
    const errors = collectErrors(page)
    await skipOnboarding(page, baseURL!)
    await expect(page.getByRole('toolbar', { name: 'Simulation controls' })).toBeAttached({ timeout: 10000 })

    // Open settings
    await page.getByRole('toolbar', { name: 'Simulation controls' }).getByRole('button', { name: 'Settings' }).click()
    const sheet = page.locator('.sheet').filter({ hasText: 'Settings' })
    await expect(sheet).toHaveClass(/open/, { timeout: 3000 })

    // Navigate to Controls help page
    await sheet.locator('.group-item', { hasText: 'Controls' }).click()
    await expect(sheet.locator('.help-section-title', { hasText: 'Object View' })).toBeVisible({ timeout: 3000 })

    // Verify Center and Follow are documented (use getByText for exact leaf match)
    await expect(sheet.getByText('Center — frame the focused molecule in view')).toBeVisible()
    await expect(sheet.getByText('Follow — continuously track the focused molecule')).toBeVisible()

    expect(errors).toEqual([])
  })
})

test.describe('Phase 6 — Layout Contract', () => {

  test('camera controls positioned below top status area, not overlapping dock', async ({ page, baseURL }) => {
    const errors = collectErrors(page)
    await skipOnboarding(page, baseURL!)
    await expect(page.getByRole('toolbar', { name: 'Simulation controls' })).toBeAttached({ timeout: 10000 })
    await page.waitForTimeout(1000)

    const camCtrl = page.locator('[data-camera-controls]')
    await expect(camCtrl).toBeAttached({ timeout: 5000 })

    const camBox = await camCtrl.boundingBox()
    expect(camBox).toBeTruthy()

    // If status bar is visible, camera controls should be below and left-aligned
    const statusBar = page.locator('[data-status-root]')
    if (await statusBar.count() > 0) {
      const statusBox = await statusBar.boundingBox()
      if (statusBox) {
        expect(camBox!.y).toBeGreaterThanOrEqual(statusBox.y + statusBox.height)
        // Horizontal alignment: cam controls left edge within 20px of status left edge
        expect(Math.abs(camBox!.x - statusBox.x)).toBeLessThan(20)
      }
    }

    // Camera controls must be in the upper region (top 30%)
    const viewportH = await page.evaluate(() => window.innerHeight)
    expect(camBox!.y).toBeLessThan(viewportH * 0.3)

    // Camera controls must NOT overlap the dock (bottom region)
    const dockBar = page.locator('[data-dock-root]')
    const dockBox = await dockBar.boundingBox()
    if (dockBox) {
      const camBottom = camBox!.y + camBox!.height
      expect(camBottom).toBeLessThan(dockBox.y)
    }

    expect(errors).toEqual([])
  })

  test('camera controls use fallback position when status bar is absent', async ({ page, baseURL }) => {
    const errors = collectErrors(page)
    await skipOnboarding(page, baseURL!)
    await expect(page.getByRole('toolbar', { name: 'Simulation controls' })).toBeAttached({ timeout: 10000 })
    await page.waitForTimeout(1000)

    const statusBar = page.locator('[data-status-root]')
    const statusCount = await statusBar.count()

    const camCtrl = page.locator('[data-camera-controls]')
    const camBox = await camCtrl.boundingBox()
    expect(camBox).toBeTruthy()

    if (statusCount === 0) {
      // Fallback: camera controls at ~48px from top (within tolerance)
      expect(camBox!.y).toBeGreaterThanOrEqual(30)
      expect(camBox!.y).toBeLessThan(80)
    }

    // Either way, must be in upper region and not overlap dock
    const viewportH = await page.evaluate(() => window.innerHeight)
    expect(camBox!.y).toBeLessThan(viewportH * 0.3)

    expect(errors).toEqual([])
  })
})
