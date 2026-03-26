/**
 * Overlay layout runtime — owns hint clearance + triad sizing/positioning.
 *
 * Reads dock geometry via [data-dock-root] and computes layout outputs for
 * the renderer. Owns: RAF coalescing state, ResizeObserver, double-RAF
 * first-layout, and glass-UI activation flag.
 *
 * Layout contract: measures [data-dock-root] (the outermost dock container).
 * All dock child surfaces must be in normal flow so getBoundingClientRect()
 * reflects the total bottom-control footprint. See DockLayout.tsx guardrails.
 *
 * Does NOT attach window/document listeners — main.ts wires onViewportResize()
 * via addGlobalListener() to preserve centralized teardown.
 */

/** Single source of truth for the dock measurement root selector. */
const DOCK_ROOT_SELECTOR = '[data-dock-root]';

export interface OverlayLayout {
  /** Run layout computation. No-op if dock not yet in DOM. */
  doLayout(): void;
  /** Schedule a coalesced layout on next RAF. */
  requestLayout(): void;
  /** Callback for main.ts to wire via addGlobalListener(window, 'resize', ...). */
  onViewportResize(): void;
  /** Wire ResizeObserver to the given dock element. Module owns the observer. */
  attachToDock(dockEl: HTMLElement): void;
  /** Schedule first layout via double-RAF; attach to dock when confirmed. */
  scheduleFirstLayout(): void;
  /** Returns true once React dock is confirmed in DOM. */
  isGlassActive(): boolean;
  /** Disconnect observer, cancel pending RAF, reset all state. */
  destroy(): void;
}

export function createOverlayLayout(renderer: {
  setOverlayLayout: (opts: { triadSize: number; triadLeft: number; triadBottom: number }) => void;
} | null): OverlayLayout {
  let _layoutPending = false;
  let _layoutRafId: number | null = null;
  let _attachRafId: number | null = null;
  let _destroyed = false;
  let _dockResizeObserver: ResizeObserver | null = null;
  let _glassUiActive = false;

  function doLayout() {
    _layoutRafId = null;
    _layoutPending = false;
    if (!renderer) return;
    const dockEl = document.querySelector(DOCK_ROOT_SELECTOR) as HTMLElement;
    if (!dockEl) return;
    const dockRect = dockEl.getBoundingClientRect();
    const viewportH = window.innerHeight;
    const viewportW = window.innerWidth;
    const dockTopFromBottom = viewportH - dockRect.top;
    const mode = document.documentElement.dataset.deviceMode;

    // Hint clearance
    const hintGap = 12;
    document.documentElement.style.setProperty(
      '--hint-bottom', (dockTopFromBottom + hintGap) + 'px'
    );

    // Triad sizing — larger on touch devices for use as primary camera orbit control
    let triadSize;
    if (mode === 'phone') {
      triadSize = Math.min(140, Math.max(96, Math.floor(viewportW * 0.15)));
    } else {
      triadSize = Math.min(200, Math.max(120, Math.floor(viewportW * 0.10)));
    }

    // Triad positioning
    let triadBottom;
    if (mode === 'phone') {
      triadBottom = dockTopFromBottom + 8;
    } else {
      triadBottom = 12;
    }

    const safeLeft = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--safe-left')) || 0;
    const triadLeft = safeLeft + 6;

    renderer.setOverlayLayout({ triadSize, triadLeft, triadBottom });

    // Camera controls positioning (above the triad, between triad and scene)
    // triadBottom is CSS-bottom-based. Controls sit above the triad.
    const camCtrlBottom = triadBottom + triadSize + 4; // 4px gap above triad
    const camCtrlLeft = triadLeft;
    document.documentElement.style.setProperty('--cam-ctrl-bottom', camCtrlBottom + 'px');
    document.documentElement.style.setProperty('--cam-ctrl-left', camCtrlLeft + 'px');
  }

  function requestLayout() {
    if (_layoutPending) return;
    _layoutPending = true;
    _layoutRafId = requestAnimationFrame(doLayout);
  }

  function attachToDock(dockEl: HTMLElement) {
    if (_dockResizeObserver) _dockResizeObserver.disconnect();
    _dockResizeObserver = new ResizeObserver(() => requestLayout());
    _dockResizeObserver.observe(dockEl);
  }

  function scheduleFirstLayout() {
    // Retry until React dock region is in the DOM, then attach and activate.
    // Typically resolves in 1-2 RAFs; retries handle slow devices / StrictMode.
    function tryAttach() {
      if (_destroyed) return;
      doLayout();
      const reactDock = document.querySelector(DOCK_ROOT_SELECTOR) as HTMLElement;
      if (reactDock) {
        _attachRafId = null;
        attachToDock(reactDock);
        _glassUiActive = true;
      } else {
        _attachRafId = requestAnimationFrame(tryAttach);
      }
    }
    _attachRafId = requestAnimationFrame(() => {
      if (_destroyed) return;
      _attachRafId = requestAnimationFrame(() => {
        tryAttach();
      });
    });
  }

  return {
    doLayout,
    requestLayout,
    onViewportResize: requestLayout,
    attachToDock,
    scheduleFirstLayout,
    isGlassActive: () => _glassUiActive,
    destroy() {
      _destroyed = true;
      if (_dockResizeObserver) { _dockResizeObserver.disconnect(); _dockResizeObserver = null; }
      if (_layoutRafId) { cancelAnimationFrame(_layoutRafId); _layoutRafId = null; }
      if (_attachRafId) { cancelAnimationFrame(_attachRafId); _attachRafId = null; }
      _layoutPending = false;
      _glassUiActive = false;
    },
  };
}
