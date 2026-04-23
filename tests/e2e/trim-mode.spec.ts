/**
 * Trim-mode E2E — verifies the NON-MODAL contract.
 *
 * The core invariant this spec guards is one jsdom can't: in a real
 * browser, a full-screen modal backdrop with `pointer-events: auto`
 * would intercept clicks/drags targeted at the trim handles that live
 * outside the dialog's DOM subtree. We trigger the oversize flow,
 * drive the Share panel into trim mode, and assert:
 *
 *   1. The `.timeline-dialog-backdrop` element is NOT rendered.
 *   2. The dialog card carries `aria-modal="false"` and the
 *      `--trim-floating` class variant.
 *   3. The trim handles are visible AND receive real pointer events
 *      (verified by reading `aria-valuenow` before/after a drag).
 *   4. Tab can reach the trim handles from inside the dialog.
 *   5. Cancel restores the pre-trim review/live state.
 */

import { test, expect } from '@playwright/test'
import type { Page } from '@playwright/test'
import { gotoApp } from './helpers'

function collectErrors(page: Page) {
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

async function waitForUIState(page: Page) {
  await expect(async () => {
    const state = await page.evaluate(() => (window as any)._getUIState?.())
    expect(state).toBeDefined()
  }).toPass({ timeout: 5000 })
}

/**
 * Inject e2e callbacks that trigger the oversize/trim flow without
 * needing a real server. Uses the exposed `window.__useAppStore` +
 * `window.__PublishOversizeError` that main.ts installs under
 * `?e2e=1`.
 *
 * Also captures a log of lifecycle callback invocations on
 * `window.__trimLog` so tests can assert Cancel restore ordering.
 */
async function installTrimHarness(page: Page) {
  await page.evaluate(() => {
    const store = (window as any).__useAppStore
    const PublishOversizeError = (window as any).__PublishOversizeError
    if (!store || !PublishOversizeError) {
      throw new Error(
        'e2e harness not wired: __useAppStore and __PublishOversizeError must both be present under ?e2e=1',
      )
    }
    const log: string[] = []
    ;(window as any).__trimLog = log
    const frames = Array.from({ length: 12 }, (_, i) => ({ frameId: i, timePs: i }))
    const state = store.getState()

    let prepareCounter = 0
    state.installTimelineUI(
      {
        onScrub: (t: number) => log.push(`scrub:${t}`),
        onReturnToLive: () => log.push('return-to-live'),
        onEnterReview: () => log.push('enter-review'),
        onRestartFromHere: () => log.push('restart'),
        onStartRecordingNow: () => log.push('start-recording'),
        onTurnRecordingOff: () => log.push('turn-off'),
        onPauseForExport: () => { log.push('pause'); return true },
        onResumeFromExport: () => log.push('resume'),
        onPublishCapsule: async () => {
          throw new PublishOversizeError({
            actualBytes: 25 * 1024 * 1024,
            maxBytes: 20 * 1024 * 1024,
            source: '413',
            message: 'Too large',
          })
        },
        onExportHistory: async () => 'saved',
        getCapsuleFrameIndex: () => ({ snapshotId: 'v:0:0:0', frames }),
        onPrepareCapsulePublish: async (range: { startFrameIndex: number; endFrameIndex: number }) => {
          prepareCounter += 1
          return {
            prepareId: `p-${prepareCounter}`,
            bytes: 10 * 1024 * 1024,
            maxBytes: 20 * 1024 * 1024,
            maxSource: 'client-fallback' as const,
            frameCount: range.endFrameIndex - range.startFrameIndex + 1,
          }
        },
        onPublishPreparedCapsule: async () => ({
          shareCode: 'TEST1234ABCD',
          shareUrl: 'https://example.com/c/TEST1234ABCD',
        }),
        onCancelPreparedPublish: () => log.push('cancel-prepared'),
      },
      'active',
      { full: true, capsule: true },
    )
    state.updateTimelineState({
      mode: 'live',
      currentTimePs: 11,
      reviewTimePs: null,
      rangePs: { start: 0, end: 11 },
      canReturnToLive: false,
      canRestart: false,
      restartTargetPs: null,
    })
    // Sign in (trim UI requires signed-in auth).
    state.setAuthSignedIn({ userId: 'e2e-user', displayName: 'E2E User' })
  })
}

/**
 * Drive the dialog into trim mode: open via the Transfer trigger,
 * switch to Share tab, click Publish (which rejects with the
 * injected PublishOversizeError).
 */
async function enterTrimMode(page: Page) {
  await page.locator('.timeline-transfer-trigger').click()
  // Default tab is Share when shareAvailable — we should already be
  // on it, but click defensively to be deterministic.
  const shareTab = page.locator('.timeline-transfer-dialog__tab', { hasText: /Share/ })
  if (await shareTab.count()) {
    await shareTab.click().catch(() => {})
  }
  const publish = page.locator('.timeline-transfer-dialog__confirm', { hasText: /Publish/ })
  await publish.click()
  // Wait for trim UI to render.
  await expect(page.locator('[data-testid="transfer-share-trim"]')).toBeVisible({ timeout: 4000 })
}

test.describe('Trim mode — non-modal contract', () => {
  test('renders non-modal with no backdrop and floating-variant card', async ({ page, baseURL }) => {
    const errors = collectErrors(page)
    await gotoApp(page, baseURL!, '/lab/')
    await waitForUIState(page)
    await installTrimHarness(page)
    await enterTrimMode(page)

    // No backdrop element at all.
    await expect(page.locator('.timeline-dialog-backdrop')).toHaveCount(0)

    // Dialog card announces itself as non-modal and carries the
    // floating variant class so CSS positions it above the timeline.
    const card = page.locator('.timeline-transfer-dialog')
    await expect(card).toHaveAttribute('aria-modal', 'false')
    await expect(card).toHaveClass(/timeline-transfer-dialog--trim-floating/)
    await expect(card).toHaveAttribute('aria-describedby', /.+/)

    expect(errors).toEqual([])
  })

  test('trim handles are visible and not occluded by the dialog card', async ({ page, baseURL }) => {
    const errors = collectErrors(page)
    await gotoApp(page, baseURL!, '/lab/')
    await waitForUIState(page)
    await installTrimHarness(page)
    await enterTrimMode(page)

    const startHandle = page.locator('[data-testid="timeline-trim-handle-start"]')
    const endHandle = page.locator('[data-testid="timeline-trim-handle-end"]')
    await expect(startHandle).toBeVisible()
    await expect(endHandle).toBeVisible()

    // The elementFromPoint at each handle's center must BE that
    // handle (or one of its children), not the dialog card or the
    // backdrop. This is the real-browser assertion jsdom cannot make.
    for (const handle of ['timeline-trim-handle-start', 'timeline-trim-handle-end']) {
      // Report enough layout state in the failure message to diagnose
      // future regressions (viewport/dialog/shell rects) without
      // bloating the success path. jsdom cannot make this assertion;
      // the whole point is to prove that in a real browser the
      // topmost element at the handle's visual center IS the handle.
      const diagnostic = await page.evaluate((testid) => {
        const el = document.querySelector(`[data-testid="${testid}"]`) as HTMLElement | null
        if (!el) return { ok: false as const, reason: 'handle not in DOM' as const }
        const r = el.getBoundingClientRect()
        const cx = r.left + r.width / 2
        const cy = r.top + r.height / 2
        const top = document.elementFromPoint(cx, cy) as HTMLElement | null
        const ok = !!top && (top === el || el.contains(top) || top.closest(`[data-testid="${testid}"]`) !== null)
        const dialog = document.querySelector('.timeline-transfer-dialog') as HTMLElement | null
        const shell = document.querySelector('.timeline-shell') as HTMLElement | null
        return {
          ok,
          handleRect: { x: r.x, y: r.y, w: r.width, h: r.height },
          topTag: top?.tagName ?? null,
          topClass: top?.className ?? null,
          viewport: { w: window.innerWidth, h: window.innerHeight },
          dialogRect: dialog?.getBoundingClientRect()?.toJSON?.() ?? null,
          shellRect: shell?.getBoundingClientRect()?.toJSON?.() ?? null,
        }
      }, handle)
      expect(
        diagnostic.ok,
        `${handle} must be the topmost element at its center — got ${JSON.stringify(diagnostic)}`,
      ).toBe(true)
    }

    expect(errors).toEqual([])
  })

  test('dragging a handle updates aria-valuenow (real pointer drag, not programmatic)', async ({ page, baseURL }) => {
    const errors = collectErrors(page)
    await gotoApp(page, baseURL!, '/lab/')
    await waitForUIState(page)
    await installTrimHarness(page)
    await enterTrimMode(page)

    const endHandle = page.locator('[data-testid="timeline-trim-handle-end"]')
    await expect(endHandle).toBeVisible()
    const before = await endHandle.getAttribute('aria-valuenow')

    // Drag the end handle ~80px to the left via a real pointer
    // sequence. If the backdrop were covering the handle, this drag
    // would never fire the pointermove -> selection change path.
    const box = await endHandle.boundingBox()
    expect(box).not.toBeNull()
    const startX = box!.x + box!.width / 2
    const startY = box!.y + box!.height / 2
    await page.mouse.move(startX, startY)
    await page.mouse.down()
    await page.mouse.move(startX - 80, startY, { steps: 10 })
    await page.mouse.up()

    const after = await endHandle.getAttribute('aria-valuenow')
    expect(after).not.toBe(before)
    // After drag-end the status row must update away from the
    // "Finding the best fit…" / stale state. Either a concrete size
    // appears or the row is in "Checking selection…".
    const status = page.locator('[data-testid="transfer-share-trim-status"]')
    await expect(status).toBeVisible()

    expect(errors).toEqual([])
  })

  test('keyboard Tab flows from the dialog into the trim handles', async ({ page, baseURL }) => {
    const errors = collectErrors(page)
    await gotoApp(page, baseURL!, '/lab/')
    await waitForUIState(page)
    await installTrimHarness(page)
    await enterTrimMode(page)

    // Focus the Cancel button inside the dialog as a stable anchor.
    // (Cancel is always enabled in trim mode; Publish may be disabled
    // while `shareMeasuring` is true or the selection is over-limit.)
    const cancel = page.locator('.timeline-transfer-dialog__cancel').first()
    await cancel.focus()
    await expect(cancel).toBeFocused()

    // Tab-step until a trim handle gains focus. If the dialog were
    // trapping focus, this loop would cycle back to dialog elements
    // forever.
    let reached = false
    for (let i = 0; i < 40; i++) {
      await page.keyboard.press('Tab')
      const focusedTestId = await page.evaluate(() => {
        const el = document.activeElement as HTMLElement | null
        return el?.getAttribute('data-testid') ?? null
      })
      if (
        focusedTestId === 'timeline-trim-handle-start'
        || focusedTestId === 'timeline-trim-handle-end'
      ) {
        reached = true
        break
      }
    }
    expect(reached, 'Tab must be able to reach the trim handles from the dialog').toBe(true)

    expect(errors).toEqual([])
  })

  test('Dialog glides DOWN into trim dock with a real animation — no sudden jump', async ({ page, baseURL }) => {
    // The center-screen dialog must animate toward the trim dock
    // above the timeline (not teleport). We verify it with a
    // continuous sampling window: from click through settle, the
    // card's center-Y must be observed AT LEAST ONCE at an
    // intermediate value strictly between the start position and
    // the settled trim-dock position. A teleport would skip every
    // intermediate frame; a real transition cannot.
    const errors = collectErrors(page)
    await gotoApp(page, baseURL!, '/lab/')
    await waitForUIState(page)
    await installTrimHarness(page)

    // Force a long transition so the sampling window reliably
    // catches the animation at an intermediate position regardless
    // of test-runner scheduler jitter.
    await page.addStyleTag({
      content: `
        .timeline-modal-card.timeline-transfer-dialog {
          transition-duration: 1200ms !important;
        }
      `,
    })

    await page.locator('.timeline-transfer-trigger').click()
    const shareTab = page.locator('.timeline-transfer-dialog__tab', { hasText: /Share/ })
    if (await shareTab.count()) {
      await shareTab.click().catch(() => {})
    }
    const centerY = async () => page.evaluate(() => {
      const c = document.querySelector('.timeline-transfer-dialog') as HTMLElement | null
      if (!c) return null
      const r = c.getBoundingClientRect()
      return r.top + r.height / 2
    })
    const y0 = await centerY()
    expect(y0, 'dialog must be in the DOM at t0').not.toBeNull()

    // Click Publish and then sample the card's center-Y at ~60 Hz
    // for long enough to cover both the React state-update settle
    // and the full CSS transition.
    const publish = page.locator('.timeline-transfer-dialog__confirm', { hasText: /Publish/ })
    await publish.click()
    const samples: number[] = []
    const start = Date.now()
    while (Date.now() - start < 2500) {
      const y = await centerY()
      if (y !== null) samples.push(y)
      await page.waitForTimeout(20)
    }
    const yTrim = samples[samples.length - 1]
    const ctx = `y0=${y0} yTrim=${yTrim} samples=${samples.length}`
    // The settled trim-dock is BELOW the centered start.
    expect(yTrim, `trim dock not below center — ${ctx}`).toBeGreaterThan(y0! + 2)
    // At least one sample is strictly between y0 and yTrim —
    // proving the card ANIMATED through intermediate positions
    // rather than teleporting to the final state.
    const intermediate = samples.filter(y => y > y0! + 2 && y < yTrim - 2)
    expect(
      intermediate.length,
      `dialog teleported instead of animating — ${ctx} all=${samples.join(',')}`,
    ).toBeGreaterThan(0)

    expect(errors).toEqual([])
  })

  test('Cancel restores live mode before onResumeFromExport (Risk 3 ordering)', async ({ page, baseURL }) => {
    const errors = collectErrors(page)
    await gotoApp(page, baseURL!, '/lab/')
    await waitForUIState(page)
    await installTrimHarness(page)
    await enterTrimMode(page)

    await page.locator('.timeline-transfer-dialog__cancel').click()
    // Dialog closed.
    await expect(page.locator('[data-testid="transfer-share-trim"]')).toHaveCount(0)

    const log = (await page.evaluate(() => (window as any).__trimLog as string[])) ?? []
    const restoreIdx = log.lastIndexOf('return-to-live')
    const resumeIdx = log.lastIndexOf('resume')
    expect(restoreIdx).toBeGreaterThanOrEqual(0)
    expect(resumeIdx).toBeGreaterThanOrEqual(0)
    expect(restoreIdx).toBeLessThan(resumeIdx)

    expect(errors).toEqual([])
  })
})
