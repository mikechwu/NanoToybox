import { test, expect } from '@playwright/test'

test.describe('Milestone C.1 — Worker Integration', () => {

  test('worker test page passes all assertions', async ({ page, baseURL }) => {
    const errors: string[] = []
    page.on('pageerror', err => errors.push(err.message))

    await page.goto(`${baseURL}/lab/test-worker.html`)

    const summaryLocator = page.locator('#results pre', { hasText: 'Results:' })
    await expect(summaryLocator).toBeAttached({ timeout: 30000 })
    await expect(summaryLocator).toContainText('0 failed')

    const passCount = await page.locator('#results pre.pass').count()
    expect(passCount).toBeGreaterThan(10)

    expect(errors).toEqual([])
  })

  test('verifies kernel=wasm and key protocol fields in test page output', async ({ page, baseURL }) => {
    await page.goto(`${baseURL}/lab/test-worker.html`)

    const summaryLocator = page.locator('#results pre', { hasText: 'Results:' })
    await expect(summaryLocator).toBeAttached({ timeout: 30000 })

    // Check specific PASS lines that prove protocol correctness
    const allText = await page.locator('#results').textContent()

    // Failure paths: commands before init
    expect(allText).toContain('Pre-init requestFrame returns frameSkipped')
    expect(allText).toContain('reason = not_initialized')
    expect(allText).toContain('Pre-init append fails')
    expect(allText).toContain('Pre-init clear fails')
    // Wasm kernel actually used
    expect(allText).toContain('kernel = wasm')
    // wasmReady reported true
    expect(allText).toContain('wasmReady = true')
    // Atoms moved during simulation (not just static)
    expect(allText).toContain('Atoms moved during simulation')
    // Append semantics: atomsAppended vs totalAtomCount
    expect(allText).toContain('atomsAppended = 2')
    expect(allText).toContain('totalAtomCount = 4')
    // Post-append state correct
    expect(allText).toContain('Post-append frame has n=4')
    // Post-clear state correct
    expect(allText).toContain('Post-clear frame has n=0')
    // Negative path: useWasm: false stays on JS
    expect(allText).toContain('kernel = js when useWasm: false')
    expect(allText).toContain('wasmReady = false when useWasm: false')
    // Init serialization
    expect(allText).toContain('Queued requestFrame ran after init')
  })
})
