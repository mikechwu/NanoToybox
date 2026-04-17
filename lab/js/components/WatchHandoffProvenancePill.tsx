/**
 * WatchHandoffProvenancePill — arrival state for a successful
 * Watch→Lab hydrate (plan §7.2).
 *
 * Shows in the lower-left of the canvas when the store slot
 * `watchHandoffProvenance` is non-null. Signals that the scene was
 * seeded from a Watch capsule frame, acknowledges lossiness for
 * approximated-velocity seeds (`· creative seed` suffix), and elides
 * raw filenames to avoid disclosure in screen recordings (§7.2
 * security rule).
 *
 * Copy variants (§9.5):
 *   - local + exact:        `From Watch · frame 412 · 3.42 ps`
 *   - local + approx:       `From Watch · frame 412 · 3.42 ps · creative seed`
 *   - shared + exact:       `From shared scene · frame 412 · 3.42 ps`
 *   - shared + approx:      `From shared scene · frame 412 · 3.42 ps · creative seed`
 *
 * When `frameId === null` (source did not expose a dense-frame index),
 * the `frame N` segment is elided rather than rendered as `frame null`
 * or `frame ?`.
 *
 * Behavior:
 *   - Auto-dismisses after `AUTO_DISMISS_MS` (plan §7.2).
 *   - Dismissable via the close affordance (44 × 44 touch target,
 *     per plan §9.6).
 *   - Session-scoped suppression: once dismissed for this token, a
 *     refresh of Lab will not re-show. The handoff itself is one-shot,
 *     so refresh typically lands on the default scene anyway; the
 *     suppression guards against accidentally re-showing if any boot
 *     path re-hydrates the same token.
 *
 * ARIA: `role="status"` + `aria-live="polite"` + `aria-atomic="true"`
 * so the arrival announcement reaches SR users non-intrusively.
 *
 * Omitted from this MVP (tracked in the §7.2 follow-up list):
 *   - the click-to-expand explainer sheet with the longer paragraph
 *   - forced-colors CSS specifics (lands with the §9.1.1 contrast
 *     table measurement work)
 *
 * The component is always mounted in Lab and renders null when the
 * store slot is null, so it's a no-op for any boot that did not
 * consume a handoff. (The Watch-side CTA that mints the handoff was
 * initially behind `REMIX_CURRENT_FRAME_UI_ENABLED`; that gate was
 * removed once all §7.2 release criteria shipped.)
 */

import React from 'react';
import { useAppStore } from '../store/app-store';

const AUTO_DISMISS_MS = 8000;
const SUPPRESS_KEY_PREFIX = 'atomdojo.watchHandoffPillDismissed:';

function suppressionKey(token: string): string {
  return `${SUPPRESS_KEY_PREFIX}${token}`;
}

function isAlreadyDismissedForToken(token: string): boolean {
  try {
    return sessionStorage.getItem(suppressionKey(token)) === '1';
  } catch {
    return false;
  }
}

function markDismissedForToken(token: string): void {
  try {
    sessionStorage.setItem(suppressionKey(token), '1');
  } catch {
    // sessionStorage can throw in private mode / blocked-storage origins.
    // Dismissal is still effective within this React instance via
    // `info === null`; we just can't persist across refresh. Silent.
  }
}

/** Formats the pill copy per the §9.5 copy table.
 *  Exported for unit tests so we can assert the exact string shape
 *  across all four variants without rendering the DOM.
 *
 *  Frame-numbering convention: the rendered `frame N` segment is
 *  1-based (ordinal), while `info.frameId` is the internal zero-based
 *  dense-frame index. We render `frameId + 1` because there is no
 *  other user-facing frame-number surface in Watch to anchor against,
 *  and `frame 0` in an arrival pill reads as "before playback
 *  started" — misleading for a user who just clicked Remix on the
 *  first frame. Every other internal API (seed, schema, store slot,
 *  Playwright fixtures) keeps the zero-based value so this shift is
 *  cosmetic and scoped to the rendered string. */
export function formatProvenancePillCopy(info: {
  isSharedScene: boolean;
  timePs: number;
  frameId: number | null;
  velocitiesAreApproximated: boolean;
}): string {
  const lead = info.isSharedScene ? 'From shared scene' : 'From Watch';
  // `frameId + 1`: zero-based internal index → 1-based user-facing ordinal.
  const framePart = info.frameId != null ? ` · frame ${info.frameId + 1}` : '';
  const timePart = ` · ${info.timePs.toFixed(2)} ps`;
  const approxPart = info.velocitiesAreApproximated ? ' · creative seed' : '';
  return `${lead}${framePart}${timePart}${approxPart}`;
}

export function WatchHandoffProvenancePill() {
  const info = useAppStore((s) => s.watchHandoffProvenance);
  const clear = useAppStore((s) => s.setWatchHandoffProvenance);

  // Suppression check — if this token was previously dismissed in the
  // same session, clear the slot immediately so nothing ever renders.
  React.useEffect(() => {
    if (info && isAlreadyDismissedForToken(info.token)) {
      clear(null);
    }
  }, [info, clear]);

  // Auto-dismiss timer — restarts whenever `info` (or its token)
  // transitions from null→non-null or token changes.
  React.useEffect(() => {
    if (!info) return;
    const id = window.setTimeout(() => {
      // Auto-dismiss does NOT mark session-dismissed. Rationale: the
      // user didn't explicitly close it, so a reload that lands here
      // again (rare under one-shot tokens, but possible) should still
      // acknowledge arrival. Only the explicit close affordance sets
      // the suppression flag.
      clear(null);
    }, AUTO_DISMISS_MS);
    return () => window.clearTimeout(id);
  }, [info, clear]);

  if (!info) return null;

  const copy = formatProvenancePillCopy(info);

  return (
    <div
      className="watch-handoff-provenance-pill"
      data-handoff-provenance-root
      role="status"
      aria-live="polite"
      aria-atomic="true"
    >
      <span className="watch-handoff-provenance-pill__copy">{copy}</span>
      <button
        type="button"
        className="watch-handoff-provenance-pill__close"
        aria-label="Dismiss notice"
        onClick={() => {
          markDismissedForToken(info.token);
          clear(null);
        }}
      >
        <span aria-hidden="true">×</span>
      </button>
    </div>
  );
}
