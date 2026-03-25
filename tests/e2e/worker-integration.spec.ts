import { test, expect } from '@playwright/test'

/**
 * C.2 Integration Test — verifies the live main app runs with worker-driven physics.
 *
 * Uses the _getWorkerDebugState() hook exposed by main.ts to inspect
 * worker integration state directly from the running app.
 */

interface WorkerDebugState {
  workerActive: boolean
  workerState: string | null
  workerStalled: boolean
  outstandingRequests: number
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

    await page.goto(`${baseURL}/page/`)

    // Wait for app to fully initialize (React StatusBar renders scene info)
    await expect(page.locator('.react-info .status-text')).toContainText(/(atoms|Empty playground)/, { timeout: 15000 })

    // Give the worker time to initialize and process at least one frame
    await page.waitForTimeout(2000)

    // Query worker integration state via debug hook
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
    expect(state.outstandingRequests).toBeLessThanOrEqual(1)

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
    await page.goto(`${baseURL}/page/`)

    // Wait for React StatusBar to show atoms (structure loaded and rendering)
    await expect(page.locator('.react-info .status-text')).toContainText('atoms', { timeout: 15000 })

    // The status should show a non-zero speed or "Estimating" (worker is stepping)
    await page.waitForTimeout(3000)
    const statusText = await page.locator('.react-info .status-text').textContent()
    // Should show simulation info, not "Empty playground"
    expect(statusText).not.toContain('Empty playground')
  })

  test('stalled-worker detection: 5s warning triggers workerStalled flag and status text', async ({ page, baseURL }) => {
    await page.goto(`${baseURL}/page/`)

    // Wait for worker to be active (React StatusBar shows scene info)
    await expect(page.locator('.react-info .status-text')).toContainText(/(atoms|Estimating|Sim)/, { timeout: 15000 })
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
