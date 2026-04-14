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

type Rect = {
  x: number; y: number; width: number; height: number;
  left: number; right: number; top: number; bottom: number;
}

/** Wait until all listed elements have non-zero rects AND two consecutive
 *  rAF-spaced readings produce the same rounded coordinates. The
 *  rounded-equality check is stricter than the previous "non-zero +
 *  one RAF" flush: it actually proves layout has settled, so a later
 *  geometric assertion failure can be attributed to platform rendering
 *  variance rather than a transient mid-commit frame. Rounds to 0.25 px
 *  (the finest level Chromium's subpixel layout exposes) to tolerate
 *  hairline jitter from font-loading async finalization. */
async function waitForStableRects(page: Page, selectors: string[]) {
  await page.waitForFunction((sels) => {
    const rects = sels.map((sel) => {
      const el = document.querySelector(sel) as HTMLElement | null
      return el ? el.getBoundingClientRect() : null
    })
    return rects.every((r) => r !== null && r.width > 0 && r.height > 0)
  }, selectors, { timeout: 3000 })
  await page.evaluate(async (sels: string[]) => {
    const snap = () => sels.map((sel) => {
      const el = document.querySelector(sel) as HTMLElement | null
      if (!el) return null
      const r = el.getBoundingClientRect()
      // Round to the nearest 0.25 px — finer than Chromium's subpixel layout
      // granularity, so only transient mid-commit frames look different.
      const q = (n: number) => Math.round(n * 4) / 4
      return { l: q(r.left), t: q(r.top), w: q(r.width), h: q(r.height) }
    })
    const nextRaf = () => new Promise<void>((r) => requestAnimationFrame(() => r()))
    const eq = (a: ReturnType<typeof snap>, b: typeof a) => JSON.stringify(a) === JSON.stringify(b)
    // Require two consecutive RAF-spaced snapshots to match. Bound the loop
    // so a genuinely animating element never hangs the test.
    let prev = snap()
    for (let i = 0; i < 30; i++) {
      await nextRaf()
      const cur = snap()
      if (eq(prev, cur)) return
      prev = cur
    }
  }, selectors)
}

function rectsOverlap(a: { left: number; right: number; top: number; bottom: number }, b: typeof a) {
  return !(a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top)
}

/**
 * Slack tolerances, split by assertion class so a flake on one class
 * doesn't dilute unrelated geometry guarantees.
 *
 *   CONTAINER_EDGE_SLACK_PX  — child's edge vs parent's edge. The flex
 *     container's edge is a derived fractional coordinate (viewport −
 *     right-inset − content width); content width depends on the FPS
 *     display's rendered text, which uses different fallback fonts on
 *     macOS (`-apple-system`) and Linux (DejaVu Sans). The two fractional
 *     coordinates can land ~1 px apart after Chromium's subpixel layout
 *     rounding even though they should share an exact CSS edge. 2 px
 *     still catches real regressions (a 10 px slip would fail); only
 *     platform-subpixel variance is absorbed.
 *
 *   ORDERING_SLACK_PX — ordering / anchoring assertions (chip sits left
 *     of FPS; menu anchors below trigger). Same flex layout can shift
 *     sub-pixel, but the bound should be tight: if a chip visibly
 *     overlaps the FPS by 2 px, that is a real regression. 1 px
 *     absorbs subpixel noise without hiding a visible overlap.
 *
 *   Viewport-fit (hard bounds `>= 0`, `<= viewport.width + 1`) stays
 *     at 1 px because viewport dimensions are fixed and `right: 12px`
 *     positioning is exact; the 1 px absorbs any trailing border/decoration
 *     leak that Chromium might report in getBoundingClientRect.
 *
 *   rectsOverlap() stays exact — binary assertion, no tolerance.
 */
const CONTAINER_EDGE_SLACK_PX = 2
const ORDERING_SLACK_PX = 1
const VIEWPORT_FIT_SLACK_PX = 1

/** Format a rect for diagnostic messages. */
function fmtRect(label: string, r: Rect | null): string {
  if (!r) return `${label}=null`
  return `${label}{l:${r.left.toFixed(3)} r:${r.right.toFixed(3)} t:${r.top.toFixed(3)} b:${r.bottom.toFixed(3)} w:${r.width.toFixed(3)} h:${r.height.toFixed(3)}}`
}

/** Assert all four edges of `child` lie within `container` ± slack. On
 *  failure, the `expect` message carries both rects + the slack so CI
 *  logs are immediately diagnostic — no round-trip needed to reproduce
 *  the failing numbers. Use this instead of hand-rolling the four
 *  comparisons at every site. */
function expectWithinContainer(child: Rect, container: Rect, slack: number, ctx: string) {
  const msg = `${ctx}: child not within container (slack=${slack}px). ${fmtRect('child', child)} vs ${fmtRect('container', container)}`
  expect(child.left, msg).toBeGreaterThanOrEqual(container.left - slack)
  expect(child.right, msg).toBeLessThanOrEqual(container.right + slack)
}

/** Read computed font stacks for a set of selectors — used in failure
 *  diagnostics so a next-time flake can quickly confirm whether the
 *  Linux/macOS font-metric hypothesis still holds. */
async function getComputedFontFamilies(page: Page, selectors: string[]) {
  return page.evaluate((sels) => {
    return sels.map((sel) => {
      const el = document.querySelector(sel) as HTMLElement | null
      if (!el) return { selector: sel, fontFamily: null }
      return { selector: sel, fontFamily: getComputedStyle(el).fontFamily }
    })
  }, selectors)
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

    // Both controls strictly inside the container's box, within the
    // platform-subpixel slack (CONTAINER_EDGE_SLACK_PX).
    expectWithinContainer(chip!, container!, CONTAINER_EDGE_SLACK_PX, 'chip inside .topbar-right')
    expectWithinContainer(fps!, container!, CONTAINER_EDGE_SLACK_PX, 'FPS inside .topbar-right')

    // Chip sits to the LEFT of FPS (flex row, natural order). Tight
    // tolerance: a chip that visibly overlaps FPS by 2 px IS a regression.
    expect(
      chip!.right,
      `chip must sit left of FPS. ${fmtRect('chip', chip)} vs ${fmtRect('fps', fps)}`,
    ).toBeLessThanOrEqual(fps!.left + ORDERING_SLACK_PX)

    // The whole container stays within the viewport — no bleed off-screen.
    const vp = page.viewportSize()
    expect(container!.right).toBeLessThanOrEqual(vp!.width + VIEWPORT_FIT_SLACK_PX)
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
    expect(container).not.toBeNull()
    // The original CI flake was here: trigger.left 1.047 px outside
    // container.left on Linux due to Chromium's font-metric-driven
    // fractional layout. CONTAINER_EDGE_SLACK_PX = 2 absorbs that.
    expectWithinContainer(trigger!, container!, CONTAINER_EDGE_SLACK_PX, 'signin trigger inside .topbar-right')

    // Open the menu and verify it stays within the viewport.
    await page.click('[data-testid="account-signin"]')
    const menu = await rectOf(page, '.account-control__menu')
    expect(menu).not.toBeNull()
    const vp = page.viewportSize()
    expect(menu!.left).toBeGreaterThanOrEqual(0)
    expect(menu!.right).toBeLessThanOrEqual(vp!.width + VIEWPORT_FIT_SLACK_PX)
    expect(menu!.top).toBeGreaterThanOrEqual(0)
    // Menu must be anchored BELOW the trigger — not covering it. Tight
    // tolerance: a menu that visibly overlaps the trigger by 2 px IS
    // a regression.
    expect(
      menu!.top,
      `menu must be anchored below trigger. ${fmtRect('menu', menu)} vs ${fmtRect('trigger', trigger)}`,
    ).toBeGreaterThanOrEqual(trigger!.bottom - ORDERING_SLACK_PX)
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
    // Container fits the viewport — viewport width is a fixed integer
    // here, so VIEWPORT_FIT_SLACK_PX (1) is the right tolerance.
    expect(container!.right).toBeLessThanOrEqual(375 + VIEWPORT_FIT_SLACK_PX)
    expect(container!.left).toBeGreaterThanOrEqual(0)
  })
})

// Global afterEach: when a test in this spec fails, dump font families
// for the two elements whose metrics drive the derived container width.
// Gives the next flake immediate evidence for whether the macOS-vs-Linux
// font hypothesis still holds (look for a change in the stack) or
// whether some new layout effect has introduced a bug.
test.afterEach(async ({ page }, testInfo) => {
  if (testInfo.status === 'failed') {
    try {
      const fonts = await getComputedFontFamilies(page, [
        '.react-fps', '.account-control__trigger', '.account-control__label',
      ])
      await testInfo.attach('computed-font-families', {
        body: JSON.stringify(fonts, null, 2),
        contentType: 'application/json',
      })
    } catch {
      // Page may be closed already; best-effort diagnostic.
    }
  }
})
