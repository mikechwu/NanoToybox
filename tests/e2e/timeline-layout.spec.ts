/**
 * Timeline layout E2E — bounding-box regression tests for the action zone
 * and restart anchor.
 *
 * These guard the specific geometry failures we hit during Phase 2:
 *   - stacked publish/export slot overflowing the shell height
 *   - restart anchor overlapping the action zone at the track's right edge
 *
 * We drive the UI into a realistic state by programmatically updating the
 * app store via the timeline state API, since getting a real recording
 * in a headless browser is expensive.
 */

import { test, expect } from '@playwright/test'
import { gotoApp } from './helpers'

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

async function waitForUIState(page: import('@playwright/test').Page) {
  await expect(async () => {
    const state = await page.evaluate(() => (window as any)._getUIState?.())
    expect(state).toBeDefined()
  }).toPass({ timeout: 5000 })
}

/**
 * Force the Lab into a review-mode state with a simulated restart target
 * near the right edge. Uses the useAppStore test surface that the existing
 * timeline-bar-lifecycle tests rely on for the timeline state update API.
 *
 * Also installs a minimal onPublishCapsule callback so the stacked share
 * slot renders (which is the collision regression we are guarding).
 */
async function driveToReviewWithRestartNearEdge(page: import('@playwright/test').Page) {
  await page.evaluate(() => {
    const store = (window as any).__useAppStore ?? null;
    // The main.ts script attaches useAppStore to the window via _getUIState.
    // We use the store hook re-exported on window for E2E only — if it's
    // not yet wired, the test should fail loudly rather than time out.
    if (!store) {
      throw new Error('useAppStore not exposed to window. Add `_useAppStore = useAppStore` in main.ts under ?e2e=1.')
    }
    const state = store.getState();
    state.installTimelineUI(
      {
        onScrub: () => {},
        onReturnToLive: () => {},
        onEnterReview: () => {},
        onRestartFromHere: () => {},
        onStartRecordingNow: () => {},
        onTurnRecordingOff: () => {},
        onPublishCapsule: async () => ({ shareCode: 'TEST12345678', shareUrl: 'https://atomdojo.pages.dev/c/TEST12345678' }),
        onExportHistory: async () => 'saved' as const,
        onPauseForExport: () => true,
        onResumeFromExport: () => {},
      },
      'active',
      { full: true, capsule: true },
    );
    state.updateTimelineState({
      mode: 'review',
      currentTimePs: 950,
      reviewTimePs: 950,
      rangePs: { start: 0, end: 1000 },
      canReturnToLive: true,
      canRestart: true,
      restartTargetPs: 950,
    });
  });
}

test.describe('Timeline layout — action zone fit', () => {
  test('action zone (clear + unified transfer) fits within the shell height', async ({ page, baseURL }) => {
    const errors = collectErrors(page)
    await gotoApp(page, baseURL!, '/lab/')
    await waitForUIState(page)

    // Without a recording range, the action zone only shows clear.
    // We need the full action zone (clear + transfer) — drive into review mode.
    await driveToReviewWithRestartNearEdge(page)

    // Verify the action zone and shell geometry
    const geometry = await page.evaluate(() => {
      const shell = document.querySelector('.timeline-shell') as HTMLElement | null;
      const actionZone = document.querySelector('.timeline-action-zone') as HTMLElement | null;
      const transfer = document.querySelector('.timeline-transfer-trigger') as HTMLElement | null;
      if (!shell || !actionZone) return null;
      return {
        shellHeight: shell.getBoundingClientRect().height,
        actionZoneHeight: actionZone.getBoundingClientRect().height,
        transferHeight: transfer?.getBoundingClientRect().height ?? null,
        transferExists: transfer !== null,
      };
    });

    expect(geometry).not.toBeNull()
    // Desktop shell is 44px. The 28px clear + 28px transfer buttons must fit.
    expect(geometry!.actionZoneHeight).toBeLessThanOrEqual(geometry!.shellHeight)
    // The transfer trigger must be present when download or share is available.
    expect(geometry!.transferExists).toBe(true)
    if (geometry!.transferHeight !== null) {
      expect(geometry!.transferHeight).toBeLessThanOrEqual(geometry!.shellHeight)
    }

    expect(errors).toEqual([])
  })

  test('restart anchor does not overlap action zone at the right edge', async ({ page, baseURL }) => {
    const errors = collectErrors(page)
    await gotoApp(page, baseURL!, '/lab/')
    await waitForUIState(page)
    await driveToReviewWithRestartNearEdge(page)

    const rects = await page.evaluate(() => {
      const anchor = document.querySelector('.timeline-restart-anchor') as HTMLElement | null;
      const actionZone = document.querySelector('.timeline-action-zone') as HTMLElement | null;
      const trackZone = document.querySelector('.timeline-track-zone') as HTMLElement | null;
      if (!anchor || !actionZone || !trackZone) return null;
      return {
        anchor: anchor.getBoundingClientRect(),
        actionZone: actionZone.getBoundingClientRect(),
        trackZone: trackZone.getBoundingClientRect(),
      };
    });

    expect(rects).not.toBeNull()
    const { anchor, actionZone, trackZone } = rects!;

    // The restart anchor's right edge must not cross into the action zone.
    expect(anchor.right).toBeLessThanOrEqual(actionZone.left + 1) // +1 for sub-pixel tolerance

    // And it should stay inside the track zone.
    expect(anchor.right).toBeLessThanOrEqual(trackZone.right + 1)
    expect(anchor.left).toBeGreaterThanOrEqual(trackZone.left - 1)

    expect(errors).toEqual([])
  })

  test('restart anchor does not overlap action zone on phone viewport', async ({ browser, baseURL }) => {
    // Mobile shell is 38px — tightest fit. Verify unified transfer still fits
    // and restart doesn't overlap.
    const context = await browser.newContext({
      hasTouch: true, isMobile: true,
      viewport: { width: 375, height: 812 },
    });
    const page = await context.newPage();
    try {
      const errors = collectErrors(page)
      await gotoApp(page, baseURL!, '/lab/')
      await waitForUIState(page)
      await driveToReviewWithRestartNearEdge(page)

      const rects = await page.evaluate(() => {
        const anchor = document.querySelector('.timeline-restart-anchor') as HTMLElement | null;
        const actionZone = document.querySelector('.timeline-action-zone') as HTMLElement | null;
        const shell = document.querySelector('.timeline-shell') as HTMLElement | null;
        const transfer = document.querySelector('.timeline-transfer-trigger') as HTMLElement | null;
        if (!anchor || !actionZone || !shell) return null;
        return {
          anchor: anchor.getBoundingClientRect(),
          actionZone: actionZone.getBoundingClientRect(),
          shellHeight: shell.getBoundingClientRect().height,
          transferHeight: transfer?.getBoundingClientRect().height ?? null,
        };
      });

      expect(rects).not.toBeNull()
      // Action zone content fits inside shell
      expect(rects!.actionZone.height).toBeLessThanOrEqual(rects!.shellHeight)
      if (rects!.transferHeight !== null) {
        expect(rects!.transferHeight).toBeLessThanOrEqual(rects!.shellHeight)
      }
      // No overlap
      expect(rects!.anchor.right).toBeLessThanOrEqual(rects!.actionZone.left + 1)

      expect(errors).toEqual([])
    } finally {
      await context.close()
    }
  })
})
