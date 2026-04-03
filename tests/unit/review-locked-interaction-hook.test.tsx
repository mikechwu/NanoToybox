/**
 * @vitest-environment jsdom
 */
/**
 * useReviewLockedInteraction hook tests — validates the shared behavior
 * seam for review-locked controls (tooltip timing, activation, keyboard).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, fireEvent, act, cleanup } from '@testing-library/react';
import { useAppStore } from '../../page/js/store/app-store';
import { useReviewLockedInteraction } from '../../page/js/hooks/useReviewLockedInteraction';
import { REVIEW_LOCK_STATUS } from '../../page/js/store/selectors/review-ui-lock';

/** Minimal harness component that exposes the hook's handlers on a button. */
function HookHarness() {
  const { tooltipId, hintVisible, show, hide, handleClick, handleKeyDown } = useReviewLockedInteraction();
  return (
    <div>
      <button
        data-testid="target"
        onClick={handleClick}
        onKeyDown={handleKeyDown}
        onMouseEnter={show}
        onMouseLeave={hide}
        onFocus={show}
        onBlur={hide}
      >
        Test
      </button>
      <span data-testid="tooltip" data-visible={hintVisible} id={tooltipId}>
        Tooltip
      </span>
    </div>
  );
}

describe('useReviewLockedInteraction', () => {
  beforeEach(() => {
    useAppStore.getState().resetTransientState();
    vi.useFakeTimers();
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('handleClick prevents default and triggers status hint', () => {
    const { getByTestId } = render(<HookHarness />);
    const btn = getByTestId('target');

    fireEvent.click(btn);

    // Status text should be set to the full review status message
    expect(useAppStore.getState().statusText).toBe(REVIEW_LOCK_STATUS);
  });

  it('Enter key triggers status hint', () => {
    const { getByTestId } = render(<HookHarness />);
    const btn = getByTestId('target');

    fireEvent.keyDown(btn, { key: 'Enter' });

    expect(useAppStore.getState().statusText).toBe(REVIEW_LOCK_STATUS);
  });

  it('Space key triggers status hint', () => {
    const { getByTestId } = render(<HookHarness />);
    const btn = getByTestId('target');

    fireEvent.keyDown(btn, { key: ' ' });

    expect(useAppStore.getState().statusText).toBe(REVIEW_LOCK_STATUS);
  });

  it('show() reveals tooltip after delay, hide() cancels it', () => {
    const { getByTestId } = render(<HookHarness />);
    const btn = getByTestId('target');
    const tooltip = getByTestId('tooltip');

    // Initially not visible
    expect(tooltip.dataset.visible).toBe('false');

    // Hover starts the delay
    fireEvent.mouseEnter(btn);
    expect(tooltip.dataset.visible).toBe('false'); // not yet

    // Advance past delay
    act(() => { vi.advanceTimersByTime(150); });
    expect(tooltip.dataset.visible).toBe('true');

    // Leave hides immediately
    fireEvent.mouseLeave(btn);
    expect(tooltip.dataset.visible).toBe('false');
  });
});
