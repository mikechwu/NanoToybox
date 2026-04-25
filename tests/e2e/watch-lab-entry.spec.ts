/**
 * Watch → Lab handoff end-to-end.
 *
 * These tests drive the production code path via the `?e2e=1` hooks
 * (`_watchOpenFile`, `_getWatchState`).
 *
 * Assertions match each test's title. The surfacing policy is: only
 * `stale` + `missing-entry` handoffs surface a user-visible toast in
 * the Lab status live region (the user attempted a Continue that
 * arrived too late; they deserve to know). All other rejection
 * reasons (malformed, missing-token, tampering, schema drift) stay
 * silent — a console.warn is the only diagnostic, because a scary
 * toast on a coincidental backend deploy would be worse than a quiet
 * fallback.
 */
import { test, expect, type Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

const FIXTURE_PATH = path.resolve(__dirname, 'fixtures/watch-two-atom.json');
const FIXTURE_CONTENT = fs.readFileSync(FIXTURE_PATH, 'utf-8');

async function clearHandoffStorage(page: Page): Promise<void> {
  await page.evaluate(() => {
    try {
      for (let i = localStorage.length - 1; i >= 0; i--) {
        const k = localStorage.key(i);
        if (k && k.startsWith('atomdojo.watchLabHandoff:')) localStorage.removeItem(k);
      }
    } catch { /* ignore */ }
  });
}

async function loadWatchFixture(page: Page, content = FIXTURE_CONTENT): Promise<void> {
  // _watchOpenFile is the Watch-side e2e hook that drives
  // controller.openFile(...) with the fixture text.
  await page.evaluate(async (text) => {
    const hook = (window as unknown as { _watchOpenFile?: (text: string, name: string) => Promise<void> })._watchOpenFile;
    if (!hook) throw new Error('_watchOpenFile test hook not installed');
    await hook(text, 'watch-two-atom.json');
  }, content);
  // Wait for the toolbar to mount (indicates file load succeeded).
  await page.waitForSelector('.watch-toolbar', { timeout: 8000 });
}

test.describe('Watch → Lab hydrate path (integration seam)', () => {
  test.beforeEach(async ({ page }) => {
    // Prime localStorage clean on the origin.
    await page.goto('/lab/');
    await clearHandoffStorage(page);
  });

  test('"New Empty Lab" menu anchor targets /lab/ and the URL resolves to Lab', async ({ page }) => {
    await page.goto('/watch/?e2e=1');
    await page.waitForSelector('.watch-workspace', { timeout: 8000 });
    await loadWatchFixture(page);

    // Secondary lives inside the caret-toggled menu now (redesign:
    // primary-only capsule + caret popover). Click the caret to reveal
    // the "New Empty Lab" menu item before querying its href.
    // `.watch-lab-entry__caret` is the caret toggle;
    // `.watch-lab-entry__secondary` is still the anchor class inside
    // the menu item so this selector keeps working.
    await page.locator('.watch-lab-entry__caret').click();
    const anchor = page.locator('.watch-lab-entry__secondary').first();
    await expect(anchor).toBeVisible();
    const href = await anchor.getAttribute('href');
    expect(href).toBeTruthy();
    expect(href).toMatch(/\/lab\/$/);
    expect(await anchor.getAttribute('target')).toBe('_blank');
    // Navigate the current tab to the href (same URL production would
    // open in a new tab) and confirm Lab actually renders.
    await page.goto(href!);
    await page.waitForSelector('canvas', { timeout: 8000 });
    const state = await page.evaluate(() => {
      const w = window as unknown as { _getUIState?: () => { atomCount: number } };
      return w._getUIState?.();
    });
    expect(state?.atomCount).toBeGreaterThan(0);
  });

  test('stale handoff token surfaces the expired-link error copy in the Lab status live region', async ({ page }) => {
    // Navigate first so localStorage is on the right origin.
    await page.goto('/lab/');
    await page.evaluate(() => {
      const token = 'stale-test-token';
      const bytes = new Float64Array([0, 0, 0]);
      const b64 = btoa(String.fromCharCode.apply(null, Array.from(new Uint8Array(bytes.buffer))));
      const stale = {
        version: 1, source: 'watch', mode: 'current-frame',
        // 1 hour ago — well past the 10-minute TTL.
        createdAt: Date.now() - 60 * 60 * 1000,
        sourceMeta: { fileName: null, fileKind: null, shareCode: null, timePs: 0 },
        seed: {
          atoms: [{ id: 0, element: 'C' }],
          positions: b64, velocities: null, bonds: [],
          boundary: { mode: 'contain', wallRadius: 50, wallCenter: [0, 0, 0], wallCenterSet: true, removedCount: 0, damping: 0.1 },
          config: { damping: 0.1, kDrag: 1, kRotate: 1, dtFs: 0.5, dampingRefDurationFs: 100 },
          provenance: { historyKind: 'capsule', velocitiesAreApproximated: true },
        },
      };
      localStorage.setItem(`atomdojo.watchLabHandoff:${token}`, JSON.stringify(stale));
    });
    // Navigate to Lab with the stale handoff. Per plan §10, this is
    // the ONE rejection reason that surfaces a user-visible toast
    // (others stay silent as tampering / schema-drift signals).
    await page.goto('/lab/?from=watch&handoff=stale-test-token');
    await page.waitForFunction(
      () => !new URL(location.href).searchParams.get('handoff'),
      { timeout: 8000 },
    );
    // URL scrubbed.
    const url = new URL(page.url());
    expect(url.searchParams.get('from')).toBeNull();
    expect(url.searchParams.get('handoff')).toBeNull();
    // localStorage entry consumed.
    const entry = await page.evaluate(() => localStorage.getItem('atomdojo.watchLabHandoff:stale-test-token'));
    expect(entry).toBeNull();
    // Lab booted the default scene AND the status live region shows
    // the stale-handoff copy so the user knows their attempt timed out.
    await page.waitForSelector('canvas', { timeout: 8000 });
    const statusRoot = page.locator('[data-status-root]');
    await expect(statusRoot).toBeVisible({ timeout: 3000 });
    await expect(statusRoot).toContainText(/link has expired/i);
    // The live region is correctly wired for screen readers.
    await expect(statusRoot).toHaveAttribute('role', 'status');
    await expect(statusRoot).toHaveAttribute('aria-live', 'polite');
  });

  test('missing-entry surfaces "no longer available" copy — consumed / cleared storage is a user-plausible failure', async ({ page }) => {
    // `?from=watch&handoff=<token>` but no localStorage entry. This is
    // the "I clicked Continue on a tab I already opened" / "storage
    // cleared" / "private-mode dropped it" flow — per plan §10, these
    // are user-plausible failures and must surface distinct copy (not
    // the "expired" copy, since TTL isn't what went wrong).
    await page.goto('/lab/');
    await clearHandoffStorage(page);
    await page.goto('/lab/?from=watch&handoff=never-existed-token');
    await page.waitForFunction(
      () => !new URL(location.href).searchParams.get('handoff'),
      { timeout: 8000 },
    );
    // URL scrubbed.
    const url = new URL(page.url());
    expect(url.searchParams.get('from')).toBeNull();
    expect(url.searchParams.get('handoff')).toBeNull();
    // Lab boots normally + the status live region explains why the
    // scene isn't what the user expected.
    await page.waitForSelector('canvas', { timeout: 8000 });
    const statusRoot = page.locator('[data-status-root]');
    await expect(statusRoot).toBeVisible({ timeout: 3000 });
    await expect(statusRoot).toContainText(/no longer available/i);
    // Must NOT say "expired" — TTL wasn't the cause.
    await expect(statusRoot).not.toContainText(/expired/i);
    // Live-region wiring.
    await expect(statusRoot).toHaveAttribute('role', 'status');
    await expect(statusRoot).toHaveAttribute('aria-live', 'polite');
  });

  test('malformed handoff is silent (no visible toast — tampering / schema drift only warrants a console.warn)', async ({ page }) => {
    await page.goto('/lab/');
    await page.evaluate(() => {
      // A handoff that fails shape validation (atoms is empty, fails
      // isValidSeed). Per plan §10 this is "tampering/schema drift"
      // territory and must NOT produce a user-visible toast.
      const token = 'malformed-token';
      const malformed = {
        version: 1, source: 'watch', mode: 'current-frame',
        createdAt: Date.now(),
        sourceMeta: { fileName: null, fileKind: null, shareCode: null, timePs: 0 },
        seed: {
          atoms: [], positions: '', velocities: null, bonds: [],
          boundary: { mode: 'contain', wallRadius: 50, wallCenter: [0, 0, 0], wallCenterSet: true, removedCount: 0, damping: 0.1 },
          config: { damping: 0.1, kDrag: 1, kRotate: 1, dtFs: 0.5, dampingRefDurationFs: 100 },
          provenance: { historyKind: 'capsule', velocitiesAreApproximated: true },
        },
      };
      localStorage.setItem(`atomdojo.watchLabHandoff:${token}`, JSON.stringify(malformed));
    });
    await page.goto('/lab/?from=watch&handoff=malformed-token');
    await page.waitForSelector('canvas', { timeout: 8000 });
    // URL scrubbed + storage consumed (same as stale).
    expect(new URL(page.url()).searchParams.get('handoff')).toBeNull();
    expect(await page.evaluate(() => localStorage.getItem('atomdojo.watchLabHandoff:malformed-token'))).toBeNull();
    // No user-visible toast — check the status root either absent or
    // without the error copy.
    const statusText = await page.evaluate(
      () => document.querySelector('[data-status-root]')?.textContent ?? '',
    );
    expect(statusText).not.toMatch(/link has expired/i);
    expect(statusText).not.toMatch(/Couldn\u2019t/i);
  });

  test('"Continue this frame in Lab" primary renders as an enabled anchor with a Lab-targeted href when a multi-frame file is loaded', async ({ page }) => {
    await page.goto('/watch/?e2e=1');
    await page.waitForSelector('.watch-workspace', { timeout: 8000 });
    await loadWatchFixture(page);

    // Scrub into the middle of the fixture so the current time sits
    // inside a dense frame. `canBuildWatchLabSceneSeed` returns false
    // for times outside any frame (the initial `getCurrentTimePs()`
    // can land there depending on fixture timing), which would render
    // the primary as a disabled `<button>` and short-circuit this
    // test even though the real user flow works.
    await page.evaluate(() => {
      const hook = (window as unknown as { _watchScrub?: (ps: number) => void })._watchScrub;
      if (!hook) throw new Error('_watchScrub test hook not installed');
      hook(25);
    });

    // Hover the primary first to trigger `onContinueIntent` → controller
    // mints the token. Without the hover the anchor's href is null
    // (lazy mint on intent). Select via class because the enclosing
    // element is the `<a>`; `getByText` would land on the inner label
    // `<span>`.
    const primary = page.locator('.watch-lab-entry__primary').first();
    await expect(primary).toBeVisible();
    await primary.hover();
    const tag = await primary.evaluate((el) => el.tagName);
    expect(tag).toBe('A');
    const href = await primary.getAttribute('href');
    expect(href).toBeTruthy();
    expect(href).toMatch(/\/lab\/\?.*from=watch/);
    expect(href).toMatch(/handoff=/);
  });

  test('happy path: load fixture → scrub to frame → click "Continue this frame in Lab" → Lab tab hydrates the seeded scene', async ({ page, context }) => {
    // This exercises the whole user-facing chain: Watch fixture →
    // hover + click the Continue primary → new-tab navigation → Lab
    // hydrate → scene committed. The rejection-seam tests above cover
    // every failure path; this one asserts the real interaction
    // actually works end-to-end.
    await page.goto('/watch/?e2e=1');
    await page.waitForSelector('.watch-workspace', { timeout: 8000 });
    await loadWatchFixture(page);

    // Scrub to the fixture's second dense frame (timePs: 25, frameId: 1)
    // to pin the source time deterministically. Without the scrub the
    // handoff's source metadata depends on whatever `getCurrentTimePs()`
    // defaults to after `openFile`, which would make the test brittle
    // against unrelated playback changes.
    await page.evaluate(() => {
      const hook = (window as unknown as { _watchScrub?: (ps: number) => void })._watchScrub;
      if (!hook) throw new Error('_watchScrub test hook not installed');
      hook(25);
    });

    // Hover the Continue primary to mint the current-frame token (the
    // mint-on-intent path), then sanity-check the enabled anchor.
    // Select the enclosing primary element (the `<a>` or `<button>`),
    // not the inner label `<span>`. Class selector picks the button
    // root directly, independent of current enabled/disabled state.
    const primary = page.locator('.watch-lab-entry__primary').first();
    await expect(primary).toBeVisible();
    await primary.hover();
    expect(await primary.evaluate((el) => el.tagName)).toBe('A');

    // Click — controller's `openLabFromCurrentFrame` invokes
    // `window.open(href, '_blank', 'noopener,noreferrer')`, which
    // Playwright surfaces as a new Page on the BrowserContext.
    const labTabPromise = context.waitForEvent('page');
    await primary.click();
    const labTab = await labTabPromise;

    // Wait for Lab to finish its consume step (the boot strips
    // `?handoff` from the URL inside `consumeWatchToLabHandoffFromLocation`).
    await labTab.waitForLoadState('domcontentloaded');
    await labTab.waitForSelector('canvas', { timeout: 8000 });
    await labTab.waitForFunction(
      () => !new URL(location.href).searchParams.get('handoff'),
      { timeout: 8000 },
    );
    // URL scrubbed to bare `/lab/` — no `from=watch` / `handoff=` residue.
    const labUrl = new URL(labTab.url());
    expect(labUrl.pathname).toBe('/lab/');
    expect(labUrl.searchParams.get('from')).toBeNull();
    expect(labUrl.searchParams.get('handoff')).toBeNull();

    // Verify the hydrated scene — the fixture has 2 atoms, so after
    // the transactional clear+append the Lab UI reflects 2 atoms (NOT
    // the default auto-loaded C60 → 60 atoms). Use a polling wait so
    // the assertion is not racy against the async hydrate promise.
    await labTab.waitForFunction(
      () => {
        const w = window as unknown as { _getUIState?: () => { atomCount: number } };
        return w._getUIState?.()?.atomCount === 2;
      },
      { timeout: 8000 },
    );

    // Hydrate success signal: the handoff token was consumed (URL
    // scrubbed above) AND the seed's atom count is on-screen. The
    // provenance pill that used to carry this acknowledgement was
    // removed — it was visual noise without actionable information.
    // We now assert the committed state directly.
    const atomCount = await labTab.evaluate(() => {
      const w = window as unknown as { _getUIState?: () => { atomCount: number } };
      return w._getUIState?.()?.atomCount ?? -1;
    });
    // Full-history fixture's frame-at-timePs-25 has a specific atom
    // count; the seed extractor preserves it verbatim. Anything other
    // than the seed's count means the hydrate didn't commit.
    expect(atomCount).toBeGreaterThan(0);
    // Belt-and-suspenders: explicitly guard against the default-C60
    // scene leaking in. `waitForFunction` above enforces `=== 2`, but
    // if a future fixture edit changes the seed atom count, the
    // `> 0` check would still accept 60 (the default). This extra
    // assertion preserves the "not default" discrimination that the
    // removed pill-copy assertion used to carry.
    expect(atomCount).not.toBe(60);
  });

  test('pending-handoff boot with stale token: fallback-loads the default scene (empty canvas + error toast is not acceptable UX)', async ({ page }) => {
    // Companion to the "no C60 flash" test above. When the URL has
    // `?from=watch` and the token is invalid (stale / missing /
    // malformed), the hydrate does NOT populate the scene. The boot's
    // fallback MUST load the default so the user sees something
    // familiar alongside the error message — stranding them on an
    // empty canvas would be a worse UX than the flash we were trying
    // to avoid.
    await page.goto('/lab/');
    await page.evaluate(() => {
      const token = 'fallback-stale-token';
      const bytes = new Float64Array([0, 0, 0]);
      const b64 = btoa(String.fromCharCode.apply(null, Array.from(new Uint8Array(bytes.buffer))));
      const stale = {
        version: 1, source: 'watch', mode: 'current-frame',
        createdAt: Date.now() - 60 * 60 * 1000,
        sourceMeta: { fileName: null, fileKind: null, shareCode: null, timePs: 0, frameId: 0 },
        seed: {
          atoms: [{ id: 0, element: 'C' }],
          positions: b64, velocities: null, bonds: [],
          boundary: { mode: 'contain', wallRadius: 50, wallCenter: [0, 0, 0], wallCenterSet: true, removedCount: 0, damping: 0.1 },
          config: { damping: 0.1, kDrag: 1, kRotate: 1, dtFs: 0.5, dampingRefDurationFs: 100 },
          provenance: { historyKind: 'capsule', velocitiesAreApproximated: true },
        },
      };
      localStorage.setItem(`atomdojo.watchLabHandoff:${token}`, JSON.stringify(stale));
    });
    await page.goto('/lab/?from=watch&handoff=fallback-stale-token');
    await page.waitForFunction(
      () => !new URL(location.href).searchParams.get('handoff'),
      { timeout: 8000 },
    );
    // Error toast surfaces the stale reason (stable invariant — see
    // the dedicated stale-handoff test earlier in this file).
    const statusRoot = page.locator('[data-status-root]');
    await expect(statusRoot).toBeVisible({ timeout: 3000 });
    await expect(statusRoot).toContainText(/link has expired/i);
    // Critical: default scene loaded as fallback → atomCount > 0 (C60
    // has 60 atoms; any default structure is non-empty). Without the
    // fallback the scene would be empty forever.
    await page.waitForFunction(
      () => {
        const w = window as unknown as { _getUIState?: () => { atomCount: number } };
        return (w._getUIState?.()?.atomCount ?? 0) > 0;
      },
      { timeout: 8000 },
    );
  });

  test('pending-handoff boot: default C60 is NEVER rendered (no flash-then-seed)', async ({ page, context }) => {
    // The 2026-04-16 UX bug: even after the race fixes, the Lab tab
    // flashed the default C60 for ~500 ms before the hydrate replaced
    // it with the Watch seed. The refactor: when the URL carries
    // `?from=watch&handoff=<token>`, the boot DEFERS the default
    // scene load entirely. The hydrate runs against an empty scene
    // and populates it atomically via `clearScene + appendMolecule`.
    //
    // This test polls `atomCount` every 50 ms during boot and
    // asserts it NEVER equals 60 (the C60 atom count). It may be 0
    // before hydrate completes OR equal the seed count after; any
    // sample at 60 means the default-scene load leaked through and
    // the user would see a visible C60 flash.
    const capsuleFixturePath = path.resolve(__dirname, 'fixtures/watch-capsule-bug-repro.json');
    const capsuleFixtureContent = fs.readFileSync(capsuleFixturePath, 'utf-8');
    await page.goto('/watch/?e2e=1');
    await page.waitForSelector('.watch-workspace', { timeout: 8000 });
    await loadWatchFixture(page, capsuleFixtureContent);
    await page.evaluate(() => {
      const hook = (window as unknown as { _watchScrub?: (ps: number) => void })._watchScrub;
      if (!hook) throw new Error('_watchScrub test hook not installed');
      hook(0.5);
    });
    // Select the enclosing primary element (the `<a>` or `<button>`),
    // not the inner label `<span>`. Class selector picks the button
    // root directly, independent of current enabled/disabled state.
    const primary = page.locator('.watch-lab-entry__primary').first();
    await expect(primary).toBeVisible();
    await primary.hover();
    const labTabPromise = context.waitForEvent('page');
    await primary.click();
    const labTab = await labTabPromise;

    // Start polling atomCount as soon as the Lab tab has a script
    // context — no waitForLoadState first, so we catch the earliest
    // possible moment the default-scene load could publish a value.
    const samples: number[] = [];
    const pollDeadline = Date.now() + 2500;
    while (Date.now() < pollDeadline) {
      const n = await labTab.evaluate(() => {
        const w = window as unknown as { _getUIState?: () => { atomCount: number } };
        try { return w._getUIState?.()?.atomCount ?? null; } catch { return null; }
      }).catch(() => null);
      if (typeof n === 'number') samples.push(n);
      if (samples.length > 0 && samples[samples.length - 1] === 2) break;
      await labTab.waitForTimeout(50);
    }
    // CRITICAL invariant: no sample equals 60 (C60). Trace included in
    // the error message for post-mortem timing analysis.
    const hasC60Flash = samples.some((n) => n === 60);
    expect(
      hasC60Flash,
      `atomCount briefly became 60 (C60) during pending-handoff boot — the default scene leaked through. Samples: ${JSON.stringify(samples)}`,
    ).toBe(false);
    // And the seed did ultimately land (so the test is observing the
    // correct path, not a permanently-empty scene).
    expect(samples).toContain(2);
  });

  test('worker init race: seed scene is NOT reverted by delayed worker frameResult (must commit to worker, not skip it)', async ({ page, context }) => {
    // The 2026-04-16 production bug: the Lab tab's `_workerRuntime.init(C60)`
    // is fire-and-forget. If the hydrate's `worker.isActive()` check
    // runs before that init acks, the OLD code silently skipped the
    // worker commit. Once init acked, the worker emitted C60
    // frameResults that the reconciler applied to main-thread
    // physics, reverting the scene to default C60 AFTER the hydrate
    // had already declared success. The previous E2E didn't catch
    // this because vite-preview + fast hardware finished init before
    // the click happened.
    //
    // To reproduce reliably, we check the scene state over a full
    // 2-second window after the hydrate commit — long enough for
    // even a slow worker init ack to arrive. The atom count must NEVER
    // revert to 60 (C60). Previously this test would pass at the
    // initial assertion, then the worker init ack + C60 frameResult
    // would flip atomCount to 60 before the 2-second poll finished.
    const capsuleFixturePath = path.resolve(__dirname, 'fixtures/watch-capsule-bug-repro.json');
    const capsuleFixtureContent = fs.readFileSync(capsuleFixturePath, 'utf-8');
    await page.goto('/watch/?e2e=1');
    await page.waitForSelector('.watch-workspace', { timeout: 8000 });
    await loadWatchFixture(page, capsuleFixtureContent);
    await page.evaluate(() => {
      const hook = (window as unknown as { _watchScrub?: (ps: number) => void })._watchScrub;
      if (!hook) throw new Error('_watchScrub test hook not installed');
      hook(0.5);
    });

    // Select the enclosing primary element (the `<a>` or `<button>`),
    // not the inner label `<span>`. Class selector picks the button
    // root directly, independent of current enabled/disabled state.
    const primary = page.locator('.watch-lab-entry__primary').first();
    await expect(primary).toBeVisible();
    await primary.hover();
    const labTabPromise = context.waitForEvent('page');
    await primary.click();
    const labTab = await labTabPromise;
    await labTab.waitForLoadState('domcontentloaded');
    await labTab.waitForSelector('canvas', { timeout: 8000 });
    await labTab.waitForFunction(
      () => !new URL(location.href).searchParams.get('handoff'),
      { timeout: 8000 },
    );

    // CRITICAL regression lock: poll atomCount every 100 ms for 2
    // seconds. It must stay at 2 (seed) the entire time. Any revert
    // to 60 (C60) means the worker race is back.
    const samples: number[] = [];
    for (let i = 0; i < 20; i++) {
      const n = await labTab.evaluate(() => {
        const w = window as unknown as { _getUIState?: () => { atomCount: number } };
        return w._getUIState?.()?.atomCount;
      });
      samples.push(n ?? -1);
      await labTab.waitForTimeout(100);
    }
    // Every sample must be 2. If ANY sample is 60, the hydrate's
    // main-thread commit was silently overwritten — the very bug
    // this test locks against. Include the full sample trace in the
    // error message so a future regression reports the timing.
    const everyIsSeed = samples.every((n) => n === 2);
    expect(
      everyIsSeed,
      `atomCount reverted during the poll window (should stay 2): ${JSON.stringify(samples)}`,
    ).toBe(true);
  });

  test('happy path (capsule / approximated velocities): Lab renders the handed-off atoms, not the default C60', async ({ page, context }) => {
    // Reproduction of the 2026-04-16 user-reported bug: the hydrate
    // reported success but the Lab tab rendered the default C60 instead
    // of the handed-off scene. The full-history fixture happy path
    // above did not catch it; capsule histories follow a different
    // seed-building branch (velocities approximated from finite
    // differences rather than carried verbatim).
    const capsuleFixturePath = path.resolve(__dirname, 'fixtures/watch-capsule-bug-repro.json');
    const capsuleFixtureContent = fs.readFileSync(capsuleFixturePath, 'utf-8');
    await page.goto('/watch/?e2e=1');
    await page.waitForSelector('.watch-workspace', { timeout: 8000 });
    await loadWatchFixture(page, capsuleFixtureContent);
    await page.evaluate(() => {
      const hook = (window as unknown as { _watchScrub?: (ps: number) => void })._watchScrub;
      if (!hook) throw new Error('_watchScrub test hook not installed');
      hook(0.5);
    });

    // Select the enclosing primary element (the `<a>` or `<button>`),
    // not the inner label `<span>`. Class selector picks the button
    // root directly, independent of current enabled/disabled state.
    const primary = page.locator('.watch-lab-entry__primary').first();
    await expect(primary).toBeVisible();
    await primary.hover();
    const labTabPromise = context.waitForEvent('page');
    await primary.click();
    const labTab = await labTabPromise;

    await labTab.waitForLoadState('domcontentloaded');
    await labTab.waitForSelector('canvas', { timeout: 8000 });
    await labTab.waitForFunction(
      () => !new URL(location.href).searchParams.get('handoff'),
      { timeout: 8000 },
    );

    // Bug shape: hydrate reports success (URL handoff token scrubbed,
    // console reports commit) but the rendered scene is still the
    // default C60 (atomCount === 60). Seed has 2 atoms; default C60
    // has 60. A divergence means the hydrate module's step-7 success
    // signal is lying about the committed state.
    await labTab.waitForFunction(
      () => {
        const w = window as unknown as { _getUIState?: () => { atomCount: number } };
        return w._getUIState?.()?.atomCount === 2;
      },
      { timeout: 8000 },
    );

    // The scene must STAY on the seed, not flash briefly and revert to
    // C60. That revert was the 2026-04-16 bug: the worker bridge's
    // `latestSnapshot` cached a pre-restoreState frame, and the frame
    // runtime's reconciler would pull it ~1 rAF tick after the
    // hydration lock released — clobbering physics back to 60 atoms.
    // 500 ms covers >24 frames at 60 fps AND gives the worker time to
    // emit its first post-restore frameResult. The reconciler only
    // mutates scene state via fresh snapshots, so a single stable
    // readout here is sufficient.
    await labTab.waitForTimeout(500);
    const stableAtomCount = await labTab.evaluate(() => {
      const w = window as unknown as { _getUIState?: () => { atomCount: number } };
      return w._getUIState?.()?.atomCount;
    });
    expect(stableAtomCount).toBe(2);
  });

  test('camera continuity: Lab camera pose matches Watch click-time pose (plan rev 4 phase 2)', async ({ page, context }) => {
    // Plan §"Test observability seams" — exact-match via typed hooks,
    // no pixel diffing. Verifies end-to-end:
    //   (1) Watch ships a non-null camera snapshot on click.
    //   (2) Lab's post-hydrate camera matches Watch's click-time camera
    //       within quantization epsilon (POSITION_Q = 0.01, FOV_Q = 0.5).
    await page.goto('/watch/?e2e=1');
    await page.waitForSelector('.watch-workspace', { timeout: 8000 });
    await loadWatchFixture(page);
    // Wait for the canvas to mount so the renderer is attached before
    // we read its camera snapshot. Without this, `_getWatchCameraSnapshot`
    // can return null if the workspace painted the toolbar but the canvas
    // hasn't yet run createRenderer on mount.
    await page.waitForSelector('.watch-workspace canvas', { timeout: 8000 });
    await page.waitForFunction(() => {
      const hook = (window as unknown as { _getWatchCameraSnapshot?: () => unknown })._getWatchCameraSnapshot;
      return hook?.() !== null && hook?.() !== undefined;
    }, { timeout: 8000 });
    await page.evaluate(() => {
      const hook = (window as unknown as { _watchScrub?: (ps: number) => void })._watchScrub;
      hook?.(25);
    });

    const primary = page.locator('.watch-lab-entry__primary').first();
    await primary.hover();

    // Read click-time camera pose (hover fired pre-mint; the contract
    // says plain left-click re-reads — but reading the pose NOW is a
    // proxy for the click handler's behavior because nothing moves
    // between here and the next line).
    const watchCamera = await page.evaluate(() => {
      const hook = (window as unknown as { _getWatchCameraSnapshot?: () => unknown })._getWatchCameraSnapshot;
      return hook?.() ?? null;
    });
    expect(watchCamera).not.toBeNull();

    const labTabPromise = context.waitForEvent('page');
    await primary.click();
    const labTab = await labTabPromise;
    await labTab.waitForLoadState('domcontentloaded');
    await labTab.waitForSelector('canvas', { timeout: 8000 });
    await labTab.waitForFunction(
      () => !new URL(location.href).searchParams.get('handoff'),
      { timeout: 8000 },
    );
    // Give hydrate a frame to apply the camera.
    await labTab.waitForFunction(
      () => {
        const hook = (window as unknown as { _getLabCameraSnapshot?: () => unknown })._getLabCameraSnapshot;
        return hook?.() !== null;
      },
      { timeout: 8000 },
    );

    // Compare quantized: position at 0.01, fov at 0.5.
    const POS_Q = 0.01;
    const FOV_Q = 0.5;
    const quantizeLocal = (c: { position: number[]; target: number[]; fovDeg: number }) => ({
      position: c.position.map((v) => Math.round(v / POS_Q)),
      target: c.target.map((v) => Math.round(v / POS_Q)),
      fovDeg: Math.round(c.fovDeg / FOV_Q),
    });

    const labCamera = await labTab.evaluate(() => {
      const hook = (window as unknown as { _getLabCameraSnapshot?: () => { position: number[]; target: number[]; fovDeg: number } | null })._getLabCameraSnapshot;
      return hook?.() ?? null;
    });
    expect(labCamera).not.toBeNull();
    expect(quantizeLocal(labCamera as { position: number[]; target: number[]; fovDeg: number })).toEqual(
      quantizeLocal(watchCamera as { position: number[]; target: number[]; fovDeg: number }),
    );
  });

  test('missing ?from=watch is fully silent — Lab boots normally, no status error', async ({ page }) => {
    await page.goto('/lab/');
    await page.waitForSelector('canvas', { timeout: 8000 });
    // Status bar may be absent (no error) or show a non-error message.
    // Assert: if it renders, it does NOT contain hydrate-failure copy.
    const status = await page.evaluate(
      () => (document.querySelector('[data-status-root]')?.textContent ?? '').trim(),
    );
    expect(status).not.toMatch(/Couldn\u2019t/i);
    expect(status).not.toMatch(/internal subsystems/i);
  });
});

// \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
// Touch-interaction auto-cue visibility for the Watch \u2192 Lab primary
// hint. Touch contexts previously hid the tooltip unconditionally; the
// CSS now allows the timed cue (`data-auto-cue="true"`) through while
// still suppressing hover/focus discoverability. Gate mirrors
// `isTouchInteraction()` at src/ui/device-mode.ts:46 (coarse primary
// pointer + no hover) using `not (hover: hover)` for exact parity with
// the JS predicate.
// Fixture timeline: 0.001 \u2192 100 ps; halfway milestone at ~50.0005.
// \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

test.describe('Watch → Lab primary hint — mobile auto-cue visibility', () => {
  const TOOLTIP_SELECTOR = '.watch-lab-entry__tooltip';

  // Touch-emulating context applied to every case in this describe.
  // Mirrors the pattern at tests/e2e/timeline-layout.spec.ts:154.
  test.use({
    hasTouch: true,
    isMobile: true,
    viewport: { width: 375, height: 812 },
  });

  async function scrubWatch(page: Page, ps: number): Promise<void> {
    await page.evaluate((target) => {
      const hook = (window as unknown as { _watchScrub?: (ps: number) => void })._watchScrub;
      if (!hook) throw new Error('_watchScrub test hook not installed');
      hook(target);
    }, ps);
    // Yield once to React so the snapshot from this scrub commits
    // before the next call. `useTimelineMilestoneTokens` is
    // arm-then-fire — the halfway milestone only fires after the
    // effect has *observed* a snapshot with `currentTimePs < midPs`.
    // Without this barrier, two back-to-back scrubs could be batched
    // and the hook would only see the second value, missing the arm
    // step.
    await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => r())));
  }

  test('coarse-pointer + idle → tooltip is display:none (no hover-discoverability path on touch)', async ({ page, baseURL }) => {
    await page.goto(`${baseURL}/watch/?e2e=1`);
    await page.waitForSelector('.watch-workspace', { timeout: 8000 });
    await loadWatchFixture(page);

    // Pin BOTH halves of the touch-interaction predicate the CSS gate
    // depends on. `noHover` mirrors the JS predicate exactly:
    // `!matchMedia('(hover: hover)').matches` (src/ui/device-mode.ts:46).
    // If a future browser emulation decouples the two features, the
    // visibility assertion below would be meaningless without this pin.
    const media = await page.evaluate(() => ({
      coarse: window.matchMedia('(pointer: coarse)').matches,
      noHover: !window.matchMedia('(hover: hover)').matches,
    }));
    expect(media.coarse).toBe(true);
    expect(media.noHover).toBe(true);

    // Tooltip is in the DOM (rendered by WatchLabEntryControl) but the
    // touch-context rule hides it when `data-auto-cue` is absent.
    const tooltip = page.locator(TOOLTIP_SELECTOR).first();
    await expect(tooltip).toBeAttached({ timeout: 4000 });
    const display = await tooltip.evaluate((el) => getComputedStyle(el).display);
    expect(display).toBe('none');
  });

  test('coarse-pointer + timeline halfway milestone → tooltip becomes visible during cue, then hides', async ({ page, baseURL }) => {
    await page.goto(`${baseURL}/watch/?e2e=1`);
    await page.waitForSelector('.watch-workspace', { timeout: 8000 });
    await loadWatchFixture(page);

    // Arm halfway (currentTimePs < midPs), then fire (currentTimePs
    // ≥ midPs). Fixture span is 0.001..100, midPs = 50.0005. The
    // 1-ps slack on the fire scrub absorbs any future float-precision
    // drift in the player so the comparison cannot silently miss.
    await scrubWatch(page, 5);
    await scrubWatch(page, 61);

    const tooltip = page.locator(TOOLTIP_SELECTOR).first();
    await expect(tooltip).toBeAttached();
    await expect(tooltip).toHaveAttribute('data-auto-cue', 'true', { timeout: 4000 });
    const visibleDisplay = await tooltip.evaluate((el) => getComputedStyle(el).display);
    expect(visibleDisplay).not.toBe('none');

    // 5 s cue window expires → React clears the attribute → CSS hides.
    await expect(tooltip).not.toHaveAttribute('data-auto-cue', 'true', { timeout: 8000 });
    const hiddenDisplay = await tooltip.evaluate((el) => getComputedStyle(el).display);
    expect(hiddenDisplay).toBe('none');
  });

  test('coarse-pointer + cue active + caret menu open → tooltip is suppressed (one-popover-at-a-time)', async ({ page, baseURL }) => {
    await page.goto(`${baseURL}/watch/?e2e=1`);
    await page.waitForSelector('.watch-workspace', { timeout: 8000 });
    await loadWatchFixture(page);

    await scrubWatch(page, 5);
    await scrubWatch(page, 61);

    const tooltip = page.locator(TOOLTIP_SELECTOR).first();
    await expect(tooltip).toHaveAttribute('data-auto-cue', 'true', { timeout: 4000 });

    // Opening the menu strips data-auto-cue (React-layer suppression).
    await page.locator('.watch-lab-entry__caret').click();
    await expect(tooltip).not.toHaveAttribute('data-auto-cue', 'true', { timeout: 2000 });
    const display = await tooltip.evaluate((el) => getComputedStyle(el).display);
    expect(display).toBe('none');
  });
});
