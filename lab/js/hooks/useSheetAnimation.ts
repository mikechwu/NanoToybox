/**
 * useSheetAnimation — custom hook for sheet open/close CSS transitions.
 *
 * Preserves the exact animation contract from the imperative OverlayController:
 * - Open: add 'sheet-visible' → trigger reflow → add 'open'
 * - Close: remove 'open' → wait for transitionend → remove 'sheet-visible'
 * - Reduced motion: skip transition, apply classes immediately
 *
 * Returns a ref to attach to the sheet element and a 'mounted' flag
 * indicating whether the sheet should be in the DOM.
 */

import { useRef, useEffect, useState, useCallback } from 'react';

export function useSheetAnimation(isOpen: boolean) {
  const ref = useRef<HTMLElement>(null);
  // 'mounted' means the element is in the layout (sheet-visible applied)
  const [mounted, setMounted] = useState(false);
  // 'animating' tracks the open class for CSS transition
  const [animating, setAnimating] = useState(false);

  useEffect(() => {
    if (isOpen) {
      // Opening: mount first, then animate open after reflow
      setMounted(true);
    } else if (mounted) {
      // Closing: remove open class, wait for transition, then unmount
      setAnimating(false);
    }
  }, [isOpen]); // eslint-disable-line react-hooks/exhaustive-deps

  // After mounting, trigger reflow then add open class
  useEffect(() => {
    if (mounted && isOpen && !animating) {
      const el = ref.current;
      if (!el) { setAnimating(true); return; }

      // Reflow trick — forces the browser to compute layout before transition starts
      el.offsetHeight; // eslint-disable-line no-unused-expressions
      setAnimating(true);
    }
  }, [mounted, isOpen, animating]);

  // Handle transitionend for close cleanup
  const onTransitionEnd = useCallback(() => {
    if (!isOpen) {
      setMounted(false);
    }
  }, [isOpen]);

  // Reduced motion: skip transition entirely
  useEffect(() => {
    if (!isOpen && mounted) {
      const el = ref.current;
      if (!el) { setMounted(false); return; }
      const duration = parseFloat(getComputedStyle(el).transitionDuration);
      if (duration === 0) {
        setMounted(false);
      }
    }
  }, [isOpen, mounted]);

  return { ref, mounted, animating, onTransitionEnd };
}
