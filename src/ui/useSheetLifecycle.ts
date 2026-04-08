/**
 * Shared sheet lifecycle hook — mounted/animating state machine for bottom/side sheets.
 *
 * Consolidated from lab/js/hooks/useSheetAnimation.ts. Used by both lab and watch.
 *
 * Open: mount → force reflow → add .open class (CSS transition triggers)
 * Close: remove .open → wait for transitionend → unmount
 * Reduced motion: unmount immediately if transition duration is 0
 * Escape: calls onClose when mounted
 */

import { useRef, useEffect, useState, useCallback } from 'react';

export interface SheetLifecycle {
  ref: React.RefObject<HTMLElement>;
  mounted: boolean;
  animating: boolean;
  onTransitionEnd: () => void;
}

export function useSheetLifecycle(isOpen: boolean, onClose?: () => void): SheetLifecycle {
  const ref = useRef<HTMLElement>(null);
  const [mounted, setMounted] = useState(false);
  const [animating, setAnimating] = useState(false);

  // Open/close state transitions
  useEffect(() => {
    if (isOpen) {
      setMounted(true);
    } else if (mounted) {
      setAnimating(false);
    }
  }, [isOpen]); // eslint-disable-line react-hooks/exhaustive-deps

  // After mounting, force reflow then animate open
  useEffect(() => {
    if (mounted && isOpen && !animating) {
      const el = ref.current;
      if (!el) { setAnimating(true); return; }
      // Synchronous reflow — forces browser to compute layout before transition
      el.offsetHeight; // eslint-disable-line no-unused-expressions
      setAnimating(true);
    }
  }, [mounted, isOpen, animating]);

  // Transition end → unmount on close
  const onTransitionEnd = useCallback(() => {
    if (!isOpen) setMounted(false);
  }, [isOpen]);

  // Reduced motion: skip transition, unmount immediately
  useEffect(() => {
    if (!isOpen && mounted) {
      const el = ref.current;
      if (!el) { setMounted(false); return; }
      const duration = parseFloat(getComputedStyle(el).transitionDuration);
      if (duration === 0) setMounted(false);
    }
  }, [isOpen, mounted]);

  // Escape to close (optional — only if onClose provided)
  useEffect(() => {
    if (!mounted || !onClose) return;
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [mounted, onClose]);

  return { ref, mounted, animating, onTransitionEnd };
}
