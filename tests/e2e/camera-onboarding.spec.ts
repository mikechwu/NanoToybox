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

  test('camera controls hidden when Free-Look disabled', async ({ page, baseURL }) => {
    const errors = collectErrors(page)
    await skipOnboarding(page, baseURL!)
    await expect(page.getByRole('toolbar', { name: 'Simulation controls' })).toBeAttached({ timeout: 10000 })
    await page.waitForTimeout(1000)

    // CameraControls only renders when CONFIG.camera.freeLookEnabled is true.
    // Center/Follow moved to BondedGroupsPanel (Phase 10 cleanup).
    const camCtrl = page.locator('[data-camera-controls]')
    await expect(camCtrl).not.toBeAttached({ timeout: 3000 })

    expect(errors).toEqual([])
  })

  test('bonded-group panel provides Center and Follow per cluster', async ({ page, baseURL }) => {
    const errors = collectErrors(page)
    await skipOnboarding(page, baseURL!)
    await expect(page.getByRole('toolbar', { name: 'Simulation controls' })).toBeAttached({ timeout: 10000 })
    await page.waitForTimeout(1000)

    // Bonded-group panel should appear once groups are projected
    const panel = page.locator('.bonded-groups-panel')
    await expect(panel).toBeAttached({ timeout: 10000 })

    // Panel is expanded by default — list should already be visible
    await expect(panel.locator('.bonded-groups-list')).toBeAttached({ timeout: 3000 })

    // Center and Follow action buttons exist per-row
    const centerBtns = panel.locator('.bonded-groups-action-btn')
    await expect(centerBtns.first()).toBeAttached({ timeout: 3000 })

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

  test('bonded-group panel positioned in upper region, not overlapping dock', async ({ page, baseURL }) => {
    const errors = collectErrors(page)
    await skipOnboarding(page, baseURL!)
    await expect(page.getByRole('toolbar', { name: 'Simulation controls' })).toBeAttached({ timeout: 10000 })
    await page.waitForTimeout(1000)

    // Bonded-group panel is the primary secondary overlay (replaced camera controls)
    const panel = page.locator('.bonded-groups-panel')
    await expect(panel).toBeAttached({ timeout: 10000 })

    const panelBox = await panel.boundingBox()
    expect(panelBox).toBeTruthy()

    // Panel must be in the upper region (top 40%)
    const viewportH = await page.evaluate(() => window.innerHeight)
    expect(panelBox!.y).toBeLessThan(viewportH * 0.4)

    // Panel must NOT overlap the dock (bottom region)
    const dockBar = page.locator('[data-dock-root]')
    const dockBox = await dockBar.boundingBox()
    if (dockBox) {
      const panelBottom = panelBox!.y + panelBox!.height
      expect(panelBottom).toBeLessThan(dockBox.y)
    }

    expect(errors).toEqual([])
  })

  test('camera controls hidden when Free-Look feature gate is off', async ({ page, baseURL }) => {
    const errors = collectErrors(page)
    await skipOnboarding(page, baseURL!)
    await expect(page.getByRole('toolbar', { name: 'Simulation controls' })).toBeAttached({ timeout: 10000 })
    await page.waitForTimeout(1000)

    // With freeLookEnabled: false (default), camera controls should not render
    const camCtrl = page.locator('[data-camera-controls]')
    await expect(camCtrl).not.toBeAttached({ timeout: 3000 })

    expect(errors).toEqual([])
  })
})
