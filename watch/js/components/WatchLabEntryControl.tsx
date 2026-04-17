/**
 * WatchLabEntryControl — split-capsule Lab entry.
 *
 * ONE pill-shaped container holding two halves:
 *   - LEFT half: "Open Lab" — ghost surface. Opens Lab with its
 *     default scene.
 *   - RIGHT half: "Continue" — filled accent. Takes the current Watch
 *     frame's state and seeds a Lab session from it (the controller
 *     snaps to the nearest seedable dense frame internally, so this
 *     path is robust to smooth-playback cursors that land between
 *     frames).
 *
 * A 1px divider separates the halves; the outer border + fully
 * rounded corners make it read as one capsule, echoing the shape of
 * the Cinematic Camera toggle next to it. A custom CSS hover tooltip
 * ("Continue this frame in Lab") is rendered as a sibling of the
 * capsule so the capsule's `overflow: hidden` does not clip it; the
 * tooltip reveals on `:hover` / `:focus-visible` of the primary via a
 * `:has()` rule on `.watch-lab-entry-anchor`.
 *
 * Click-ownership contract:
 *
 *   PRIMARY ("Continue" — RIGHT half):
 *     - High-intent action — takes the current Watch frame's state
 *       and seeds a Lab session from it. No leading icon; regular
 *       text weight.
 *     - `href` is DYNAMIC — cached by the controller, nulled when the
 *       display/topology/restart identity changes. Mint-on-intent:
 *       `onContinueIntent` fires on pointerenter / focus so the
 *       handoff token is minted BEFORE the user clicks (middle-click
 *       / ⌘-click need a live href to open a new tab with the
 *       handoff). `onContinueIdle` fires on pointerleave / blur for
 *       debounced cache invalidation.
 *     - On PLAIN LEFT-CLICK, the component calls `preventDefault()`
 *       and routes through `onOpenCurrentFrameLab` (which invokes
 *       `controller.openLabFromCurrentFrame()` — the remint-if-stale
 *       + window.open authority).
 *     - On MODIFIED / MIDDLE click, the anchor's native navigation
 *       follows the cached href.
 *     - Disabled state: genuinely unseedable file (e.g., single-frame
 *       capsule). Renders as a `<button disabled>` with a `title`
 *       tooltip explaining why; the custom hover tooltip is NOT
 *       rendered in the disabled case.
 *
 *   SECONDARY ("Open Lab" — LEFT half):
 *     - Opens Lab with whatever its default scene is (currently
 *       auto-loads C60 — so labelled "Open Lab" rather than "Open
 *       empty", which would misrepresent the state).
 *     - `href` is STATIC (`/lab/`); cannot go stale.
 *     - The anchor's `target="_blank"` is the SOLE navigation owner.
 *     - `onOpenPlainLab` is an OPTIONAL side-effect hook (analytics)
 *       that MUST NOT navigate.
 */

import React, { useCallback, useRef } from 'react';

export interface WatchLabEntryControlProps {
  enabled: boolean;
  currentFrameAvailable: boolean;
  /** Controller-derived href for plain Lab. Always present when enabled. */
  plainLabHref: string;
  /** Controller-derived href for the current-frame target, or null. */
  currentFrameLabHref: string | null;
  /**
   * OPTIONAL side-effect-only hook for the secondary click. MUST NOT
   * navigate — the anchor's `target="_blank"` already handles that.
   * Typical use: analytics. Omit in normal wiring.
   */
  onOpenPlainLab?: (event?: React.MouseEvent) => void;
  /**
   * NAVIGATION-OWNING callback for the primary plain-click. The
   * component calls `preventDefault()` before invoking this, so this
   * callback is the SOLE navigator. Must invoke
   * `controller.openLabFromCurrentFrame()` (or equivalent) which
   * handles the remint-if-stale contract and calls `window.open`.
   */
  onOpenCurrentFrameLab: (event?: React.MouseEvent) => void;
  /** Fires when the user signals intent to continue — pointerenter on
   *  non-touch, focus on keyboard. Controller mints a current-frame
   *  token on this signal so the anchor's href is populated before
   *  the user clicks (middle-click / cmd-click need a live href to
   *  open a new tab with the handoff). Safe to call on every hover —
   *  the controller caches by seed identity. */
  onContinueIntent?: () => void;
  /** Fires when intent cools — pointerleave + blur. Controller
   *  debounces cache invalidation (500 ms) so a quick hover-off /
   *  hover-on reuses the token; sustained absence mints fresh. */
  onContinueIdle?: () => void;
}

function isPlainLeftClick(e: React.MouseEvent): boolean {
  return e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;
}

/**
 * Accessibility notes:
 *   - Wrapper has `role="group"` + `aria-labelledby` pointing at the
 *     `LAB` overline so SR users hear "Lab group, Continue this
 *     frame in Lab, link" when they Tab onto the primary.
 *   - Both interactive elements are anchors (enabled case) or a
 *     native `<button disabled>` (primary when frame isn't seedable).
 *   - Disabled primary exposes `aria-describedby` pointing at the
 *     caption so the "can't be continued yet" reason is announced.
 *   - Focus order: primary → secondary (native Tab order, no custom
 *     key handling).
 *   - No role="menu" / menuitem — the dropdown is gone. Native
 *     semantics are stronger than the APG composite widget for this
 *     always-visible pair.
 */
export function WatchLabEntryControl(props: WatchLabEntryControlProps) {
  const {
    enabled,
    currentFrameAvailable,
    plainLabHref,
    currentFrameLabHref,
    onOpenPlainLab,
    onOpenCurrentFrameLab,
    onContinueIntent,
    onContinueIdle,
  } = props;

  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // SECONDARY — anchor is sole nav owner. Optional side-effect hook
  // fires but MUST NOT navigate (see props docstring).
  const handleSecondaryClick = useCallback((e: React.MouseEvent) => {
    if (!enabled) {
      e.preventDefault();
      return;
    }
    if (!isPlainLeftClick(e)) return; // modifiers handled by the browser natively
    onOpenPlainLab?.(e);
  }, [enabled, onOpenPlainLab]);

  // PRIMARY — callback is sole nav owner on plain left-click (we
  // preventDefault so the cached-but-possibly-stale href does NOT
  // navigate natively; the controller re-mints if stale OR missing
  // then calls window.open). Modified / middle click fall through
  // to the anchor using the cached href — those require the hover
  // mint to have populated the href already.
  const handlePrimaryClick = useCallback((e: React.MouseEvent) => {
    if (!currentFrameAvailable) {
      // Frame isn't seedable (shouldn't happen — disabled button has
      // no click handler — but defend anyway).
      e.preventDefault();
      return;
    }
    if (!isPlainLeftClick(e)) {
      // Modifier/middle click: let the browser handle it natively.
      // If the cached href is empty (hover hadn't minted yet), the
      // browser opens an empty tab pointed at the Watch page URL —
      // not ideal but rare in practice because mint-on-hover runs
      // before any reasonable click cadence.
      return;
    }
    // Plain left-click: sole nav owner. Controller mints-if-missing
    // + opens the new tab.
    e.preventDefault();
    onOpenCurrentFrameLab(e);
  }, [currentFrameAvailable, onOpenCurrentFrameLab]);

  // Mint-on-intent + debounced invalidation. Gated on
  // `currentFrameAvailable` so a non-seedable frame doesn't trigger
  // writes (defence-in-depth — the controller also guards).
  const handleContinueIntent = useCallback(() => {
    if (!currentFrameAvailable) return;
    if (idleTimerRef.current) {
      clearTimeout(idleTimerRef.current);
      idleTimerRef.current = null;
    }
    onContinueIntent?.();
  }, [currentFrameAvailable, onContinueIntent]);

  const handleContinueIdle = useCallback(() => {
    if (!currentFrameAvailable) return;
    onContinueIdle?.();
  }, [currentFrameAvailable, onContinueIdle]);

  if (!enabled) return null;

  // Primary is disabled ONLY when the frame itself isn't seedable.
  // A seedable-but-not-yet-minted state still renders as an anchor so
  // the hover/focus handlers can fire and populate the href — otherwise
  // the component is stuck in a catch-22 (disabled button won't mint,
  // no mint means no href, no href means disabled button). The
  // controller's click path handles the href-null case by calling
  // `openLabFromCurrentFrame()` which mints inline.
  const primaryDisabled = !currentFrameAvailable;
  // Empty href before mint is intentional — browsers treat
  // `<a href="">` as same-page and plain-click preventDefault
  // suppresses navigation. Middle-click with empty href is a no-op
  // (no new tab opens), which is acceptable because mint-on-hover
  // populates the href before a reasonably-paced middle-click.
  const primaryHref = currentFrameLabHref ?? '';
  const primaryDisabledReason = "This frame can\u2019t be continued yet";

  // DOM order matches visual order (left → right): secondary first,
  // primary second. Tab order follows DOM, so keyboard users land on
  // Open Lab before Continue — consistent with reading order.
  const secondaryNode = (
    <a
      className="watch-lab-entry__secondary"
      href={plainLabHref}
      target="_blank"
      rel="noopener noreferrer"
      onClick={handleSecondaryClick}
    >
      <span className="watch-lab-entry__secondary-label">Open Lab</span>
    </a>
  );

  // Primary surfaces visually as "Continue" (action verb that respects
  // the MD simulation metaphor — the user is scrubbing a trajectory
  // and wants to pick it up from this frame inside Lab). Paired with
  // the secondary "Open Lab", the split reads as "fresh start" vs.
  // "pick up from here". Accessible name carries the full
  // "Continue this frame in Lab" context for screen readers; the
  // native `title` is DROPPED on the enabled anchor so the browser's
  // built-in tooltip does not race against our custom CSS tooltip
  // (two bubbles on one hover = visual noise). Disabled `<button>`
  // keeps `title` because it has no custom tooltip.
  const primaryVisibleLabel = 'Continue';
  const primaryFullName = 'Continue this frame in Lab';
  const tooltipId = 'watch-lab-continue-tooltip';
  const primaryNode = primaryDisabled ? (
    <button
      type="button"
      className="watch-lab-entry__primary watch-lab-entry__primary--disabled"
      disabled
      title={`${primaryFullName} — ${primaryDisabledReason}`}
      aria-label={`${primaryFullName} — ${primaryDisabledReason}`}
    >
      <span className="watch-lab-entry__primary-label">{primaryVisibleLabel}</span>
    </button>
  ) : (
    <a
      className="watch-lab-entry__primary"
      href={primaryHref}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={primaryFullName}
      aria-describedby={tooltipId}
      onClick={handlePrimaryClick}
      onPointerEnter={handleContinueIntent}
      onFocus={handleContinueIntent}
      onPointerLeave={handleContinueIdle}
      onBlur={handleContinueIdle}
    >
      <span className="watch-lab-entry__primary-label">{primaryVisibleLabel}</span>
    </a>
  );

  // Tooltip — revealed on hover / focus of the primary anchor via a
  // `:has()` selector on the outer `.watch-lab-entry-anchor` wrapper
  // (see watch.css). Rendered as a sibling of the capsule so the
  // capsule's `overflow: hidden` (which clips the inner halves to the
  // pill shape) does NOT clip the tooltip. Only rendered when the
  // primary is the enabled anchor — the disabled `<button>` gets the
  // native `title` affordance instead. `role="tooltip"` + matching
  // `aria-describedby` on the primary wires the assistive-tech link.
  return (
    <>
      <div className="watch-lab-entry" role="group" aria-label="Lab entry">
        {secondaryNode}
        {primaryNode}
      </div>
      {!primaryDisabled && (
        <span
          id={tooltipId}
          className="watch-lab-entry__tooltip"
          role="tooltip"
        >
          {primaryFullName}
        </span>
      )}
    </>
  );
}
