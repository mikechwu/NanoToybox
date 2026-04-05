/**
 * @vitest-environment jsdom
 */
/**
 * StructureChooser review-lock component tests — renders the real chooser
 * in review mode and verifies locked rows and hint wrappers.
 */
import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/react';
import { useAppStore } from '../../lab/js/store/app-store';
import { StructureChooser } from '../../lab/js/components/StructureChooser';
import { REVIEW_LOCK_STATUS } from '../../lab/js/store/selectors/review-ui-lock';

describe('StructureChooser review-lock rendering', () => {
  beforeEach(() => {
    useAppStore.getState().resetTransientState();
    useAppStore.getState().openSheet('chooser');
    useAppStore.getState().setAvailableStructures([
      { key: 'c60', file: 'c60.xyz', description: 'C60 Fullerene', atomCount: 60 },
      { key: 'cnt', file: 'cnt.xyz', description: 'Carbon Nanotube', atomCount: 200 },
    ]);
    useAppStore.getState().setChooserCallbacks({
      onSelectStructure: vi.fn(),
    });
    useAppStore.getState().setCloseOverlay(vi.fn());
  });
  afterEach(() => cleanup());

  it('chooser rows get review-locked wrapper in review mode', () => {
    useAppStore.getState().setTimelineMode('review');
    const { container } = render(<StructureChooser />);

    // Rows should be inside review-locked-trigger wrappers
    const triggers = container.querySelectorAll('.review-locked-trigger');
    expect(triggers.length).toBe(2); // 2 structure rows

    // Rows should have review-locked class
    const lockedRows = container.querySelectorAll('.drawer-item.review-locked');
    expect(lockedRows.length).toBe(2);
  });

  it('chooser rows have ActionHint tooltips in review mode', () => {
    useAppStore.getState().setTimelineMode('review');
    const { container } = render(<StructureChooser />);

    const tooltips = container.querySelectorAll('[role="tooltip"]');
    expect(tooltips.length).toBeGreaterThanOrEqual(2);
  });

  it('clicking a locked chooser row shows status hint, does not call onSelectStructure', () => {
    useAppStore.getState().setTimelineMode('review');
    const { container } = render(<StructureChooser />);

    // Click the first review-locked-trigger wrapper
    const trigger = container.querySelector('.review-locked-trigger');
    if (trigger) fireEvent.click(trigger);

    // Status hint should be shown
    expect(useAppStore.getState().statusText).toBe(REVIEW_LOCK_STATUS);

    // onSelectStructure should NOT have been called
    const callbacks = useAppStore.getState().chooserCallbacks;
    expect(callbacks!.onSelectStructure).not.toHaveBeenCalled();
  });

  it('live mode renders normal clickable rows (no review wrappers)', () => {
    // Default is live mode
    const { container } = render(<StructureChooser />);

    const triggers = container.querySelectorAll('.review-locked-trigger');
    expect(triggers.length).toBe(0);

    const rows = container.querySelectorAll('.drawer-item');
    expect(rows.length).toBe(2);
    // Rows should not have review-locked class
    rows.forEach(row => {
      expect(row.classList.contains('review-locked')).toBe(false);
    });
  });
});
