/**
 * Enforces the contract between `CURRENT_THUMB_DEFAULT_INK` (TS) and
 * the account palette's `--color-text` token (CSS).
 *
 * The thumb SVG uses `fill="currentColor"` for its background rect.
 * The account row inherits `--color-text` through `body { color: ...
 * }` so currentColor there resolves to the account theme. The audit
 * workbench mounts the same SVG outside the account DOM, so it
 * instead applies `CURRENT_THUMB_DEFAULT_INK` as an ambient `color`
 * to stay visually faithful.
 *
 * The TS constant is a MIRROR, not a single source of truth. If
 * either side is edited without updating the other, this test fails
 * — which is the entire point. Any refactor that centralizes the
 * token (generated CSS custom property, shared design-token module,
 * etc.) should delete this file together with the duplication it
 * was policing.
 *
 * Parsing strategy:
 *   - Read `public/account-layout.css`.
 *   - Slice off everything from the first dark-mode `@media` block
 *     onward; whatever's left defines the LIGHT-theme tokens.
 *   - Match `--color-text: <value>;` and normalize against the TS
 *     constant (3-digit hex ↔ 6-digit hex, case-insensitive).
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { CURRENT_THUMB_DEFAULT_INK } from '../../src/share/capsule-preview-current-thumb';

const ACCOUNT_CSS_PATH = resolve(
  __dirname,
  '..',
  '..',
  'public',
  'account-layout.css',
);
const DARK_MEDIA_QUERY = '@media (prefers-color-scheme: dark)';

/** Normalize #rgb / #rrggbb to lowercase 6-digit hex. Returns input
 *  unchanged for non-hex values (e.g. rgb(), hsl(), named colors) so
 *  the equality comparison still rejects a mismatch with a readable
 *  error. */
function normalizeHex(input: string): string {
  const trimmed = input.trim().toLowerCase();
  const shortMatch = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(trimmed);
  if (shortMatch) {
    const [, r, g, b] = shortMatch;
    return `#${r}${r}${g}${g}${b}${b}`;
  }
  return trimmed;
}

describe('CURRENT_THUMB_DEFAULT_INK mirrors account --color-text', () => {
  it('matches the light-theme account palette token', () => {
    const css = readFileSync(ACCOUNT_CSS_PATH, 'utf8');
    const darkIdx = css.indexOf(DARK_MEDIA_QUERY);
    // Tokens defined before the dark-mode block are the light scope.
    // Works because the CSS file is structured "light root first,
    // then dark media override" (line 17 vs line 52 today).
    const lightScope = darkIdx >= 0 ? css.slice(0, darkIdx) : css;

    const tokenMatch = /--color-text\s*:\s*([^;]+);/.exec(lightScope);
    expect(
      tokenMatch,
      '--color-text must be defined in the light scope of account-layout.css',
    ).not.toBeNull();

    const cssValue = normalizeHex(tokenMatch![1]);
    const tsValue = normalizeHex(CURRENT_THUMB_DEFAULT_INK);
    expect(
      cssValue,
      `Drift detected:\n` +
        `  CSS --color-text (light)       = ${tokenMatch![1].trim()}  → ${cssValue}\n` +
        `  TS  CURRENT_THUMB_DEFAULT_INK  = ${CURRENT_THUMB_DEFAULT_INK}  → ${tsValue}\n` +
        `Update both sides together (see capsule-preview-current-thumb.tsx docstring).`,
    ).toBe(tsValue);
  });
});
