/**
 * Single source of truth for the account-row thumbnail display size.
 *
 * The size was previously hard-coded as `40` at multiple sites:
 *   - `account/main.tsx`'s `THUMB_SIZE`
 *   - `CurrentThumbSvg`'s `CURRENT_THUMB_DEFAULT_SIZE`
 *   - `.acct__upload-thumb` in `public/account-layout.css`
 *   - unit-test harnesses + Playwright fixtures
 *
 * Any pivot to a larger surface (the 80–120 px band the product
 * direction settled on) required touching all of those in lockstep.
 * This module centralizes the number so future size tweaks only need
 * to update two places: THIS file and the CSS rule (CSS can't
 * `import`, so the rule carries a "mirror" comment pointing here).
 *
 * **Current value: 96 px.** Chosen inside the 80–120 product band
 * because it doubles atom glyph area vs the old 40 px without
 * pushing the account grid track past the row meta baseline. The
 * renderer constants in `capsule-preview-thumb-render.ts` live in
 * the 100-unit viewBox, so they scale naturally with this size —
 * only physical-pixel tuning (stroke weights, halos) benefits from
 * a second pass if this changes much further.
 *
 * Pure module; no runtime logic; tree-shakes.
 */

/** Physical-pixel rendered size of the account-row thumb SVG.
 *  Mirrored by `public/account-layout.css`'s `.acct__upload-thumb`
 *  width/height rule — keep the two in sync. */
export const ACCOUNT_THUMB_SIZE = 96;
