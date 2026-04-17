/**
 * WatchLabEntryControl — split-button that sends viewers to Lab.
 *
 * Two navigation paths with different ownership models. The
 * authoritative contract is the "Click-ownership contract" docstring
 * on `WatchLabEntryControlProps` below; this header summary stays
 * deliberately short so a future reader cannot skim-absorb a stale
 * description and reintroduce a double-navigation regression.
 *
 *   - Primary "Open in Lab": the anchor OWNS navigation via
 *     `target="_blank" rel="noopener noreferrer"`. No preventDefault,
 *     no controller nav call from the click handler.
 *   - Current-frame "From this frame": the controller OWNS plain-click
 *     navigation (so the remint-if-stale logic is authoritative).
 *     Plain-click → preventDefault + callback. Modified / middle click
 *     stays native via the cached href (which is null when stale).
 *
 * Accessibility notes are preserved verbatim below the contract. They
 * describe the dropdown's role/menu behavior, not the click paths.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';

/**
 * NOTE — `busy` prop intentionally omitted from this PR's API surface.
 * The plan reserves a `busy` state for in-flight handoff serialization,
 * but that state has no producer until the current-frame Remix path
 * lands in PR 2. Shipping a prop that doesn't suppress interaction is
 * a footgun (consumers reasonably assume it gates clicks); per rev 6
 * follow-up P2.2 we reintroduce it at the same time its enforcement
 * ships, so primary / caret / menu all honor it together.
 */
/**
 * Click-ownership contract for the two navigation paths:
 *
 *   PRIMARY ("Open in Lab"):
 *     - href is STATIC (`/lab/`); cannot go stale.
 *     - The anchor's `target="_blank"` + `rel="noopener noreferrer"`
 *       is the SOLE navigation owner.
 *     - `onOpenPlainLab` is an OPTIONAL, SIDE-EFFECT-ONLY hook for
 *       analytics / hint dismissal / etc. It MUST NOT navigate. Not
 *       passing a handler is the expected default.
 *     - The component NEVER calls `preventDefault()` on this path.
 *
 *   CURRENT-FRAME ("From this frame"):
 *     - href is DYNAMIC — cached by the controller on menu-open and
 *       can go stale if playback advances.
 *     - On PLAIN LEFT-CLICK, the component calls `preventDefault()`
 *       and routes through `onOpenCurrentFrameLab` as the SOLE
 *       navigation owner (which invokes `controller.openLabFromCurrentFrame`
 *       — that's where the "remint if stale" logic lives, so this path
 *       always captures the user's currently visible frame).
 *     - On MODIFIED / MIDDLE click, the anchor's native navigation
 *       follows the cached href. This is acceptable because:
 *         (a) the snapshot projection nulls the href as soon as the
 *             display-frame identity changes, so a stale middle-click
 *             disables the item entirely, and
 *         (b) modified-click callers accept the browser-native
 *             behavior as part of normal "open in new tab" ergonomics.
 *
 * Any callback intended to NAVIGATE is the exclusive owner of its
 * click path. Any callback intended as a SIDE-EFFECT HOOK must never
 * navigate. Mixing the two caused a duplicate-tab regression and is
 * explicitly forbidden by this contract.
 */
export interface WatchLabEntryControlProps {
  enabled: boolean;
  currentFrameAvailable: boolean;
  /** Controller-derived href for plain Lab. Always present when enabled. */
  plainLabHref: string;
  /** Controller-derived href for the current-frame target, or null. */
  currentFrameLabHref: string | null;
  /**
   * OPTIONAL side-effect-only hook for the primary click. MUST NOT
   * navigate — the anchor's `target="_blank"` already handles that.
   * Typical uses: analytics, dismissing the Lab-entry hint, closing
   * an unrelated overlay. Omit in normal wiring; there is nothing to
   * do on a plain `Open in Lab` click today.
   */
  onOpenPlainLab?: (event?: React.MouseEvent) => void;
  /**
   * NAVIGATION-OWNING callback for the current-frame plain-click.
   * The component calls `preventDefault()` before invoking this, so
   * this callback is the SOLE navigator. Must invoke
   * `controller.openLabFromCurrentFrame()` (or an equivalent) which
   * handles the remint-if-stale contract and calls `window.open`.
   */
  onOpenCurrentFrameLab: (event?: React.MouseEvent) => void;
  /** Caret open/close — controller listens so it can mint a fresh
   *  current-frame href on open and debounce invalidation on close. */
  onCaretOpen?: () => void;
  onCaretClose?: () => void;
}

function isPlainLeftClick(e: React.MouseEvent): boolean {
  return e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;
}

/**
 * Accessibility notes (rev 6):
 *   - Caret button carries `aria-haspopup="true"` + `aria-expanded`.
 *   - Caret glyph is `aria-hidden="true"`; the button's accessible
 *     name comes from `aria-label="More ways to open Lab"`.
 *   - Dropdown container is `role="menu"`; enabled item is
 *     `role="menuitem"` on an anchor; disabled item is a native
 *     `<button disabled role="menuitem">` (auto-removed from tab order).
 *   - Arrow-Down / Enter / Space on the caret opens the dropdown and
 *     moves focus to the first menuitem; Escape closes the dropdown
 *     and returns focus to the caret.
 *   - Roving Arrow-Up/Down cycling INSIDE the menu is deferred: one
 *     actionable item today, so cycling has no useful destination.
 *     Reintroduce a roving-focus handler when PR 2+ adds a second row.
 */
export function WatchLabEntryControl(props: WatchLabEntryControlProps) {
  const {
    enabled,
    currentFrameAvailable,
    plainLabHref,
    currentFrameLabHref,
    onOpenPlainLab,
    onOpenCurrentFrameLab,
    onCaretOpen,
    onCaretClose,
  } = props;

  const [menuOpen, setMenuOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const caretRef = useRef<HTMLButtonElement | null>(null);
  const firstItemRef = useRef<HTMLAnchorElement | HTMLButtonElement | null>(null);

  const openMenu = useCallback(() => {
    setMenuOpen(true);
    // Only notify the controller to mint a current-frame handoff when
    // the menu has a chance of exposing an enabled action. If
    // `currentFrameAvailable` is false — e.g. feature flag off, or the
    // current frame is not seedable — we still open the dropdown (to
    // show the disabled item + caption) but do NOT trigger a mint.
    // Defence-in-depth against the controller-side guard in
    // `buildCurrentFrameLabHref`; failing either one keeps the UI-gated
    // build from writing localStorage.
    if (currentFrameAvailable) onCaretOpen?.();
  }, [onCaretOpen, currentFrameAvailable]);

  const closeMenu = useCallback((refocusCaret = false) => {
    setMenuOpen(false);
    onCaretClose?.();
    if (refocusCaret) caretRef.current?.focus();
  }, [onCaretClose]);

  // Outside click closes menu
  useEffect(() => {
    if (!menuOpen) return;
    function onDocDown(e: PointerEvent) {
      const root = rootRef.current;
      if (!root) return;
      if (root.contains(e.target as Node)) return;
      closeMenu(false);
    }
    document.addEventListener('pointerdown', onDocDown, true);
    return () => document.removeEventListener('pointerdown', onDocDown, true);
  }, [menuOpen, closeMenu]);

  // Focus first item on open
  useEffect(() => {
    if (menuOpen) {
      // Rendering pass: first item is mounted now, move focus
      firstItemRef.current?.focus();
    }
  }, [menuOpen]);

  const handleMenuKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      closeMenu(true);
    }
  }, [closeMenu]);

  const handleCaretKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (!menuOpen) openMenu();
    } else if (e.key === 'Escape' && menuOpen) {
      e.preventDefault();
      closeMenu(true);
    }
  }, [menuOpen, openMenu, closeMenu]);

  // PRIMARY — anchor is sole nav owner. Optional side-effect hook
  // fires but MUST NOT navigate (see WatchLabEntryControlProps
  // docstring). Earlier revisions called both an intercepted
  // `window.open` and the native anchor, producing either a duplicate
  // tab (without preventDefault) or a false-positive popup-blocker
  // banner (with preventDefault + the `noopener` null-return). Both
  // are forbidden by the split-ownership contract.
  const handlePrimaryClick = useCallback((e: React.MouseEvent) => {
    if (!enabled) {
      // Disabled component → suppress the anchor's navigation so
      // clicking the dim state does not open an empty tab.
      e.preventDefault();
      return;
    }
    if (!isPlainLeftClick(e)) return; // modifiers handled by the browser natively
    // Side-effect hook only — no preventDefault, no navigation.
    onOpenPlainLab?.(e);
  }, [enabled, onOpenPlainLab]);

  // CURRENT-FRAME — callback is sole nav owner on plain left-click
  // (we preventDefault so the cached-but-possibly-stale href does NOT
  // navigate natively; the controller re-mints if stale then calls
  // window.open). Modified / middle click fall through to the
  // anchor's native path using the cached href — acceptable because
  // a stale cache produces null href which disables the item.
  const handleCurrentFrameClick = useCallback((e: React.MouseEvent) => {
    if (!currentFrameAvailable || currentFrameLabHref == null) {
      e.preventDefault();
      return;
    }
    if (!isPlainLeftClick(e)) return; // let browser handle modifier/middle clicks
    e.preventDefault();                // sole-owner: prevent the anchor's native nav
    onOpenCurrentFrameLab(e);          // controller.openLabFromCurrentFrame() navigates
    closeMenu(false);                  // user picked an option; collapse dropdown
  }, [currentFrameAvailable, currentFrameLabHref, onOpenCurrentFrameLab, closeMenu]);

  if (!enabled) return null;

  return (
    <div
      className="watch-lab-entry"
      data-state={menuOpen ? 'open' : 'closed'}
      ref={rootRef}
    >
      <a
        className="watch-lab-entry__primary"
        href={plainLabHref}
        target="_blank"
        rel="noopener noreferrer"
        onClick={handlePrimaryClick}
      >
        <span className="watch-lab-entry__primary-label">Open in Lab</span>
      </a>
      <button
        type="button"
        className="watch-lab-entry__caret"
        aria-label="More ways to open Lab"
        aria-haspopup="true"
        aria-expanded={menuOpen}
        onClick={() => (menuOpen ? closeMenu(false) : openMenu())}
        onKeyDown={handleCaretKeyDown}
        ref={caretRef}
        data-state={menuOpen ? 'open' : 'closed'}
      >
        <span aria-hidden="true" className="watch-lab-entry__caret-glyph">▾</span>
      </button>
      {menuOpen && (
        <div
          role="menu"
          className="watch-lab-entry__menu"
          onKeyDown={handleMenuKeyDown}
          aria-label="Open in Lab options"
        >
          {currentFrameAvailable && currentFrameLabHref ? (
            <a
              ref={firstItemRef as React.RefObject<HTMLAnchorElement>}
              role="menuitem"
              className="watch-lab-entry__menuitem"
              href={currentFrameLabHref}
              target="_blank"
              rel="noopener noreferrer"
              onClick={handleCurrentFrameClick}
              tabIndex={-1}
            >
              From this frame
            </a>
          ) : (
            <div className="watch-lab-entry__menuitem-wrap">
              <button
                ref={firstItemRef as React.RefObject<HTMLButtonElement>}
                type="button"
                role="menuitem"
                className="watch-lab-entry__menuitem watch-lab-entry__menuitem--disabled"
                disabled
              >
                From this frame
              </button>
              <span className="watch-lab-entry__menu-caption">
                Not seedable from this frame
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
