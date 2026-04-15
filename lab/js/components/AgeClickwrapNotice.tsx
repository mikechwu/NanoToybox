/**
 * AgeClickwrapNotice — single-source clickwrap copy used everywhere a
 * user crosses the 13+ age gate.
 *
 * Renders one short paragraph with linked Privacy/Terms anchors. The
 * caller wires the matching `id` on this paragraph to provider buttons
 * via `aria-describedby` so screen readers hear the clickwrap as the
 * button's described context, not as a disconnected paragraph
 * elsewhere on screen.
 *
 * Locations + matching `id` values:
 *
 *   - `id="age-clickwrap-account"` — AccountControl signed-out menu
 *   - `id="age-clickwrap-share"`   — Transfer dialog signed-out Share panel
 *   - `id="age-clickwrap-publish"` — Transfer dialog publish-428 fallback
 *
 * The `action` prop chooses the verb prefix so the sentence stays in
 * agreement with the button label the user is about to press:
 *   - `'continue'` → "By continuing, you confirm…"
 *   - `'publish'`  → "By clicking Publish, you confirm…"
 *
 * Inline links open in a new tab with `noopener noreferrer` and an
 * "(opens in new tab)" aria-label so the new-tab affordance is
 * announced. CSS gives them extra vertical padding so the tap target
 * is touch-friendly on mobile (~26-30 px) without breaking paragraph
 * rhythm — see `.age-clickwrap a` in `lab/index.html`.
 */

import React from 'react';

export type AgeClickwrapAction = 'continue' | 'publish';

interface AgeClickwrapNoticeProps {
  /** Stable DOM id so callers can wire `aria-describedby` on the
   *  buttons that gate the action. */
  id: string;
  action: AgeClickwrapAction;
}

export function AgeClickwrapNotice({ id, action }: AgeClickwrapNoticeProps) {
  const prefix = action === 'publish' ? 'By clicking Publish' : 'By continuing';
  return (
    <p id={id} className="age-clickwrap">
      {prefix}, you confirm that you are at least 13 years old, or older
      if required by the laws of your country of residence, and agree to
      our{' '}
      <a
        href="/privacy/"
        target="_blank"
        rel="noopener noreferrer"
        aria-label="Privacy Policy (opens in new tab)"
      >
        Privacy Policy
      </a>
      {' '}and{' '}
      <a
        href="/terms/"
        target="_blank"
        rel="noopener noreferrer"
        aria-label="Terms (opens in new tab)"
      >
        Terms
      </a>
      .
    </p>
  );
}
