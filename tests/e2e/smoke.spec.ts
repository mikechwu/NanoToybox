import { test, expect } from '@playwright/test'
import path from 'path'

const FIXTURE_DIR = path.join(__dirname, 'fixtures')

/** Shared error collection — fails on console.error, pageerror, and request failures. */
function collectErrors(page: import('@playwright/test').Page) {
  const errors: string[] = []
  page.on('pageerror', err => errors.push(`[pageerror] ${err.message}`))
  page.on('console', msg => {
    if (msg.type() === 'error') {
      const text = msg.text()
      if (text.includes('WebGL') || text.includes('GL_INVALID')) return
      errors.push(`[console.error] ${text}`)
    }
  })
  page.on('requestfailed', req => {
    errors.push(`[request failed] ${req.url()} — ${req.failure()?.errorText}`)
  })
  return errors
}

/**
 * Viewer-specific error collection.
 * The viewer speculatively fetches demo trajectories from /outputs/ which are
 * gitignored. These produce 404s. We collect all errors and reconcile at
 * assertion time: each /outputs/ request failure cancels one generic
 * "Failed to load resource" console error.
 */
function collectViewerErrors(page: import('@playwright/test').Page) {
  const errors: string[] = []
  let outputsFailureCount = 0

  page.on('pageerror', err => errors.push(`[pageerror] ${err.message}`))
  page.on('requestfailed', req => {
    if (req.url().includes('/outputs/')) {
      outputsFailureCount++
      return
    }
    errors.push(`[request failed] ${req.url()} — ${req.failure()?.errorText}`)
  })
  page.on('console', msg => {
    if (msg.type() !== 'error') return
    const text = msg.text()
    if (text.includes('WebGL') || text.includes('GL_INVALID')) return
    errors.push(`[console.error] ${text}`)
  })

  /** Call at assertion time to reconcile expected 404 noise. */
  function getUnexpectedErrors(): string[] {
    let remaining = outputsFailureCount
    return errors.filter(e => {
      if (remaining > 0 && e === '[console.error] Failed to load resource: the server responded with a status of 404 (Not Found)') {
        remaining--
        return false
      }
      return true
    })
  }

  return { errors, getUnexpectedErrors }
}

test.describe('Milestone A — Hard-Supported Pages', () => {

  test('main app: boot, load structure list, verify scene status', async ({ page, baseURL }) => {
    const errors = collectErrors(page)

    await page.goto(`${baseURL}/page/`)

    // App initializes — core DOM present (React-authoritative components)
    await expect(page.locator('.dock')).toBeAttached({ timeout: 10000 })
    await expect(page.locator('#container')).toBeAttached({ timeout: 5000 })

    // Wait for app to finish loading — dock visible means React mounted and init completed
    await page.waitForTimeout(2000)

    // Open chooser via React dock Add button and verify structure list
    await page.locator('.dock .dock-add-btn').click()
    await expect(page.locator('.sheet .drawer-item').first()).toBeAttached({ timeout: 10000 })
    const itemCount = await page.locator('.sheet .drawer-item').count()
    expect(itemCount).toBeGreaterThan(0)

    // Verify structure items contain atom counts (manifest loaded correctly)
    const firstItemText = await page.locator('.sheet .drawer-item').first().textContent()
    expect(firstItemText).toContain('atoms')

    // Note: full add/place/clear cycle requires WebGL which headless Chromium
    // lacks. The cycle is verified manually per docs/README.md pre-deploy checklist.

    expect(errors).toEqual([])
  })

  test('bench-wasm: runs Wasm validation and reports results', async ({ page, baseURL }) => {
    const errors = collectErrors(page)

    await page.goto(`${baseURL}/page/bench/bench-wasm.html`)

    await expect(page.locator('h2')).toContainText('Wasm Tersoff')

    // Click Run and wait for completion
    await page.locator('#btn-run').click()
    await expect(page.locator('#status')).toContainText('Done', { timeout: 30000 })

    // Results should contain parity test outcome (proves Wasm ran)
    await expect(page.locator('#results')).toContainText('PARITY', { timeout: 5000 })

    expect(errors).toEqual([])
  })

  test('viewer: load XYZ fixture and verify scene updates', async ({ page, baseURL }) => {
    const { getUnexpectedErrors } = collectViewerErrors(page)

    await page.goto(`${baseURL}/viewer/`)

    // Viewer shell boots
    await expect(page.locator('#container')).toBeAttached({ timeout: 5000 })
    await expect(page.locator('#controls')).toBeAttached({ timeout: 5000 })

    // Upload the test fixture via the hidden file input
    await page.locator('#file-input').setInputFiles(path.join(FIXTURE_DIR, 'dimer.xyz'))

    // After loading, frame info should show atom count
    await expect(page.locator('#frame-info')).toContainText('2 atoms', { timeout: 10000 })

    // Reconcile expected /outputs/ 404s against generic console errors
    expect(getUnexpectedErrors()).toEqual([])
  })

  test('rollback test: runs physics tests and all pass', async ({ page, baseURL }) => {
    const errors = collectErrors(page)

    await page.goto(`${baseURL}/page/test-rollback.html`)

    // Tests run automatically — wait for summary
    const summaryLocator = page.locator('#results pre', { hasText: 'Results:' })
    await expect(summaryLocator).toBeAttached({ timeout: 15000 })

    // Assert all tests passed
    await expect(summaryLocator).toContainText('0 failed')

    // Verify tests actually ran
    const passCount = await page.locator('#results pre.pass').count()
    expect(passCount).toBeGreaterThan(0)

    expect(errors).toEqual([])
  })
})

test.describe('Milestone D — React UI Migration', () => {

  test('settings sheet: opens, shows controls, closes', async ({ page, baseURL }) => {
    const errors = collectErrors(page)
    await page.goto(`${baseURL}/page/`)

    // Wait for app to initialize

    // Open settings via dock Settings button
    await page.locator('.dock .dock-text-only >> text=Settings').click()

    // Settings sheet should animate open (has .open class)
    const sheet = page.locator('.sheet').filter({ hasText: 'Settings' })
    await expect(sheet).toBeAttached({ timeout: 5000 })
    await expect(sheet).toHaveClass(/open/, { timeout: 3000 })

    // Verify all 6 settings groups are present
    await expect(sheet.locator('.group-header', { hasText: 'Scene' })).toBeAttached()
    await expect(sheet.locator('.group-header', { hasText: 'Simulation' })).toBeAttached()
    await expect(sheet.locator('.group-header', { hasText: 'Interaction' })).toBeAttached()
    await expect(sheet.locator('.group-header', { hasText: 'Appearance' })).toBeAttached()
    await expect(sheet.locator('.group-header', { hasText: 'Boundary' })).toBeAttached()
    await expect(sheet.locator('.group-header', { hasText: 'Help' })).toBeAttached()

    // Close via Escape — animation hook unmounts the sheet from DOM
    await page.keyboard.press('Escape')
    await expect(sheet).not.toBeAttached({ timeout: 3000 })

    expect(errors).toEqual([])
  })

  test('settings sheet: theme switch updates CSS tokens', async ({ page, baseURL }) => {
    const errors = collectErrors(page)
    await page.goto(`${baseURL}/page/`)

    // Open settings
    await page.locator('.dock .dock-text-only >> text=Settings').click()
    const sheet = page.locator('.sheet').filter({ hasText: 'Settings' })
    await expect(sheet).toHaveClass(/open/, { timeout: 3000 })

    // Click Light theme
    await sheet.locator('label', { hasText: 'Light' }).first().click()

    // Verify exact light-theme token: --color-text should be '#444'
    const lightText = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--color-text').trim()
    )
    expect(lightText).toBe('#444')

    // Toggle back to Dark and verify the dark token returns
    await sheet.locator('label', { hasText: 'Dark' }).first().click()
    const darkText = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--color-text').trim()
    )
    expect(darkText).toBe('#ccc')

    expect(errors).toEqual([])
  })

  test('settings sheet: help drill-in and back', async ({ page, baseURL }) => {
    const errors = collectErrors(page)
    await page.goto(`${baseURL}/page/`)

    // Open settings
    await page.locator('.dock .dock-text-only >> text=Settings').click()
    const sheet = page.locator('.sheet').filter({ hasText: 'Settings' })
    await expect(sheet).toHaveClass(/open/, { timeout: 3000 })

    // Click Controls help link
    await sheet.locator('.group-item', { hasText: 'Controls' }).click()

    // Help page should show, main page should be hidden
    await expect(sheet.locator('.help-section-title', { hasText: 'Interaction Modes' })).toBeVisible({ timeout: 3000 })

    // Click Back
    await sheet.locator('button', { hasText: 'Back' }).click()

    // Main page visible again
    await expect(sheet.locator('.group-header', { hasText: 'Scene' })).toBeVisible({ timeout: 3000 })

    expect(errors).toEqual([])
  })

  test('settings sheet: help page resets on close and reopen', async ({ page, baseURL }) => {
    const errors = collectErrors(page)
    await page.goto(`${baseURL}/page/`)

    const settingsBtn = page.locator('.dock .dock-text-only >> text=Settings')
    const sheet = page.locator('.sheet').filter({ hasText: 'Settings' })

    // Open settings → enter help page
    await settingsBtn.click()
    await expect(sheet).toHaveClass(/open/, { timeout: 3000 })
    await sheet.locator('.group-item', { hasText: 'Controls' }).click()
    await expect(sheet.locator('.help-section-title', { hasText: 'Interaction Modes' })).toBeVisible({ timeout: 3000 })

    // Close via Escape while on help page — sheet unmounts
    await page.keyboard.press('Escape')
    await expect(sheet).not.toBeAttached({ timeout: 3000 })

    // Reopen settings — main page should show, NOT help page
    await settingsBtn.click()
    await expect(sheet).toHaveClass(/open/, { timeout: 3000 })
    await expect(sheet.locator('.group-header', { hasText: 'Scene' })).toBeVisible({ timeout: 3000 })
    // Help content should NOT be visible
    await expect(sheet.locator('.help-section-title', { hasText: 'Interaction Modes' })).not.toBeVisible()

    expect(errors).toEqual([])
  })

  test('chooser sheet: opens, selection triggers callback', async ({ page, baseURL }) => {
    // Collect errors only BEFORE the structure click. After the click,
    // placement.start() may produce renderer errors in headless mode (no WebGL).
    const preClickErrors = collectErrors(page)
    await page.goto(`${baseURL}/page/`)

    // Open chooser via Add button
    await page.locator('.dock .dock-add-btn').click()

    // Chooser sheet should open with structure items
    const chooser = page.locator('.sheet').filter({ hasText: 'Choose Structure' })
    await expect(chooser).toHaveClass(/open/, { timeout: 3000 })
    await expect(chooser.locator('.drawer-item').first()).toBeAttached({ timeout: 5000 })

    // Items should have atom counts from manifest
    const firstItem = await chooser.locator('.drawer-item').first().textContent()
    expect(firstItem).toContain('atoms')

    // No errors before clicking a structure
    expect(preClickErrors).toEqual([])

    // Click a structure item — tests the full React callback chain:
    // React onClick → closeOverlay() + onSelectStructure(file, desc)
    // onSelectStructure sets store.recentStructure BEFORE placement.start()
    await chooser.locator('.drawer-item').first().click()

    // 1. Chooser closes and unmounts (proves closeOverlay fired)
    await expect(chooser).not.toBeAttached({ timeout: 3000 })

    // 2. Store records the selected structure (proves onSelectStructure fired).
    //    setRecentStructure is called before placement.start(), so it works without WebGL.
    const uiState = await page.evaluate(() => (window as any)._getUIState?.())
    expect(uiState).toBeTruthy()
    expect(uiState.recentStructure).toBeTruthy()
    expect(uiState.recentStructure.file).toBeTruthy()
    expect(uiState.recentStructure.name).toBeTruthy()
  })

  test('settings sheet: speed control updates store', async ({ page, baseURL }) => {
    const errors = collectErrors(page)
    await page.goto(`${baseURL}/page/`)
    await expect(page.locator('.dock')).toBeAttached({ timeout: 10000 })

    // Verify initial speed is 1x
    let ui = await page.evaluate(() => (window as any)._getUIState?.())
    expect(ui.targetSpeed).toBe(1)

    // Open settings
    await page.locator('.dock .dock-text-only >> text=Settings').click()
    const sheet = page.locator('.sheet').filter({ hasText: 'Settings' })
    await expect(sheet).toHaveClass(/open/, { timeout: 3000 })

    // Click 2x speed
    await sheet.locator('label', { hasText: '2x' }).click()
    ui = await page.evaluate(() => (window as any)._getUIState?.())
    expect(ui.targetSpeed).toBe(2)

    // Click Max speed
    await sheet.locator('label', { hasText: 'Max' }).click()
    ui = await page.evaluate(() => (window as any)._getUIState?.())
    expect(ui.targetSpeed).toBe(Infinity)

    // Click 1x to restore
    await sheet.locator('label', { hasText: '1x' }).click()
    ui = await page.evaluate(() => (window as any)._getUIState?.())
    expect(ui.targetSpeed).toBe(1)

    expect(errors).toEqual([])
  })

  test('settings sheet: boundary mode updates store', async ({ page, baseURL }) => {
    const errors = collectErrors(page)
    await page.goto(`${baseURL}/page/`)
    await expect(page.locator('.dock')).toBeAttached({ timeout: 10000 })

    // Verify initial boundary mode
    let ui = await page.evaluate(() => (window as any)._getUIState?.())
    expect(ui.boundaryMode).toBe('contain')

    // Open settings and switch to Remove
    await page.locator('.dock .dock-text-only >> text=Settings').click()
    const sheet = page.locator('.sheet').filter({ hasText: 'Settings' })
    await expect(sheet).toHaveClass(/open/, { timeout: 3000 })

    await sheet.locator('label', { hasText: 'Remove' }).click()
    ui = await page.evaluate(() => (window as any)._getUIState?.())
    expect(ui.boundaryMode).toBe('remove')

    // Switch back to Contain
    await sheet.locator('label', { hasText: 'Contain' }).click()
    ui = await page.evaluate(() => (window as any)._getUIState?.())
    expect(ui.boundaryMode).toBe('contain')

    expect(errors).toEqual([])
  })

  test('dock: interaction mode switching', async ({ page, baseURL }) => {
    const errors = collectErrors(page)
    await page.goto(`${baseURL}/page/`)
    await expect(page.locator('.dock')).toBeAttached({ timeout: 10000 })

    const dock = page.locator('.dock')

    // Initial mode is Atom
    let ui = await page.evaluate(() => (window as any)._getUIState?.())
    expect(ui.interactionMode).toBe('atom')

    // Click Move
    await dock.locator('label', { hasText: 'Move' }).click()
    ui = await page.evaluate(() => (window as any)._getUIState?.())
    expect(ui.interactionMode).toBe('move')

    // Click Rotate
    await dock.locator('label', { hasText: 'Rotate' }).click()
    ui = await page.evaluate(() => (window as any)._getUIState?.())
    expect(ui.interactionMode).toBe('rotate')

    // Click Atom to restore
    await dock.locator('label', { hasText: 'Atom' }).click()
    ui = await page.evaluate(() => (window as any)._getUIState?.())
    expect(ui.interactionMode).toBe('atom')

    expect(errors).toEqual([])
  })
})
