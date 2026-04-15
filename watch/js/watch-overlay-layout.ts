/**
 * Watch overlay layout — triad sizing/positioning using the same formulas as lab.
 *
 * Lab drives triad layout through lab/js/runtime/overlay-layout.ts which measures
 * [data-dock-root] and device mode. Watch uses the same sizing formulas but
 * measures [data-watch-bottom-chrome] (the combined dock+timeline wrapper).
 *
 * Triad sizing replicates lab/js/runtime/overlay-layout.ts:75-80:
 *   - phone:   min(140, max(96,  floor(viewportW * 0.15)))
 *   - default: min(200, max(120, floor(viewportW * 0.10)))
 *
 * Triad positioning (diverges intentionally from lab on tablet):
 *   - phone / tablet: bottom = barTopFromBottom + 8
 *   - desktop:        bottom = 12
 *   - left          = safeLeft + 6
 *
 * Why diverge on tablet? Lab places the triad at `bottom = 12` on
 * tablet because lab's iPad dock is a compact, centered control
 * that doesn't reach the bottom-left corner where the triad lives.
 * Watch's bottom chrome is full-width (timeline + dock) on every
 * breakpoint, so a fixed 12 px offset overlaps the chrome on iPad.
 * Clearing the bottom chrome on tablet keeps the triad visually
 * above the playback bar — matching lab's INTENT (triad not
 * obscured by dock) rather than its literal phone-only formula.
 *
 * Layout hook: [data-watch-bottom-chrome] on the bottom chrome wrapper in WatchApp.tsx.
 * Stable data attribute — does not depend on styling class names.
 *
 * RAF coalescing: uses a single _layoutPending boolean (matching lab's pattern
 * in overlay-layout.ts:49) to coalesce all layout sources (resize, observer,
 * bar retry) into at most one doLayout per frame.
 */

import type { WatchRenderer } from './watch-renderer';
import { getDeviceMode } from '../../src/ui/device-mode';

/** Selector for the bottom chrome layout hook (Round 5: combined dock+timeline wrapper). */
const PLAYBACK_BAR_SELECTOR = '[data-watch-bottom-chrome]';

/**
 * Startup fallback triad bottom position (px) when [data-watch-bottom-chrome]
 * is not yet in DOM during initial mount. Temporary — replaced by measured
 * position on the next RAF once the retry loop finds the bar. Derived from
 * minimum expected playback bar height (~60 px) + 8 px gap.
 *
 * Used on phone AND tablet (both clear the bottom chrome). In practice the
 * bar mounts in the same commit as the canvas (see WatchApp.tsx), so the
 * fallback window is a single frame on every path we exercise — named
 * `…STARTUP_FALLBACK` (not `PHONE_…`) to track that shared use.
 */
const TRIAD_BOTTOM_STARTUP_FALLBACK = 68;

export interface WatchOverlayLayout {
  /** Run layout computation. */
  doLayout(): void;
  /** Disconnect and clean up. */
  destroy(): void;
}

export function createWatchOverlayLayout(renderer: WatchRenderer): WatchOverlayLayout {
  let _destroyed = false;
  // Single coalescing RAF slot — all layout sources (resize, observer, retry) go through this
  let _layoutPending = false;
  let _layoutRafId: number | null = null;
  let _barObserver: ResizeObserver | null = null;
  let _observedBar: HTMLElement | null = null;
  let _barAttached = false;

  function attachObserver(bar: HTMLElement) {
    if (_barObserver) _barObserver.disconnect();
    _barObserver = new ResizeObserver(() => requestLayout());
    _barObserver.observe(bar);
    _observedBar = bar;
    _barAttached = true;
  }

  function detachObserver() {
    if (_barObserver) { _barObserver.disconnect(); _barObserver = null; }
    _observedBar = null;
    _barAttached = false;
  }

  function doLayout() {
    _layoutRafId = null;
    _layoutPending = false;
    if (_destroyed) return;

    const viewportW = window.innerWidth;
    const viewportH = window.innerHeight;
    const mode = getDeviceMode();

    // Mirror lab: set data-device-mode on <html> so watch CSS can use it if needed
    document.documentElement.dataset.deviceMode = mode;

    // Triad sizing — same formulas as lab/js/runtime/overlay-layout.ts:75-80
    let triadSize: number;
    if (mode === 'phone') {
      triadSize = Math.min(140, Math.max(96, Math.floor(viewportW * 0.15)));
    } else {
      triadSize = Math.min(200, Math.max(120, Math.floor(viewportW * 0.10)));
    }

    // Triad bottom positioning — phone + tablet clear the watch's
    // full-width bottom chrome; desktop uses a fixed 12 px offset.
    let triadBottom: number;
    if (mode === 'phone' || mode === 'tablet') {
      const bar = document.querySelector(PLAYBACK_BAR_SELECTOR) as HTMLElement | null;
      if (bar) {
        const barTopFromBottom = viewportH - bar.getBoundingClientRect().top;
        triadBottom = barTopFromBottom + 8;
        if (bar !== _observedBar) attachObserver(bar);
      } else {
        // Bar not yet in DOM — use temporary fallback and schedule retry
        triadBottom = TRIAD_BOTTOM_STARTUP_FALLBACK;
        requestLayout(); // re-enters via coalesced RAF → retries until bar appears
      }
    } else {
      triadBottom = 12;
      if (_barAttached) detachObserver();
    }

    // Left inset — matches lab safe-area handling
    const safeLeft = parseFloat(
      getComputedStyle(document.documentElement).getPropertyValue('--safe-left')
    ) || 0;
    const triadLeft = safeLeft + 6;

    renderer.setOverlayLayout({ triadSize, triadLeft, triadBottom });
  }

  /**
   * Request a coalesced layout on the next RAF. All layout sources (resize,
   * orientationchange, observer, bar retry) go through this single entry point.
   * Matches lab's requestLayout pattern in overlay-layout.ts:105-109.
   */
  function requestLayout() {
    if (_layoutPending || _destroyed) return;
    _layoutPending = true;
    _layoutRafId = requestAnimationFrame(doLayout);
  }

  /**
   * Initial startup: double-RAF to let React mount settle, then run first layout.
   * If the bar is missing in phone mode, doLayout calls requestLayout to retry.
   */
  function scheduleFirstLayout() {
    _layoutRafId = requestAnimationFrame(() => {
      if (_destroyed) return;
      _layoutRafId = requestAnimationFrame(() => {
        if (_destroyed) return;
        doLayout();
      });
    });
  }

  // Resize + orientationchange listeners (matches lab/js/main.ts:287-288)
  window.addEventListener('resize', requestLayout);
  window.addEventListener('orientationchange', requestLayout);
  scheduleFirstLayout();

  return {
    doLayout,
    destroy() {
      _destroyed = true;
      window.removeEventListener('resize', requestLayout);
      window.removeEventListener('orientationchange', requestLayout);
      detachObserver();
      if (_layoutRafId != null) { cancelAnimationFrame(_layoutRafId); _layoutRafId = null; }
      _layoutPending = false;
    },
  };
}
