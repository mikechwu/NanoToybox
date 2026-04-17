/**
 * WatchLabEntryControl — primary-action pill with a caret-revealed
 * secondary option.
 *
 * Visual model (vs. the prior split-capsule):
 *
 *   Primary, always visible:
 *     ┌─────────────────────────┬────┐
 *     │  Interact From Here     │ ▼  │
 *     └─────────────────────────┴────┘
 *
 *   Caret click toggles an anchored popover:
 *                                 ┌──────────────────────────────┐
 *                                 │ New Empty Lab                │
 *                                 │ Start fresh in an empty      │
 *                                 │ interactive space — build    │
 *                                 │ new molecular setups…        │
 *                                 └──────────────────────────────┘
 *
 * Why the redesign:
 *   A first-time Watch user doesn't know what "Lab" is. Surfacing
 *   "Interact From Here" as the primary CTA tells them exactly what
 *   happens when they click: they take over the physics at the frame
 *   they're viewing. The second option (a fresh empty Lab) is a power-
 *   user path and lives behind a caret; revealing it on demand keeps
 *   the first-run surface clean without removing the capability.
 *
 * Click-ownership contract (unchanged from the split-capsule era):
 *
 *   PRIMARY — "Interact From Here"
 *     - `href` is DYNAMIC — cached by the controller, nulled when the
 *       seed identity (frame, topology, camera) changes. Mint-on-intent
 *       via `onContinueIntent` / `onContinueIdle` so middle-click and
 *       modifier-click open a new tab with a live handoff URL.
 *     - On PLAIN LEFT-CLICK, the component calls `preventDefault()`
 *       and routes through `onOpenCurrentFrameLab` (which invokes
 *       `controller.openLabFromCurrentFrame()` — the remint-if-stale
 *       + window.open authority).
 *     - On MODIFIED / MIDDLE click, native anchor navigation takes
 *       over using the cached href.
 *     - Disabled state (unseedable file) renders as `<button disabled>`
 *       with `title` + matching `aria-label`; the hover tooltip is not
 *       rendered in the disabled case.
 *
 *   SECONDARY — "New Empty Lab" (in the caret popover)
 *     - `href` is STATIC (`/lab/`); cannot go stale.
 *     - The anchor's `target="_blank"` is the SOLE navigation owner.
 *     - `onOpenPlainLab` is an OPTIONAL side-effect hook (analytics)
 *       that MUST NOT navigate.
 *
 * DOM class compatibility:
 *   The `.watch-lab-entry__primary` and `.watch-lab-entry__secondary`
 *   class names are preserved (E2E tests + Playwright selectors rely
 *   on them) even though "secondary" now lives inside the popover
 *   instead of the capsule's left half.
 *
 * Accessibility:
 *   - Caret is a `<button aria-haspopup="menu" aria-expanded>` toggle.
 *     The popover uses `role="menu"` / `role="menuitem"` so screen
 *     readers announce the "More options" semantics.
 *   - Escape closes the popover; outside-click closes the popover;
 *     focus moves back to the caret after close.
 *   - Focus order (Tab): primary → caret → (if open) first menu item.
 */

import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useTimedCue } from '../../../src/ui/use-timed-cue';

// ── Canonical strings — single source of truth ───────────────────────
//
// Exports are test-facing contracts. Module-local consts (LAB_ENTRY_*_)
// stay internal — they're tooltip prose that tests assert on via
// substring matches against the rendered DOM, not via identity.
export const LAB_ENTRY_PRIMARY_LABEL = 'Interact From Here';
export const LAB_ENTRY_SECONDARY_TITLE = 'Open a Fresh Lab';
export const LAB_ENTRY_CARET_LABEL = 'More ways to open Lab';
export const LAB_ENTRY_PRIMARY_DISABLED_REASON = "This frame can\u2019t be used yet";

// Two short sentences. No em-dash: em-dashes force awkward mid-bubble
// line breaks and read as connective punctuation rather than a period.
const LAB_ENTRY_PRIMARY_TOOLTIP =
  'Take over from this exact frame. Drag atoms and watch the physics react.';
// "Open a Fresh Lab" (title) is descriptive enough to tell the user
// what the click does; the description names what they'll see.
const LAB_ENTRY_SECONDARY_DESCRIPTION =
  'Starts with a default molecule. Build and experiment from there.';

/** How long the primary tooltip stays visible on an auto-cue firing
 *  (1 s fade-in + 3 s hold + 1 s fade-out). Kept in sync with the CSS
 *  keyframe `watchLabPrimaryHintAutoCue` — any change to this
 *  constant must match the keyframe's `5s` duration. */
const LAB_ENTRY_AUTO_CUE_DURATION_MS = 5_000;

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
   *  the user clicks. Safe to call on every hover — controller caches
   *  by seed identity. */
  onContinueIntent?: () => void;
  /** Fires when intent cools — pointerleave + blur. Controller
   *  debounces cache invalidation (500 ms) so a quick hover-off /
   *  hover-on reuses the token; sustained absence mints fresh. */
  onContinueIdle?: () => void;
  /**
   * Monotonic token bumped by the parent when an auto-cue trigger
   * fires (timeline-halfway, timeline-end). Each distinct value
   * restarts the tooltip's 1s-in / 3s-hold / 1s-out animation. Leave
   * undefined (or keep at 0 forever) to suppress all auto-cueing —
   * the tooltip falls back to hover/focus-only reveal.
   *
   * Why a token rather than a boolean: two milestones fire the same
   * state transition (hidden → visible → hidden after 5 s), so a
   * boolean can't distinguish successive firings from duplicate
   * renders. An incrementing number makes the child's change
   * detection unambiguous and gives React a natural `key` to remount
   * the tooltip span so the CSS keyframe restarts from 0 %.
   */
  primaryAutoCueToken?: number;
}

function isPlainLeftClick(e: React.MouseEvent): boolean {
  return e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;
}

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
    primaryAutoCueToken,
  } = props;

  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const caretRef = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  const tooltipId = useId();

  // Auto-cue driver — shared with TimelineBar's TransferTrigger via
  // the `useTimedCue` hook. Returns `{ active, animKey }`:
  //   · `active` gates the tooltip's `data-auto-cue` attribute.
  //   · `animKey` rekeys the tooltip span so each firing mounts a
  //     fresh element → CSS keyframe restarts from 0 %.
  const { active: autoCueActive, animKey: autoCueAnimKey } = useTimedCue({
    triggerToken: primaryAutoCueToken,
    durationMs: LAB_ENTRY_AUTO_CUE_DURATION_MS,
  });

  // ── Primary click (unchanged from prior implementation) ──
  const handlePrimaryClick = useCallback((e: React.MouseEvent) => {
    if (!currentFrameAvailable) {
      e.preventDefault();
      return;
    }
    if (!isPlainLeftClick(e)) return;
    e.preventDefault();
    onOpenCurrentFrameLab(e);
  }, [currentFrameAvailable, onOpenCurrentFrameLab]);

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

  // ── Secondary click (hidden in menu) ──
  const handleSecondaryClick = useCallback((e: React.MouseEvent) => {
    if (!enabled) {
      e.preventDefault();
      return;
    }
    if (!isPlainLeftClick(e)) return;
    onOpenPlainLab?.(e);
    setMenuOpen(false);
  }, [enabled, onOpenPlainLab]);

  // ── Menu open/close ──
  const toggleMenu = useCallback(() => setMenuOpen((o) => !o), []);
  const closeMenu = useCallback((returnFocus?: boolean) => {
    setMenuOpen(false);
    if (returnFocus) caretRef.current?.focus();
  }, []);

  // Escape + outside-click close. Attached only while open to minimize
  // global-listener noise.
  //
  // Focus-return contract: if focus is currently INSIDE the menu when
  // it closes (keyboard-user tabbed onto the item and then clicked
  // away, say), unmounting the menu drops focus to `document.body`
  // and breaks the next Shift-Tab. Detect that case and route focus
  // back to the caret so the disclosure behaves like a proper
  // focus-owning widget.
  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        closeMenu(true);
      }
    };
    const onPointerDown = (e: PointerEvent) => {
      const root = rootRef.current;
      if (root && e.target instanceof Node && !root.contains(e.target)) {
        const focusInsideMenu = root.contains(document.activeElement);
        closeMenu(focusInsideMenu);
      }
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onPointerDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onPointerDown);
    };
  }, [menuOpen, closeMenu]);

  if (!enabled) return null;

  const primaryDisabled = !currentFrameAvailable;
  const primaryHref = currentFrameLabHref ?? '';

  // ── Primary node ──
  const primaryNode = primaryDisabled ? (
    <button
      type="button"
      className="watch-lab-entry__primary watch-lab-entry__primary--disabled"
      disabled
      title={`${LAB_ENTRY_PRIMARY_LABEL} — ${LAB_ENTRY_PRIMARY_DISABLED_REASON}`}
      aria-label={`${LAB_ENTRY_PRIMARY_LABEL} — ${LAB_ENTRY_PRIMARY_DISABLED_REASON}`}
    >
      <span className="watch-lab-entry__primary-label">{LAB_ENTRY_PRIMARY_LABEL}</span>
    </button>
  ) : (
    <a
      className="watch-lab-entry__primary"
      href={primaryHref}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={LAB_ENTRY_PRIMARY_LABEL}
      aria-describedby={tooltipId}
      onClick={handlePrimaryClick}
      onPointerEnter={handleContinueIntent}
      onFocus={handleContinueIntent}
      onPointerLeave={handleContinueIdle}
      onBlur={handleContinueIdle}
    >
      <span className="watch-lab-entry__primary-label">{LAB_ENTRY_PRIMARY_LABEL}</span>
    </a>
  );

  // ── Caret toggle ──
  const caretNode = (
    <button
      ref={caretRef}
      type="button"
      className={`watch-lab-entry__caret${menuOpen ? ' watch-lab-entry__caret--open' : ''}`}
      aria-label={LAB_ENTRY_CARET_LABEL}
      // `aria-haspopup="true"` — disclosure pattern, not a menu.
      // WAI-ARIA APG's `menu` role commits the author to a full
      // keyboard contract (Arrow navigation, Home/End, typeahead, etc.)
      // that this single-item dropdown doesn't justify. Disclosure is
      // the honest semantic: a toggle that reveals a popover of links.
      aria-haspopup="true"
      aria-expanded={menuOpen}
      aria-controls={menuOpen ? menuId : undefined}
      onClick={toggleMenu}
    >
      {/* Downward chevron as SVG so the glyph rotates smoothly on
          open/close. Unicode ▼ would shift vertical metrics across
          fonts; SVG keeps the baseline stable. */}
      <svg
        className="watch-lab-entry__caret-glyph"
        width="10"
        height="10"
        viewBox="0 0 10 10"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <polyline points="2 4 5 7 8 4" />
      </svg>
    </button>
  );

  // ── Menu popover ──
  // Disclosure-pattern popover: a group of links revealed by the
  // caret toggle. No `role="menu"` / `role="menuitem"` because we
  // don't implement the menu APG keyboard contract. Native anchor
  // + Tab/Shift-Tab + Escape suffice for a one-item dropdown.
  const menuNode = menuOpen ? (
    <div
      id={menuId}
      className="watch-lab-entry__menu"
      role="group"
      aria-label={LAB_ENTRY_CARET_LABEL}
    >
      <a
        className="watch-lab-entry__secondary"
        href={plainLabHref}
        target="_blank"
        rel="noopener noreferrer"
        onClick={handleSecondaryClick}
      >
        <span className="watch-lab-entry__secondary-label">
          {LAB_ENTRY_SECONDARY_TITLE}
        </span>
        <span className="watch-lab-entry__menu-item-desc">
          {LAB_ENTRY_SECONDARY_DESCRIPTION}
        </span>
      </a>
    </div>
  ) : null;

  return (
    <>
      <div
        className="watch-lab-entry"
        role="group"
        aria-label="Lab entry"
        ref={rootRef}
        // `data-menu-open` drives a CSS `:has()` rule that suppresses
        // the hover tooltip while the menu is open, enforcing
        // one-popover-at-a-time visually.
        data-menu-open={menuOpen ? 'true' : 'false'}
      >
        {primaryNode}
        {caretNode}
        {menuNode}
      </div>
      {!primaryDisabled && (
        <>
          <span
            // React-key off the auto-cue counter so every firing
            // mounts a fresh span — the CSS keyframe restarts from
            // 0 % instead of latching on a previously-finished
            // animation.
            key={autoCueActive ? `cue-${autoCueAnimKey}` : 'idle'}
            id={tooltipId}
            className="watch-lab-entry__tooltip"
            role="tooltip"
            // Suppressed while the menu is open so the tooltip and
            // the menu can never both be visible at once.
            data-auto-cue={autoCueActive && !menuOpen ? 'true' : undefined}
          >
            {LAB_ENTRY_PRIMARY_TOOLTIP}
          </span>
          {/* Screen-reader announcement for auto-cue firings. The
              visual tooltip uses `role="tooltip"` which SR readers
              only read on focus; the auto-cue is a passive signal
              (user didn't focus the button), so keyboard-only /
              screen-reader users would otherwise miss it entirely.
              A live region re-renders its content each firing
              (keyed on animKey) so assistive tech emits a polite
              announcement. Empty on idle → no repeated reads. */}
          <span
            className="sr-only"
            aria-live="polite"
            aria-atomic="true"
            data-testid="watch-lab-entry-autocue-announcer"
          >
            {autoCueActive ? `${LAB_ENTRY_PRIMARY_LABEL}. ${LAB_ENTRY_PRIMARY_TOOLTIP}` : ''}
          </span>
        </>
      )}
    </>
  );
}
