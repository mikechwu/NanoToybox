/**
 * useReviewLockedInteraction — shared behavior hook for review-locked controls.
 *
 * Centralizes: hover/focus tooltip show/hide, click/tap activation,
 * keyboard activation (Enter/Space), and status-hint dispatch.
 *
 * Used by ReviewLockedControl (span wrapper) and ReviewLockedListItem (li wrapper).
 */

import { useState, useRef, useCallback, useEffect, useId } from 'react';
import { HINT_DELAY_MS } from '../components/ActionHint';
import { showReviewModeActionHint } from '../runtime/overlay/review-mode-action-hints';

export interface UseReviewLockedInteractionResult {
  tooltipId: string;
  hintVisible: boolean;
  show: () => void;
  hide: () => void;
  handleClick: (e: React.MouseEvent) => void;
  handleKeyDown: (e: React.KeyboardEvent) => void;
}

export function useReviewLockedInteraction(): UseReviewLockedInteractionResult {
  const [hintVisible, setHintVisible] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tooltipId = useId();

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) { clearTimeout(timerRef.current); timerRef.current = null; }
  }, []);

  const show = useCallback(() => {
    clearTimer();
    timerRef.current = setTimeout(() => setHintVisible(true), HINT_DELAY_MS);
  }, [clearTimer]);

  const hide = useCallback(() => { clearTimer(); setHintVisible(false); }, [clearTimer]);

  useEffect(() => clearTimer, [clearTimer]);

  const activate = useCallback(() => { hide(); showReviewModeActionHint(); }, [hide]);

  const handleClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    activate();
  }, [activate]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      activate();
    }
  }, [activate]);

  return { tooltipId, hintVisible, show, hide, handleClick, handleKeyDown };
}
