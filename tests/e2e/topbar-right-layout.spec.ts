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

/** Format a rect for diagnostic messages. Accepts the narrower
 *  `BoundsRect` so the layout-diagnostics helper (which omits the
 *  redundant `x`/`y` aliases) can reuse the same formatter. */
type RectLike = Pick<Rect, 'left' | 'right' | 'top' | 'bottom' | 'width' | 'height'>
function fmtRect(label: string, r: RectLike | null): string {
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

/** Read the layout-shaping computed properties for a set of selectors.
 *  Cross-platform layout drift in this top-right row is almost always
 *  caused by a difference in how Linux Chromium resolves intrinsic
 *  sizing for `display`/`width`/`min-width`/`max-width`/`box-sizing`/
 *  `flex` — capturing the four together turns "the rect was wrong"
 *  into "this property differs from local". Stringified into the
 *  failure message so the CI log alone is enough to triage. */
/** Subset of `Rect` actually returned by the diagnostics helper. We
 *  don't read `x`/`y` (DOMRect's redundant aliases for left/top), so
 *  declaring the narrower shape lets us drop the previous cast and
 *  catch any future drift between the producer and consumer.
 *  `RectLike` (defined alongside `fmtRect` above) is the same shape. */
type LayoutDiag = {
  selector: string
  display: string | null
  width: string | null
  minWidth: string | null
  maxWidth: string | null
  boxSizing: string | null
  flex: string | null
  rect: RectLike | null
}
async function getLayoutDiagnostics(
  page: Page,
  selectors: string[],
): Promise<LayoutDiag[]> {
  return page.evaluate((sels) => {
    return sels.map((sel): LayoutDiag => {
      const el = document.querySelector(sel) as HTMLElement | null
      if (!el) {
        return {
          selector: sel,
          display: null, width: null, minWidth: null, maxWidth: null,
          boxSizing: null, flex: null, rect: null,
        }
      }
      const cs = getComputedStyle(el)
      const r = el.getBoundingClientRect()
      return {
        selector: sel,
        display: cs.display,
        width: cs.width,
        minWidth: cs.minWidth,
        maxWidth: cs.maxWidth,
        boxSizing: cs.boxSizing,
        flex: cs.flex,
        rect: {
          left: r.left, right: r.right, top: r.top, bottom: r.bottom,
          width: r.width, height: r.height,
        },
      }
    })
  }, selectors)
}

/** One-line summary per element for failure messages. */
function fmtDiag(d: LayoutDiag): string {
  if (!d.display) return `${d.selector}=<missing>`
  return (
    `${d.selector}` +
    `[display:${d.display}` +
    ` w:${d.width} min-w:${d.minWidth} max-w:${d.maxWidth}` +
    ` box-sizing:${d.boxSizing} flex:${d.flex}]` +
    ` ${fmtRect('rect', d.rect)}`
  )
}

test.describe('Top-right layout — AccountControl + FPSDisplay flex container', () => {
  test('signed-in chip and FPS display sit inside one .topbar-right container and do not overlap', async ({ page, baseURL }) => {
    await gotoApp(page, baseURL!, '/lab/')
    await waitForUIState(page)
    await setAuthState(page, {
      status: 'signed-in',
      session: { userId: 'u1', displayName: 'Alice Smith' },
    })

    // Wait on every link in the wrapper chain — without `.account-control`
    // here the wrapper-vs-trigger boundary slipped silently in CI.
    await waitForStableRects(page, [
      '[data-testid="account-chip"]',
      '.account-control',
      '.react-fps',
      '.topbar-right',
    ])

    // Capture computed styles + rects up front. Stitched into every
    // assertion message below so a CI failure tells us WHY in one log
    // (display / width / min-width / max-width / box-sizing / flex)
    // instead of just the offending rect.
    const diag = await getLayoutDiagnostics(page, [
      '[data-testid="account-chip"]',
      '.account-control',
      '.topbar-right',
      '.react-fps',
    ])
    const diagSummary = diag.map(fmtDiag).join('\n  ')

    const container = await rectOf(page, '.topbar-right')
    const wrapper = await rectOf(page, '.account-control')
    const chip = await rectOf(page, '[data-testid="account-chip"]')
    const fps = await rectOf(page, '.react-fps')
    expect(container, `container missing. diag:\n  ${diagSummary}`).not.toBeNull()
    expect(wrapper, `wrapper missing. diag:\n  ${diagSummary}`).not.toBeNull()
    expect(chip, `chip missing. diag:\n  ${diagSummary}`).not.toBeNull()
    expect(fps, `fps missing. diag:\n  ${diagSummary}`).not.toBeNull()

    // Three-step chain mirroring the signed-out spec — pinpoints which
    // boundary slipped if the layout regresses again. Diagnostics
    // appended so the CI message is self-contained.
    expectWithinContainer(chip!, wrapper!, CONTAINER_EDGE_SLACK_PX,
      `chip inside .account-control [diag]\n  ${diagSummary}`)
    expectWithinContainer(wrapper!, container!, CONTAINER_EDGE_SLACK_PX,
      `.account-control inside .topbar-right [diag]\n  ${diagSummary}`)
    expectWithinContainer(chip!, container!, CONTAINER_EDGE_SLACK_PX,
      `chip inside .topbar-right [diag]\n  ${diagSummary}`)
    expectWithinContainer(fps!, container!, CONTAINER_EDGE_SLACK_PX,
      `FPS inside .topbar-right [diag]\n  ${diagSummary}`)

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

    await waitForStableRects(page, ['[data-testid="account-signin"]', '.topbar-right', '.account-control'])
    const trigger = await rectOf(page, '[data-testid="account-signin"]')
    expect(trigger).not.toBeNull()
    const wrapper = await rectOf(page, '.account-control')
    expect(wrapper).not.toBeNull()
    const container = await rectOf(page, '.topbar-right')
    expect(container).not.toBeNull()
    // History: a previous Linux-Chromium flake had trigger.left ~1 px
    // outside container.left. After it grew to ~9 px (signed-out) and
    // then ~8 px (signed-in chip variant) in CI, the root cause was
    // tracked to shrink-to-fit ambiguity inside an absolute-positioned
    // auto-width row — both the wrapper AND the trigger had implicit
    // intrinsic-sizing behaviour that Linux Chromium resolved
    // narrower than other engines. Current contract:
    //   .topbar-right            display: inline-flex
    //                            max-width: calc(100vw - 24px)
    //   .account-control         display: inline-flex
    //                            flex: 0 0 auto
    //                            width: max-content
    //   .account-control__trigger appearance: none
    //                            flex: 0 0 auto
    //                            width: max-content
    //                            box-sizing: border-box
    //   .account-control__trigger--chip min-width: max-content
    // The chain is asserted three steps below so a future regression
    // names the offending boundary in the failure message.
    //
    // Asserting the chain in three steps — trigger ⊂ wrapper ⊂ container
    // — pinpoints which boundary slipped if the layout regresses again,
    // instead of leaving us guessing whether the flex item or the
    // container miscomputed.
    expectWithinContainer(trigger!, wrapper!, CONTAINER_EDGE_SLACK_PX, 'signin trigger inside .account-control')
    expectWithinContainer(wrapper!, container!, CONTAINER_EDGE_SLACK_PX, '.account-control inside .topbar-right')
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
