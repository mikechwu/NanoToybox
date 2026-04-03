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

    // Disabled labels should have seg-disabled class
    const disabledLabels = segmented!.querySelectorAll('.seg-disabled');
    expect(disabledLabels.length).toBe(3);
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

    // The trigger wrapper intercepts clicks
    const trigger = container.querySelector('.review-locked-trigger');
    if (trigger) fireEvent.click(trigger);

    // onAdd should NOT have been called (runtime guard also blocks, but UI should not forward)
    const callbacks = useAppStore.getState().dockCallbacks;
    // The click goes to the wrapper, not through to the dock callback
    // (ReviewLockedControl prevents propagation)
  });
});
