import { test, expect } from '@playwright/test'
import { gotoApp } from './helpers'

/**
 * C.2 Integration Test — verifies the live main app runs with worker-driven physics.
 *
 * Uses the _getWorkerDebugState() hook exposed by main.ts to inspect
 * worker integration state directly from the running app.
 *
 * Known flakiness (pre-existing, classified 2026-04-13):
 *   These tests use tight timing windows — the stall-detection test waits
 *   800ms for a 500ms threshold callback. When the browser context is under
 *   cumulative CPU/GC pressure from prior heavy tests (notably smoke.spec's
 *   bench-wasm and the 20+ React UI tests), worker startup and timer
 *   callbacks can drift past these windows, producing intermittent failures
 *   in full-suite runs (~1-2 failures per full run).
 *
 *   Reproduction: `playwright test tests/e2e/smoke.spec.ts tests/e2e/worker-integration.spec.ts`
 *     fails roughly 1 in 3 runs with NO other test files present.
 *   Isolation: `playwright test tests/e2e/worker-integration.spec.ts` passes 5/5.
 *
 *   Not caused by capsule share/publish (Phase 2) changes — bisection on
 *   2026-04-13 confirmed the flake is triggered by smoke.spec's CPU load,
 *   not by any newly added test file. Safe to retry in CI; do not treat as
 *   a regression signal for Phase 2 or later work.
 */

interface WorkerDebugState {
  workerActive: boolean
  workerState: string | null
  workerStalled: boolean
  bridgeOutstandingRequests: number
  physStepMs: number
  totalStepsProfiled: number
  hasSnapshot: boolean
  roundTripMs: number
  snapshotAgeMs: number
  timeSinceProgress: number
}

test.describe('C.2 Integration — Worker-Driven Main App', () => {

  test('worker is active and driving physics in the main app', async ({ page, baseURL }) => {
    const errors: string[] = []
    page.on('pageerror', err => errors.push(err.message))

    await gotoApp(page, baseURL!, '/lab/')

    // Wait for app to fully initialize (React StatusBar renders scene info)
    await expect(page.getByRole('toolbar', { name: 'Simulation controls' })).toBeAttached({ timeout: 15000 })

    // Poll until the worker has produced at least one snapshot,
    // rather than using a fixed timeout. Under CI load (headless
    // Chromium on a constrained runner) 2 seconds is sometimes not
    // enough for the worker to warm up and deliver its first frame,
    // producing an intermittent `hasSnapshot=false` flake. A
    // condition-based wait removes the timing dependency while still
    // preserving the downstream assertions below.
    await expect
      .poll(
        async () => {
          const s = await page.evaluate(() => {
            const fn = (window as Record<string, unknown>)._getWorkerDebugState as (() => WorkerDebugState) | undefined
            return fn ? fn() : null
          }) as WorkerDebugState | null
          return s?.hasSnapshot === true && (s?.totalStepsProfiled ?? 0) > 0
        },
        { timeout: 15000, intervals: [100, 250, 500] },
      )
      .toBe(true)

    // Query worker integration state via debug hook for the detailed
    // assertions below.
    const state = await page.evaluate(() => {
      const fn = (window as Record<string, unknown>)._getWorkerDebugState as (() => WorkerDebugState) | undefined
      return fn ? fn() : null
    }) as WorkerDebugState | null

    // Worker should be active
    expect(state).not.toBeNull()
    if (!state) return // type guard

    expect(state.workerActive).toBe(true)
    expect(state.workerState).toBe('running')

    // At most 1 outstanding request (one-in-flight enforcement)
    expect(state.bridgeOutstandingRequests).toBeLessThanOrEqual(1)

    // Worker has produced at least one snapshot
    expect(state.hasSnapshot).toBe(true)

    // Scheduler has been fed worker timing (totalStepsProfiled > 0)
    expect(state.totalStepsProfiled).toBeGreaterThan(0)

    // physStepMs should be a positive number (worker timing fed into scheduler)
    expect(state.physStepMs).toBeGreaterThan(0)

    // Round-trip latency tracked (should be positive after at least one frame)
    expect(state.roundTripMs).toBeGreaterThan(0)

    // Snapshot age should be reasonable (< 5 seconds since we just queried)
    expect(state.snapshotAgeMs).toBeLessThan(5000)

    // No uncaught errors
    expect(errors.filter(e => !e.includes('WebGL'))).toEqual([])
  })

  test('worker snapshot drives rendering (atoms visible)', async ({ page, baseURL }) => {
    await gotoApp(page, baseURL!, '/lab/')

    // Wait for app to initialize (dock visible = React mounted)
    await expect(page.getByRole('toolbar', { name: 'Simulation controls' })).toBeAttached({ timeout: 15000 })
    await page.waitForTimeout(3000)

    // Worker should have produced snapshots and driven rendering
    const state = await page.evaluate(() => {
      const fn = (window as Record<string, unknown>)._getWorkerDebugState as (() => Record<string, unknown>) | undefined
      return fn ? fn() : null
    })
    expect(state?.workerActive).toBe(true)
    expect(state?.hasSnapshot).toBe(true)
  })

  test('stalled-worker detection: 5s warning triggers workerStalled flag and status text', async ({ page, baseURL }) => {
    await gotoApp(page, baseURL!, '/lab/')

    // Wait for worker to be active
    await expect(page.getByRole('toolbar', { name: 'Simulation controls' })).toBeAttached({ timeout: 15000 })
    await page.waitForTimeout(1000)

    // Pre-condition: worker is active and NOT stalled
    const preState = await page.evaluate(() => {
      const fn = (window as Record<string, unknown>)._getWorkerDebugState as (() => Record<string, unknown>) | undefined
      return fn ? fn() : null
    })
    expect(preState?.workerActive).toBe(true)
    expect(preState?.workerStalled).toBe(false)

    // Set a short stalled threshold for testing (500ms warning, 1500ms fatal)
    const thresholdSet = await page.evaluate(() => {
      const fn = (window as Record<string, unknown>)._setTestStalledThreshold as ((ms: number) => void) | undefined
      if (fn) { fn(500); return true; }
      return false;
    })
    expect(thresholdSet).toBe(true)

    // Freeze worker progress (no more timestamp updates from frames)
    const stallSet = await page.evaluate(() => {
      const fn = (window as Record<string, unknown>)._simulateWorkerStall as (() => void) | undefined
      if (fn) { fn(); return true; }
      return false;
    })
    expect(stallSet).toBe(true)

    // Wait long enough for warning (500ms) but NOT fatal (1500ms)
    await page.waitForTimeout(800)

    // Post-condition: workerStalled flag should be true
    const postState = await page.evaluate(() => {
      const fn = (window as Record<string, unknown>)._getWorkerDebugState as (() => Record<string, unknown>) | undefined
      return fn ? fn() : null
    })
    // workerStalled flag should be true (warning threshold crossed)
    // OR worker should have been torn down by fatal threshold — either proves detection works
    const stalledOrTornDown = postState?.workerStalled === true || postState?.workerActive === false
    expect(stalledOrTornDown).toBe(true)

    // Wait for status renderer to pick up the stalled state (runs at 5Hz = 200ms)
    await page.waitForTimeout(300)

    // User-visible assertion: React FPS display should reflect the stalled/fallback state
    const fpsText = await page.locator('.react-fps').textContent() || ''
    if (postState?.workerStalled === true) {
      expect(fpsText).toContain('Simulation stalled')
    } else {
      // Fatal state: worker torn down, sync physics resumed — FPS shows normal info
      expect(fpsText).not.toContain('Simulation stalled')
    }
  })
})
