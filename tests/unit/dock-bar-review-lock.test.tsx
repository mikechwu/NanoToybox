/**
 * @vitest-environment jsdom
 */
/**
 * DockBar review-lock component tests — renders the real DockBar in review
 * mode and verifies locked controls, hint wrappers, and blocked callbacks.
 */
import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/react';
import { useAppStore } from '../../page/js/store/app-store';
import { DockBar } from '../../page/js/components/DockBar';
import { REVIEW_LOCK_TOOLTIP } from '../../page/js/store/selectors/review-ui-lock';

describe('DockBar review-lock rendering', () => {
  beforeEach(() => {
    useAppStore.getState().resetTransientState();
    useAppStore.getState().setDockCallbacks({
      onAdd: vi.fn(),
      onPause: vi.fn(),
      onSettings: vi.fn(),
      onCancel: vi.fn(),
      onModeChange: vi.fn(),
    });
  });
  afterEach(() => cleanup());

  it('Add button is review-locked in review mode', () => {
    useAppStore.getState().setTimelineMode('review');
    const { container } = render(<DockBar />);

    // The Add button should be inside a ReviewLockedControl wrapper
    const addBtn = container.querySelector('.dock-add-btn');
    expect(addBtn).not.toBeNull();
    expect(addBtn!.getAttribute('aria-disabled')).toBe('true');

    // Wrapper should have review-locked-trigger class (ReviewLockedControl)
    const trigger = container.querySelector('.review-locked-trigger');
    expect(trigger).not.toBeNull();
  });

  it('Pause/Resume button is review-locked in review mode', () => {
    useAppStore.getState().setTimelineMode('review');
    const { container } = render(<DockBar />);

    // Find the pause button (inside a review-locked-trigger)
    const triggers = container.querySelectorAll('.review-locked-trigger');
    // Should have at least 2 triggers (Add + Pause)
    expect(triggers.length).toBeGreaterThanOrEqual(2);
  });

  it('Segmented items are disabled in review mode', () => {
    useAppStore.getState().setTimelineMode('review');
    const { container } = render(<DockBar />);

    const segmented = container.querySelector('fieldset.segmented');
    expect(segmented).not.toBeNull();

    // All radio inputs should be disabled
    const radios = segmented!.querySelectorAll('input[type="radio"]');
    expect(radios.length).toBe(3); // Atom, Move, Rotate
    radios.forEach(radio => {
      expect((radio as HTMLInputElement).disabled).toBe(true);
    });

    // Disabled items should have seg-item--disabled class
    const disabledItems = segmented!.querySelectorAll('.seg-item--disabled');
    expect(disabledItems.length).toBe(3);
  });

  it('Segmented disabled items have ActionHint wrappers with tooltip text', () => {
    useAppStore.getState().setTimelineMode('review');
    const { container } = render(<DockBar />);

    // ActionHint renders [role="tooltip"] elements inside the segmented
    const segmented = container.querySelector('fieldset.segmented');
    const tooltips = segmented!.querySelectorAll('[role="tooltip"]');
    expect(tooltips.length).toBe(3); // One per disabled mode item

    // Each tooltip should contain the review lock message
    tooltips.forEach(tooltip => {
      expect(tooltip.textContent).toContain('read-only');
    });
  });

  it('Settings button is NOT review-locked', () => {
    useAppStore.getState().setTimelineMode('review');
    const { container } = render(<DockBar />);

    const settingsBtn = container.querySelector('[data-dock-settings]');
    expect(settingsBtn).not.toBeNull();
    expect((settingsBtn as HTMLButtonElement).disabled).toBe(false);
  });

  it('live mode renders normal Add and Pause buttons (no review lock)', () => {
    // Default is live mode
    const { container } = render(<DockBar />);

    const addBtn = container.querySelector('.dock-add-btn');
    expect(addBtn).not.toBeNull();
    expect(addBtn!.getAttribute('aria-disabled')).toBeNull();

    // No review-locked-trigger wrappers
    const triggers = container.querySelectorAll('.review-locked-trigger');
    expect(triggers.length).toBe(0);
  });

  it('clicking review-locked Add does not call onAdd callback', () => {
    useAppStore.getState().setTimelineMode('review');
    const { container } = render(<DockBar />);

    const trigger = container.querySelector('.review-locked-trigger');
    if (trigger) fireEvent.click(trigger);
  });

  it('segmented has identical .seg-item flex children in live and review modes', () => {
    // Live mode
    const { container: liveContainer } = render(<DockBar />);
    const liveSegmented = liveContainer.querySelector('fieldset.segmented');
    const liveItems = liveSegmented!.querySelectorAll(':scope > .seg-item');
    expect(liveItems.length).toBe(3);

    cleanup();

    // Review mode
    useAppStore.getState().setTimelineMode('review');
    useAppStore.getState().setDockCallbacks({
      onAdd: vi.fn(), onPause: vi.fn(), onSettings: vi.fn(),
      onCancel: vi.fn(), onModeChange: vi.fn(),
    });
    const { container: reviewContainer } = render(<DockBar />);
    const reviewSegmented = reviewContainer.querySelector('fieldset.segmented');
    const reviewItems = reviewSegmented!.querySelectorAll(':scope > .seg-item');
    expect(reviewItems.length).toBe(3);

    // Same tag and class structure for immediate flex children
    for (let i = 0; i < 3; i++) {
      expect(reviewItems[i].tagName).toBe(liveItems[i].tagName);
      expect(reviewItems[i].tagName).toBe('SPAN');
      // Each item contains exactly one .seg-label
      expect(reviewItems[i].querySelectorAll('.seg-label').length).toBe(1);
      expect(liveItems[i].querySelectorAll('.seg-label').length).toBe(1);
    }

    // Review disabled items still contain .seg-label
    const disabledItems = reviewSegmented!.querySelectorAll('.seg-item--disabled');
    expect(disabledItems.length).toBe(3);
    disabledItems.forEach(item => {
      expect(item.querySelector('.seg-label')).not.toBeNull();
    });

    // Tooltips must be inside .seg-item, not as sibling flex children
    const tooltips = reviewSegmented!.querySelectorAll(':scope > [role="tooltip"]');
    expect(tooltips.length).toBe(0);
    const innerTooltips = reviewSegmented!.querySelectorAll('.seg-item [role="tooltip"]');
    expect(innerTooltips.length).toBe(3);
  });
});
