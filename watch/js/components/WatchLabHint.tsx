/**
 * WatchLabHint — discovery-runtime-driven coachmark bubble anchored to the
 * Lab-entry control. Controller owns the firing decision (see
 * `watch-lab-discovery.ts`); this component just renders and dismisses.
 *
 * Accessibility (rev 6):
 *   - `role="status"` + `aria-live="polite"` + `aria-atomic="true"`
 *   - Close affordance is a real `<button>` with `aria-label="Dismiss hint"`
 *   - Escape anywhere dismisses, UNLESS focus is inside another menu/dialog/
 *     sheet (capture-phase listener + ancestry check). Prevents hijacking.
 *
 * Placement (rev 6 follow-up P2.1):
 *   - Default: anchored above the trigger, right-aligned (the split-button
 *     lives at the right edge of the toolbar so right-align minimizes
 *     left-edge overflow on desktop).
 *   - Fallback 1 — left-edge clipping: when measurement shows the bubble
 *     would cross the viewport's left edge (e.g. narrow phone, long copy),
 *     switch to `above-left` so the bubble anchors to the trigger's left.
 *   - Fallback 2 — top-edge clipping: when there is no room above (rare —
 *     bottom toolbar should always have clearance, but e.g. rotated phone
 *     keyboard shrinks the viewport), flip to `below` placement.
 *   - Resolver runs once per mount AND on every viewport resize via a
 *     single ResizeObserver on the documentElement. Cheap: one measure
 *     pass, one data-attribute write. CSS owns the visual variants.
 */

import React, { useEffect, useCallback, useRef, useState } from 'react';
import type { WatchLabHintModel } from '../watch-lab-discovery';

interface WatchLabHintProps {
  hint: WatchLabHintModel | null;
  onDismiss: (id: WatchLabHintModel['id']) => void;
}

const INTERACTIVE_ANCESTOR_SELECTOR = '[role="menu"], [role="dialog"], [role="listbox"], .sheet';

type HintPlacement = 'above-right' | 'above-left' | 'below';

interface Viewport {
  width: number;
  height: number;
}

function readViewport(): Viewport {
  if (typeof window === 'undefined') return { width: 0, height: 0 };
  return {
    width: Math.max(0, window.innerWidth || document.documentElement.clientWidth || 0),
    height: Math.max(0, window.innerHeight || document.documentElement.clientHeight || 0),
  };
}

/** Pure resolver — exported for unit tests. Given the anchor (the
 *  Lab-entry control's) rect and the bubble's measured size plus a
 *  viewport, decides the best placement. */
export function resolveHintPlacement(args: {
  anchorRect: { left: number; right: number; top: number; bottom: number } | null;
  bubbleSize: { width: number; height: number };
  viewport: Viewport;
}): HintPlacement {
  const { anchorRect, bubbleSize, viewport } = args;
  if (!anchorRect || viewport.width <= 0 || viewport.height <= 0) return 'above-right';
  // Degenerate anchor — all-zero rect means layout has not resolved
  // (common on initial mount in JSDOM, also possible pre-paint in
  // real browsers). Fall back to the default placement rather than
  // switching to `below`, which would misread the situation as
  // "no room above."
  const degenerate = anchorRect.left === 0 && anchorRect.right === 0
    && anchorRect.top === 0 && anchorRect.bottom === 0;
  if (degenerate) return 'above-right';
  const margin = 8;
  // Vertical: is there room above the anchor for the bubble?
  const spaceAbove = anchorRect.top;
  if (spaceAbove < bubbleSize.height + margin) return 'below';
  // Default right-aligned position puts the bubble's right edge at the
  // anchor's right edge; if that overflows the viewport's left side,
  // flip to left-aligned (bubble's left edge at anchor's left edge).
  const defaultLeft = anchorRect.right - bubbleSize.width;
  if (defaultLeft < margin) return 'above-left';
  return 'above-right';
}

export function WatchLabHint({ hint, onDismiss }: WatchLabHintProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [placement, setPlacement] = useState<HintPlacement>('above-right');

  const dismiss = useCallback(() => {
    if (hint) onDismiss(hint.id);
  }, [hint, onDismiss]);

  // Global Escape — capture-phase, ancestry-checked.
  useEffect(() => {
    if (!hint) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== 'Escape') return;
      const target = e.target as Element | null;
      if (target?.closest?.(INTERACTIVE_ANCESTOR_SELECTOR)) return;
      dismiss();
    }
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [hint, dismiss]);

  // Placement resolver — measure on mount AND on viewport resize.
  useEffect(() => {
    if (!hint) return;
    function measure() {
      const root = rootRef.current;
      if (!root) return;
      // Anchor = the parent `.watch-lab-entry-anchor` that hosts both the
      // split-button and this hint. If it is not present we fall back to
      // the default placement silently.
      const anchorEl = root.parentElement;
      const anchorRect = anchorEl ? anchorEl.getBoundingClientRect() : null;
      const bubbleRect = root.getBoundingClientRect();
      const next = resolveHintPlacement({
        anchorRect,
        bubbleSize: { width: bubbleRect.width, height: bubbleRect.height },
        viewport: readViewport(),
      });
      setPlacement((prev) => (prev === next ? prev : next));
    }
    measure();
    let ro: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(() => measure());
      ro.observe(document.documentElement);
    }
    window.addEventListener('resize', measure);
    return () => {
      if (ro) ro.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [hint]);

  if (!hint) return null;

  return (
    <div
      ref={rootRef}
      className="watch-lab-hint"
      role="status"
      aria-live="polite"
      aria-atomic="true"
      data-trigger={hint.id}
      data-placement={placement}
    >
      <div className="watch-lab-hint__band" aria-hidden="true" />
      <div className="watch-lab-hint__message">{hint.message}</div>
      <button
        type="button"
        className="watch-lab-hint__close"
        aria-label="Dismiss hint"
        onClick={dismiss}
      >
        <span aria-hidden="true">×</span>
      </button>
    </div>
  );
}
