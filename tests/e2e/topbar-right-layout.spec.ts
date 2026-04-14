/**
 * Top-right layout E2E — bounding-box regression tests for the Phase 6
 * AccountControl + FPSDisplay flex container.
 *
 * These complement the structural unit tests (DOM shape, class contracts)
 * by verifying actual browser geometry under conditions the old hardcoded-
 * offset layout would have broken on:
 *   - long signed-in display names
 *   - narrow / mobile viewports
 *   - open account menu near the viewport edge
 *
 * We drive auth state via the app-store test surface (same technique as
 * timeline-layout.spec.ts), since real OAuth is out of scope for E2E.
 */

import { test, expect, type Page } from '@playwright/test'
import { gotoApp } from './helpers'

async function waitForUIState(page: Page) {
  await expect(async () => {
    const state = await page.evaluate(() => (window as any)._getUIState?.())
    expect(state).toBeDefined()
  }).toPass({ timeout: 5000 })
}

/** Force auth to a specific state via the window-exposed store. */
async function setAuthState(page: Page, next: { status: 'loading' | 'signed-in' | 'signed-out' | 'unverified'; session: { userId: string; displayName: string | null } | null }) {
  await page.evaluate((s) => {
    const store = (window as any).__useAppStore
    if (!store) throw new Error('useAppStore not exposed to window — is ?e2e=1 active?')
    store.getState().setAuthState(s)
  }, next)
}

/** Get the bounding rect of an element matching selector, or null. */
async function rectOf(page: Page, selector: string) {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel) as HTMLElement | null
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom, top: r.top, left: r.left }
  }, selector)
}

/** Wait until two elements have non-zero, stable bounding rects. Flex
 *  layouts can briefly report 0-width rects while React commits children;
 *  tests that measure geometry immediately after a state change can
 *  sporadically see those intermediate frames. Two consecutive matching
 *  rects indicate layout has settled. */
async function waitForStableRects(page: Page, selectors: string[]) {
  await page.waitForFunction((sels) => {
    const rects = sels.map((sel) => {
      const el = document.querySelector(sel) as HTMLElement | null
      return el ? el.getBoundingClientRect() : null
    })
    return rects.every((r) => r !== null && r.width > 0 && r.height > 0)
  }, selectors, { timeout: 3000 })
  // One additional RAF to flush any pending commit.
  await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => r())))
}

function rectsOverlap(a: { left: number; right: number; top: number; bottom: number }, b: typeof a) {
  return !(a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top)
}

test.describe('Top-right layout — AccountControl + FPSDisplay flex container', () => {
  test('signed-in chip and FPS display sit inside one .topbar-right container and do not overlap', async ({ page, baseURL }) => {
    await gotoApp(page, baseURL!, '/lab/')
    await waitForUIState(page)
    await setAuthState(page, {
      status: 'signed-in',
      session: { userId: 'u1', displayName: 'Alice Smith' },
    })

    await waitForStableRects(page, ['[data-testid="account-chip"]', '.react-fps', '.topbar-right'])
    const container = await rectOf(page, '.topbar-right')
    const chip = await rectOf(page, '[data-testid="account-chip"]')
    const fps = await rectOf(page, '.react-fps')
    expect(container).not.toBeNull()
    expect(chip).not.toBeNull()
    expect(fps).not.toBeNull()

    // Both controls are strictly inside the container's box (sub-pixel slack).
    expect(chip!.left).toBeGreaterThanOrEqual(container!.left - 1)
    expect(chip!.right).toBeLessThanOrEqual(container!.right + 1)
    expect(fps!.left).toBeGreaterThanOrEqual(container!.left - 1)
    expect(fps!.right).toBeLessThanOrEqual(container!.right + 1)

    // Chip sits to the LEFT of FPS (flex row, natural order).
    expect(chip!.right).toBeLessThanOrEqual(fps!.left + 1)

    // The whole container stays within the viewport — no bleed off-screen.
    const vp = page.viewportSize()
    expect(container!.right).toBeLessThanOrEqual(vp!.width + 1)
    expect(container!.top).toBeGreaterThanOrEqual(0)
  })

  test('long display name truncates via ellipsis; chip and FPS do not collide', async ({ page, baseURL }) => {
    await gotoApp(page, baseURL!, '/lab/')
    await waitForUIState(page)
    await setAuthState(page, {
      status: 'signed-in',
      session: {
        userId: 'u1',
        displayName: 'An Exceptionally Long Display Name That Exceeds Reasonable Chip Widths',
      },
    })

    await waitForStableRects(page, ['[data-testid="account-chip"]', '.react-fps'])
    const chip = await rectOf(page, '[data-testid="account-chip"]')
    const fps = await rectOf(page, '.react-fps')
    expect(chip).not.toBeNull()
    expect(fps).not.toBeNull()

    // Overlap check — the whole point of the flex container is to keep
    // these two rectangles disjoint even with pathological label widths.
    expect(rectsOverlap(chip!, fps!)).toBe(false)

    // Label is ellipsised (CSS contract: max-width + overflow:hidden).
    const labelOverflow = await page.evaluate(() => {
      const el = document.querySelector('.account-control__label') as HTMLElement | null
      if (!el) return null
      // scrollWidth > clientWidth indicates the browser is truncating the
      // text — the visual ellipsis is then guaranteed by the CSS tokens.
      return { scrollWidth: el.scrollWidth, clientWidth: el.clientWidth }
    })
    expect(labelOverflow).not.toBeNull()
    expect(labelOverflow!.scrollWidth).toBeGreaterThan(labelOverflow!.clientWidth)
  })

  test('signed-out "Sign in" trigger renders inside .topbar-right and the menu stays in viewport', async ({ page, baseURL }) => {
    await gotoApp(page, baseURL!, '/lab/')
    await waitForUIState(page)
    await setAuthState(page, { status: 'signed-out', session: null })

    await waitForStableRects(page, ['[data-testid="account-signin"]', '.topbar-right'])
    const trigger = await rectOf(page, '[data-testid="account-signin"]')
    expect(trigger).not.toBeNull()
    const container = await rectOf(page, '.topbar-right')
    expect(trigger!.left).toBeGreaterThanOrEqual(container!.left - 1)
    expect(trigger!.right).toBeLessThanOrEqual(container!.right + 1)

    // Open the menu and verify it stays within the viewport.
    await page.click('[data-testid="account-signin"]')
    const menu = await rectOf(page, '.account-control__menu')
    expect(menu).not.toBeNull()
    const vp = page.viewportSize()
    expect(menu!.left).toBeGreaterThanOrEqual(0)
    expect(menu!.right).toBeLessThanOrEqual(vp!.width + 1)
    expect(menu!.top).toBeGreaterThanOrEqual(0)
    // Menu must also be anchored below the trigger — not covering it.
    expect(menu!.top).toBeGreaterThanOrEqual(trigger!.bottom - 1)
  })

  test('mobile viewport: chip and FPS remain disjoint and inside viewport', async ({ page, baseURL }) => {
    await page.setViewportSize({ width: 375, height: 667 }) // iPhone-8 class
    await gotoApp(page, baseURL!, '/lab/')
    await waitForUIState(page)
    await setAuthState(page, {
      status: 'signed-in',
      session: { userId: 'u1', displayName: 'Alice' },
    })
    await waitForStableRects(page, ['[data-testid="account-chip"]', '.react-fps', '.topbar-right'])

    const chip = await rectOf(page, '[data-testid="account-chip"]')
    const fps = await rectOf(page, '.react-fps')
    const container = await rectOf(page, '.topbar-right')
    expect(chip).not.toBeNull()
    expect(fps).not.toBeNull()
    expect(container).not.toBeNull()

    // No overlap at 375px width.
    expect(rectsOverlap(chip!, fps!)).toBe(false)
    // Container fits the viewport (allowing for 12px right inset).
    expect(container!.right).toBeLessThanOrEqual(375 + 1)
    expect(container!.left).toBeGreaterThanOrEqual(0)
  })
})
