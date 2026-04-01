/**
 * Shared E2E test helpers.
 *
 * gotoApp: navigates to an app page with ?e2e=1 to suppress onboarding.
 * Uses the URL API for safe query-param composition.
 */

import type { Page } from '@playwright/test'

/**
 * Navigate to an app page with ?e2e=1 appended (suppresses onboarding overlay).
 * All non-onboarding E2E tests should use this instead of page.goto() for /page/ paths.
 *
 * @param page - Playwright page
 * @param baseURL - Playwright baseURL (e.g. http://127.0.0.1:4173/NanoToybox)
 * @param path - Path relative to baseURL (e.g. '/page/')
 */
export function gotoApp(page: Page, baseURL: string, path: string) {
  const full = baseURL + path
  const url = new URL(full)
  url.searchParams.set('e2e', '1')
  return page.goto(url.toString())
}
