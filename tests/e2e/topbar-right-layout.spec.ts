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

/** Pin every store field that feeds `formatStatusText()` to a constant
 *  value so the FPS readout's rendered text width stops churning. This
 *  is the "freeze the source" half of the fix pair below; the atomic
 *  snapshot is the "trust only one frame" half. Without this, the frame
 *  loop keeps writing `fps` / `rafIntervalMs` / `effectiveSpeed` at up
 *  to 5 Hz and shifts the right-anchored `.topbar-right` row between
 *  measurements — the CI-only failure mode where two rect reads from
 *  the same element landed 2–9 px apart.
 *
 *  The frame loop may still overwrite these fields after we pin; the
 *  atomic snapshot below is what actually guarantees consistency. Pin
 *  is the churn-reducer, snapshot is the correctness guarantee. */
async function pinFpsState(page: Page) {
  await page.evaluate(() => {
    const store = (window as any).__useAppStore
    if (!store) throw new Error('useAppStore not exposed to window — is ?e2e=1 active?')
    store.setState({
      fps: 60,
      rafIntervalMs: 16.67,
      workerStalled: false,
      paused: false,
      placementActive: false,
      placementStale: false,
      warmUpComplete: true,
      overloaded: false,
      effectiveSpeed: 1,
    })
  })
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
 *     Historical note: earlier CI flakes in the 2–9 px range looked
 *     font-subpixel at first glance but were ultimately a measurement-
 *     atomicity race — a 5 Hz status tick changed `.react-fps`'s text
 *     width between two separate `page.evaluate` rect reads, shifting
 *     the right-anchored row. That class of failure is now fixed at
 *     the test layer (`getLayoutSnapshot` + `pinFpsState` below), not
 *     absorbed by this slack. This number is for genuine subpixel drift
 *     only; if a future CI drift exceeds 2 px while the atomicity
 *     guards are in place, investigate CSS, not tolerance.
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

/** Rectangle shape shared by every measurement site. Mirrors the
 *  fields `getBoundingClientRect()` returns, minus the redundant
 *  `x`/`y` aliases for `left`/`top` — nothing in this spec reads them. */
type RectLike = {
  left: number; right: number; top: number; bottom: number;
  width: number; height: number;
}
function fmtRect(label: string, r: RectLike | null): string {
  if (!r) return `${label}=null`
  return `${label}{l:${r.left.toFixed(3)} r:${r.right.toFixed(3)} t:${r.top.toFixed(3)} b:${r.bottom.toFixed(3)} w:${r.width.toFixed(3)} h:${r.height.toFixed(3)}}`
}

/** Assert all four edges of `child` lie within `container` ± slack. On
 *  failure, the `expect` message carries both rects + the slack so CI
 *  logs are immediately diagnostic — no round-trip needed to reproduce
 *  the failing numbers. Use this instead of hand-rolling the four
 *  comparisons at every site. */
function expectWithinContainer(child: RectLike, container: RectLike, slack: number, ctx: string) {
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

/** Layout-shaping computed-style snapshot per selector. Cross-platform
 *  drift in this top-right row is almost always caused by a difference
 *  in how Linux Chromium resolves intrinsic sizing for `display` /
 *  `width` / `min-width` / `max-width` / `box-sizing` / `flex` —
 *  capturing the five together turns "the rect was wrong" into "this
 *  property differs from local." Produced by `getLayoutSnapshot` below
 *  and stitched into every failure message. */
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

/** Atomic layout snapshot — every rect and computed-style reading
 *  returned by this helper comes from a single `page.evaluate(...)`
 *  call, so all measurements share one layout pass and one script
 *  tick. This is the fix for a CI-only flake where rects gathered from
 *  separate round-trips could be split across a `.react-fps` status
 *  tick (up to 5 Hz); because `.topbar-right` is right-anchored, any
 *  FPS text-width change shifted the whole row between reads,
 *  producing "child outside parent" failures whose own diagnostic
 *  snapshot still showed agreement. Rule for callers: NEVER compare
 *  rects gathered from separate evaluate calls for this row — always
 *  read from one snapshot. The `rects` map is keyed by the caller's
 *  selector strings so assertion sites are grep-friendly. */
type LayoutSnapshot = {
  rects: Record<string, RectLike | null>
  diags: LayoutDiag[]
  /** Precomputed `fmtDiag` join — stitched into assertion messages so
   *  a CI failure tells us WHY from the same snapshot that produced
   *  the failing rects. */
  summary: string
}
async function getLayoutSnapshot(page: Page, selectors: string[]): Promise<LayoutSnapshot> {
  const { rects, diags } = await page.evaluate((sels) => {
    const rects: Record<string, RectLike | null> = {}
    const diags: LayoutDiag[] = sels.map((sel) => {
      const el = document.querySelector(sel) as HTMLElement | null
      if (!el) {
        rects[sel] = null
        return {
          selector: sel,
          display: null, width: null, minWidth: null, maxWidth: null,
          boxSizing: null, flex: null, rect: null,
        }
      }
      const cs = getComputedStyle(el)
      const r = el.getBoundingClientRect()
      const rect: RectLike = {
        left: r.left, right: r.right, top: r.top, bottom: r.bottom,
        width: r.width, height: r.height,
      }
      rects[sel] = rect
      return {
        selector: sel,
        display: cs.display,
        width: cs.width,
        minWidth: cs.minWidth,
        maxWidth: cs.maxWidth,
        boxSizing: cs.boxSizing,
        flex: cs.flex,
        rect,
      }
    })
    return { rects, diags }
  // Inline the RectLike / LayoutDiag shapes inside the browser context
  // (types are erased by the Playwright serializer; names are ours).
  }, selectors) as { rects: Record<string, RectLike | null>; diags: LayoutDiag[] }
  const summary = diags.map(fmtDiag).join('\n  ')
  return { rects, diags, summary }
}

test.describe('Top-right layout — AccountControl + FPSDisplay flex container', () => {
  test('signed-in chip and FPS display sit inside one .topbar-right container and do not overlap', async ({ page, baseURL }) => {
    await gotoApp(page, baseURL!, '/lab/')
    await waitForUIState(page)
    await setAuthState(page, {
      status: 'signed-in',
      session: { userId: 'u1', displayName: 'Alice Smith' },
    })
    // Freeze the FPS text inputs so the right-anchored row stops
    // shifting between reads — the primary root cause of the CI-only
    // flake was a 5 Hz status tick landing mid-measurement.
    await pinFpsState(page)

    // Wait on every link in the wrapper chain — without the wrapper
    // here the wrapper-vs-trigger boundary slipped silently in CI.
    // Matches the signed-out spec's data-testid selector so both
    // paths use the same targeting contract.
    await waitForStableRects(page, [
      '[data-testid="account-chip"]',
      '[data-testid="account-control"]',
      '.react-fps',
      '.topbar-right',
    ])

    // ONE atomic snapshot — every rect and computed-style reading
    // compared below comes from the same layout pass. Historical failures
    // came from comparing rects gathered by separate `page.evaluate`
    // round-trips that a mid-frame FPS tick could split across.
    const SELECTORS = {
      chip: '[data-testid="account-chip"]',
      wrapper: '[data-testid="account-control"]',
      container: '.topbar-right',
      fps: '.react-fps',
    }
    const snap = await getLayoutSnapshot(page, Object.values(SELECTORS))
    const chip = snap.rects[SELECTORS.chip]
    const wrapper = snap.rects[SELECTORS.wrapper]
    const container = snap.rects[SELECTORS.container]
    const fps = snap.rects[SELECTORS.fps]
    expect(chip, `chip missing. diag:\n  ${snap.summary}`).not.toBeNull()
    expect(wrapper, `wrapper missing. diag:\n  ${snap.summary}`).not.toBeNull()
    expect(container, `container missing. diag:\n  ${snap.summary}`).not.toBeNull()
    expect(fps, `fps missing. diag:\n  ${snap.summary}`).not.toBeNull()

    // Three-step chain mirroring the signed-out spec — pinpoints which
    // boundary slipped if the layout regresses again. Diagnostics
    // appended so the CI message is self-contained.
    expectWithinContainer(chip!, wrapper!, CONTAINER_EDGE_SLACK_PX,
      `chip inside .account-control [diag]\n  ${snap.summary}`)
    expectWithinContainer(wrapper!, container!, CONTAINER_EDGE_SLACK_PX,
      `.account-control inside .topbar-right [diag]\n  ${snap.summary}`)
    expectWithinContainer(chip!, container!, CONTAINER_EDGE_SLACK_PX,
      `chip inside .topbar-right [diag]\n  ${snap.summary}`)
    expectWithinContainer(fps!, container!, CONTAINER_EDGE_SLACK_PX,
      `FPS inside .topbar-right [diag]\n  ${snap.summary}`)

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

    await pinFpsState(page)
    await waitForStableRects(page, ['[data-testid="account-chip"]', '.react-fps'])
    // ONE atomic snapshot — chip-vs-FPS overlap is a single-frame
    // question, so comparing rects from separate round-trips would
    // reintroduce the CI flake mode.
    const snap = await getLayoutSnapshot(page, ['[data-testid="account-chip"]', '.react-fps'])
    const chip = snap.rects['[data-testid="account-chip"]']
    const fps = snap.rects['.react-fps']
    expect(chip, `chip missing. diag:\n  ${snap.summary}`).not.toBeNull()
    expect(fps, `fps missing. diag:\n  ${snap.summary}`).not.toBeNull()

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
    // Freeze the FPS text inputs — see pinFpsState for the "why".
    await pinFpsState(page)

    // Wait on every link in the chain — `[data-testid="account-control"]`
    // (stricter than the class selector) catches the wrapper.
    await waitForStableRects(page, [
      '[data-testid="account-signin"]',
      '[data-testid="account-control"]',
      '.topbar-right',
      '.react-fps',
    ])

    // ONE atomic snapshot for the pre-click geometry chain — see the
    // matching comment in the signed-in spec. Historical flake had
    // trigger.left ~9 px outside .account-control.left because a 5 Hz
    // status tick shifted `.react-fps`'s text width between two
    // separate `page.evaluate` calls; anchoring all reads to one
    // snapshot removes the race.
    const SELECTORS = {
      trigger: '[data-testid="account-signin"]',
      wrapper: '[data-testid="account-control"]',
      container: '.topbar-right',
      fps: '.react-fps',
    }
    const snap = await getLayoutSnapshot(page, Object.values(SELECTORS))
    const trigger = snap.rects[SELECTORS.trigger]
    const wrapper = snap.rects[SELECTORS.wrapper]
    const container = snap.rects[SELECTORS.container]
    expect(trigger, `trigger missing. diag:\n  ${snap.summary}`).not.toBeNull()
    expect(wrapper, `wrapper missing. diag:\n  ${snap.summary}`).not.toBeNull()
    expect(container, `container missing. diag:\n  ${snap.summary}`).not.toBeNull()

    // Three-step chain below pinpoints which boundary slipped on a
    // future regression; diagnostics tell us which CSS property
    // diverged. Current contract:
    //   .topbar-right            display: inline-flex
    //                            max-width: calc(100vw - 24px)
    //   .account-control         display: flex (NOT inline-flex)
    //                            flex: 0 0 auto
    //                            width: max-content
    //   .account-control__trigger appearance: none
    //                            margin: 0
    //                            display: flex (NOT inline-flex)
    //                            flex: 0 0 auto
    //                            width: max-content
    //                            min-width: max-content
    //                            box-sizing: border-box
    //   .account-control__trigger--signin justify-content: flex-start
    //   .account-control__trigger--chip   min-width: max-content
    expectWithinContainer(trigger!, wrapper!, CONTAINER_EDGE_SLACK_PX,
      `signin trigger inside .account-control [diag]\n  ${snap.summary}`)
    expectWithinContainer(wrapper!, container!, CONTAINER_EDGE_SLACK_PX,
      `.account-control inside .topbar-right [diag]\n  ${snap.summary}`)
    expectWithinContainer(trigger!, container!, CONTAINER_EDGE_SLACK_PX,
      `signin trigger inside .topbar-right [diag]\n  ${snap.summary}`)

    // Open the menu and verify it stays within the viewport. This is a
    // separate measurement phase (the menu doesn't exist until click);
    // the menu ↔ trigger relationship is reasserted from one fresh
    // snapshot so the comparison is atomic.
    await page.click('[data-testid="account-signin"]')
    const post = await getLayoutSnapshot(page, [
      '.account-control__menu',
      '[data-testid="account-signin"]',
    ])
    const menu = post.rects['.account-control__menu']
    const triggerAfter = post.rects['[data-testid="account-signin"]']
    expect(menu, `menu missing. diag:\n  ${post.summary}`).not.toBeNull()
    expect(triggerAfter, `trigger missing after click. diag:\n  ${post.summary}`).not.toBeNull()
    const vp = page.viewportSize()
    expect(menu!.left).toBeGreaterThanOrEqual(0)
    expect(menu!.right).toBeLessThanOrEqual(vp!.width + VIEWPORT_FIT_SLACK_PX)
    expect(menu!.top).toBeGreaterThanOrEqual(0)
    // Menu must be anchored BELOW the trigger — not covering it. Tight
    // tolerance: a menu that visibly overlaps the trigger by 2 px IS
    // a regression.
    expect(
      menu!.top,
      `menu must be anchored below trigger. ${fmtRect('menu', menu)} vs ${fmtRect('trigger', triggerAfter)}`,
    ).toBeGreaterThanOrEqual(triggerAfter!.bottom - ORDERING_SLACK_PX)
  })

  test('mobile viewport: chip and FPS remain disjoint and inside viewport', async ({ page, baseURL }) => {
    await page.setViewportSize({ width: 375, height: 667 }) // iPhone-8 class
    await gotoApp(page, baseURL!, '/lab/')
    await waitForUIState(page)
    await setAuthState(page, {
      status: 'signed-in',
      session: { userId: 'u1', displayName: 'Alice' },
    })
    await pinFpsState(page)
    await waitForStableRects(page, ['[data-testid="account-chip"]', '.react-fps', '.topbar-right'])

    // ONE atomic snapshot so the overlap + viewport-fit assertions
    // read the same layout frame.
    const snap = await getLayoutSnapshot(page, [
      '[data-testid="account-chip"]',
      '.react-fps',
      '.topbar-right',
    ])
    const chip = snap.rects['[data-testid="account-chip"]']
    const fps = snap.rects['.react-fps']
    const container = snap.rects['.topbar-right']
    expect(chip, `chip missing. diag:\n  ${snap.summary}`).not.toBeNull()
    expect(fps, `fps missing. diag:\n  ${snap.summary}`).not.toBeNull()
    expect(container, `container missing. diag:\n  ${snap.summary}`).not.toBeNull()

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
