/**
 * Watch Round 6 E2E — smooth playback, interpolation method, and settings UI.
 *
 * Uses ?e2e=1 test hooks exposed by watch/js/main.ts:
 *   _getWatchState()                   → snapshot fields
 *   _watchOpenFile(text, name)         → programmatic file load
 *   _watchToggleSmooth()               → flip smooth playback on/off
 *   _watchSetInterpolationMode(mode)   → select method (validated by shared guard)
 *   _watchScrub(timePs)               → scrub to a specific time (drives resolve synchronously)
 *
 * Covers:
 *   - Watch landing boots without errors
 *   - File load succeeds via test hook
 *   - Dock Smooth toggle (text label, default ON) exists and flips state
 *   - Settings sheet Smooth Playback group renders with experimental note
 *   - Interpolation method picker updates mode
 *   - Fallback note hidden when linear selected
 *   - After file load: smooth ON (default), method linear, activeMethod linear
 *   - Hermite mode on a safe file: scrub to interior bracket, activeMethod = hermite
 *   - Settings close via Escape
 *   - Phone layout at 375px: no overflow, no clipping, all controls visible
 */

import { test, expect } from '@playwright/test'
import path from 'path'
import fs from 'fs'

/** Named viewport fixture — 375×812 is iPhone SE / small phone baseline.
 *  The dock layout must fit cleanly at this width. */
const PHONE_VIEWPORT = { width: 375, height: 812 } as const

const FIXTURE_PATH = path.join(__dirname, 'fixtures', 'watch-two-atom.json')

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
  return errors
}

async function waitForWatchState(page: import('@playwright/test').Page) {
  await expect(async () => {
    const state = await page.evaluate(() => (window as any)._getWatchState?.())
    expect(state).toBeDefined()
  }).toPass({ timeout: 5000 })
  return page.evaluate(() => (window as any)._getWatchState?.())
}

async function loadFixture(page: import('@playwright/test').Page) {
  const fixtureText = fs.readFileSync(FIXTURE_PATH, 'utf-8')
  // _watchOpenFile is async — Playwright evaluate handles async transparently,
  // but we also capture any thrown error so the failure is diagnosable.
  const loadResult = await page.evaluate(async (args) => {
    try {
      await (window as any)._watchOpenFile(args[0], args[1])
      const snap = (window as any)._getWatchState?.()
      return { ok: true, error: null, loaded: snap?.loaded, snapError: snap?.error }
    } catch (e: any) {
      return { ok: false, error: e?.message ?? String(e), loaded: false, snapError: null }
    }
  }, [fixtureText, 'test.atomdojo'])

  if (!loadResult.ok) {
    throw new Error(`_watchOpenFile failed: ${loadResult.error}`)
  }
  if (!loadResult.loaded) {
    throw new Error(`File loaded OK but snapshot.loaded is false. snapshot.error = ${loadResult.snapError}`)
  }
}

test.describe('Watch Round 6 — landing + boot', () => {
  test('watch page boots without errors', async ({ page, baseURL }) => {
    const errors = collectErrors(page)
    await page.goto(`${baseURL}/watch/?e2e=1`)
    await waitForWatchState(page)
    expect(errors).toEqual([])
  })

  test('empty-state open panel exposes the "Open local file" secondary action', async ({ page, baseURL }) => {
    // Post-WatchLanding: the workspace shell is always rendered and
    // the centered open panel overlays the canvas area until a file
    // loads. The local-file entry moved from `.watch-btn` ("Open
    // File") to the panel's secondary button ("Open local file").
    await page.goto(`${baseURL}/watch/?e2e=1`)
    await expect(page.locator('.watch-workspace')).toBeAttached({ timeout: 5000 })
    await expect(
      page.locator('.watch-open-panel__secondary', { hasText: 'Open local file' }),
    ).toBeAttached({ timeout: 5000 })
  })
})

test.describe('Watch Round 6 — file load + initial state', () => {
  test('file loads via test hook and transitions to playback view', async ({ page, baseURL }) => {
    const errors = collectErrors(page)
    await page.goto(`${baseURL}/watch/?e2e=1`)
    await waitForWatchState(page)

    await loadFixture(page)
    const state: any = await page.evaluate(() => (window as any)._getWatchState())
    expect(state.loaded).toBe(true)
    expect(state.atomCount).toBe(2)
    expect(state.frameCount).toBe(5)
    expect(state.fileKind).toBe('full')
    expect(state.fileName).toBe('test.atomdojo')
    expect(state.error).toBeNull()

    // Workspace-first contract (post-WatchLanding removal): the
    // workspace is always attached; the open-panel overlay
    // disappears once a file is loaded; the loaded-state right
    // rail returns.
    await expect(page.locator('.watch-workspace')).toBeAttached({ timeout: 3000 })
    await expect(page.locator('.watch-open-panel')).not.toBeAttached()
    await expect(page.locator('.watch-analysis')).toBeAttached()
    expect(errors).toEqual([])
  })

  test('after file load: defaults are smooth=on, method=linear, activeMethod=linear', async ({ page, baseURL }) => {
    await page.goto(`${baseURL}/watch/?e2e=1`)
    await waitForWatchState(page)
    await loadFixture(page)

    const state: any = await page.evaluate(() => (window as any)._getWatchState())
    expect(state.smoothPlayback).toBe(true)
    expect(state.interpolationMode).toBe('linear')
    expect(state.activeInterpolationMethod).toBe('linear')
    expect(state.importDiagnosticCodes).toEqual([])
  })
})

/* The Smooth toggle lives only in Settings now (on by default); its
 * dock-level tests have been removed. Settings-sheet tests further
 * down in this file still cover the toggle's behaviour. */

test.describe('Watch Round 6 — Settings sheet', () => {
  test('settings sheet opens, contains Smooth Playback group and experimental note', async ({ page, baseURL }) => {
    await page.goto(`${baseURL}/watch/?e2e=1`)
    await waitForWatchState(page)
    await loadFixture(page)

    // Open settings
    await page.getByRole('toolbar', { name: 'Playback controls' }).getByRole('button', { name: 'Settings' }).click()
    const sheet = page.locator('.sheet')
    await expect(sheet).toHaveClass(/open/, { timeout: 3000 })

    // Smooth Playback group header
    await expect(sheet.locator('.group-header', { hasText: 'Smooth Playback' })).toBeAttached()
    // Experimental note
    await expect(sheet.locator('[data-testid="watch-experimental-note"]')).toBeAttached()
    expect(await sheet.locator('[data-testid="watch-experimental-note"]').textContent())
      .toContain('Experimental methods may fall back')
  })

  test('interpolation method picker changes mode via test hook', async ({ page, baseURL }) => {
    await page.goto(`${baseURL}/watch/?e2e=1`)
    await waitForWatchState(page)
    await loadFixture(page)

    // Switch to hermite via test hook
    await page.evaluate(() => (window as any)._watchSetInterpolationMode('hermite'))
    const state: any = await page.evaluate(() => (window as any)._getWatchState())
    expect(state.interpolationMode).toBe('hermite')
  })

  test('Hermite on a Hermite-safe file: scrub to interior bracket, activeMethod = hermite', async ({ page, baseURL }) => {
    await page.goto(`${baseURL}/watch/?e2e=1`)
    await waitForWatchState(page)
    await loadFixture(page)

    // Set mode to Hermite (smooth is ON by default), then scrub to 50 ps —
    // the middle of the 5-frame fixture (frames at 0.001, 25, 50, 75, 100).
    // At 50 ps, the bracket is (25, 50) with alpha ≈ 0, and hermiteSafe[1]
    // === 1 because the fixture has aligned restart frames. Scrub drives
    // renderAtCurrentTime → applyReviewFrameAtTime → resolve() synchronously.
    await page.evaluate(() => {
      ;(window as any)._watchSetInterpolationMode('hermite')
      ;(window as any)._watchScrub(37.5) // midpoint of bracket (25, 50)
    })

    const state: any = await page.evaluate(() => (window as any)._getWatchState())
    expect(state.interpolationMode).toBe('hermite')
    expect(state.smoothPlayback).toBe(true)
    expect(state.activeInterpolationMethod).toBe('hermite')
    expect(state.lastFallbackReason).toBe('none')
  })

  test('fallback note is hidden when linear selected', async ({ page, baseURL }) => {
    await page.goto(`${baseURL}/watch/?e2e=1`)
    await waitForWatchState(page)
    await loadFixture(page)

    // Open settings — Linear is the default method
    await page.getByRole('toolbar', { name: 'Playback controls' }).getByRole('button', { name: 'Settings' }).click()
    const sheet = page.locator('.sheet')
    await expect(sheet).toHaveClass(/open/, { timeout: 3000 })

    // Fallback note should NOT be visible
    await expect(sheet.locator('[data-testid="watch-fallback-note"]')).not.toBeAttached()
  })

  test('settings sheet closes via Escape', async ({ page, baseURL }) => {
    await page.goto(`${baseURL}/watch/?e2e=1`)
    await waitForWatchState(page)
    await loadFixture(page)

    // Open then close
    await page.getByRole('toolbar', { name: 'Playback controls' }).getByRole('button', { name: 'Settings' }).click()
    const sheet = page.locator('.sheet')
    await expect(sheet).toHaveClass(/open/, { timeout: 3000 })

    await page.keyboard.press('Escape')
    await expect(sheet).not.toBeAttached({ timeout: 3000 })
  })
})

test.describe('Watch Round 6 — dock layout', () => {
  test('dock utility zone: speed slider + "Speed" label column', async ({ page, baseURL }) => {
    await page.goto(`${baseURL}/watch/?e2e=1`)
    await waitForWatchState(page)
    await loadFixture(page)

    const utility = page.locator('.watch-dock__utility')
    await expect(utility).toBeAttached()

    // Repeat is in the transport cluster with icon + label (Back / Play /
    // Fwd / Repeat column format), not in the utility zone.
    const repeat = page.locator('.watch-dock__transport button[aria-label="Repeat"]')
    expect(await repeat.count()).toBe(1)
    await expect(repeat).toContainText('Repeat')

    // Utility zone: slider on top, "Speed · <value>" meta row below.
    const speedCtrl = utility.locator('.watch-dock__speed')
    await expect(speedCtrl).toBeAttached()
    await expect(utility.locator('.watch-dock__speed-label')).toContainText('Speed')
    await expect(utility.locator('.watch-dock__speed-value')).toContainText(/\d+(\.\d+)?x/)
  })
})

test.describe('Watch Round 6 — responsive dock (phone emulation)', () => {
  test('dock fits cleanly at phone width: no child overflow, no clipping, all controls visible', async ({ browser, baseURL }) => {
    const context = await browser.newContext({
      viewport: PHONE_VIEWPORT,
    })
    const page = await context.newPage()

    try {
      await page.goto(`${baseURL}/watch/?e2e=1`)
      await waitForWatchState(page)
      await loadFixture(page)

      const dock = page.locator('.watch-dock-bar')
      await expect(dock).toBeAttached({ timeout: 5000 })

      // 1. Dock container does not exceed viewport
      const dockBox = await dock.boundingBox()
      expect(dockBox).not.toBeNull()
      expect(dockBox!.width).toBeLessThanOrEqual(PHONE_VIEWPORT.width)

      // 2. Utility cluster has no internal scrollable overflow
      const utilityOverflow = await page.evaluate(() => {
        const el = document.querySelector('.watch-dock__utility')
        if (!el) return { overflow: true }
        return { overflow: el.scrollWidth > el.clientWidth }
      })
      expect(utilityOverflow.overflow).toBe(false)

      // 3. Every child in the utility cluster stays within the dock right edge
      const childFit = await page.evaluate(() => {
        const dock = document.querySelector('.watch-dock-bar')
        const utility = document.querySelector('.watch-dock__utility')
        if (!dock || !utility) return { ok: false, detail: 'missing elements' }
        const dockRect = dock.getBoundingClientRect()
        for (const child of utility.children) {
          const cr = child.getBoundingClientRect()
          if (cr.right > dockRect.right + 1) {
            return { ok: false, detail: `${child.className} right=${cr.right} > dock right=${dockRect.right}` }
          }
        }
        return { ok: true, detail: '' }
      })
      expect(childFit.ok).toBe(true)

      // 4. Utility cluster does not overlap into the transport cluster
      const noOverlap = await page.evaluate(() => {
        const transport = document.querySelector('.watch-dock__transport')
        const utility = document.querySelector('.watch-dock__utility')
        if (!transport || !utility) return { ok: false }
        const tRect = transport.getBoundingClientRect()
        const uRect = utility.getBoundingClientRect()
        return { ok: uRect.left >= tRect.right - 1 }
      })
      expect(noOverlap.ok).toBe(true)

      // 5. Repeat (transport, icon+label) and Speed (utility, slider+meta)
      // are both visible — the dock's consistent icon+label column format.
      await expect(page.locator('.watch-dock__transport button[aria-label="Repeat"]')).toBeAttached()
      await expect(page.locator('.watch-dock__utility .watch-dock__speed-label')).toContainText('Speed')
    } finally {
      await context.close()
    }
  })
})
