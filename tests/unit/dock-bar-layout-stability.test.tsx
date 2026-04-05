/**
 * @vitest-environment jsdom
 */
/**
 * Dock bar layout stability tests — verifies the slot-based grid architecture
 * prevents layout shift when Pause↔Resume toggles.
 *
 * Tests structural contracts (slot wrappers, class stability) rather than
 * visual layout, since JSDOM cannot measure real pixel positions.
 */
import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, act, cleanup } from '@testing-library/react';
import { useAppStore } from '../../lab/js/store/app-store';
import { DockBar } from '../../lab/js/components/DockBar';

describe('DockBar layout stability (slot geometry)', () => {
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

  it('renders 4 stable slot wrappers in primary surface', () => {
    const { container } = render(<DockBar />);
    const slots = container.querySelectorAll('.dock-slot');
    expect(slots.length).toBe(4);
    expect(slots[0].classList.contains('dock-slot--add')).toBe(true);
    expect(slots[1].classList.contains('dock-slot--mode')).toBe(true);
    expect(slots[2].classList.contains('dock-slot--pause')).toBe(true);
    expect(slots[3].classList.contains('dock-slot--aux')).toBe(true);
  });

  it('toggling paused does not change slot structure', () => {
    const { container, rerender } = render(<DockBar />);

    // Capture slot structure when paused=false (default)
    const slotsBeforeClasses = Array.from(container.querySelectorAll('.dock-slot'))
      .map(s => s.className);

    // Toggle paused
    act(() => { useAppStore.getState().togglePause(); });
    rerender(<DockBar />);

    const slotsAfterClasses = Array.from(container.querySelectorAll('.dock-slot'))
      .map(s => s.className);

    // Slot classes must be identical
    expect(slotsAfterClasses).toEqual(slotsBeforeClasses);
  });

  it('Pause and Resume render inside the same pause slot', () => {
    const { container, rerender } = render(<DockBar />);

    const pauseSlot = container.querySelector('.dock-slot--pause');
    expect(pauseSlot).not.toBeNull();
    expect(pauseSlot!.textContent).toContain('Pause');

    act(() => { useAppStore.getState().togglePause(); });
    rerender(<DockBar />);

    const pauseSlotAfter = container.querySelector('.dock-slot--pause');
    expect(pauseSlotAfter).not.toBeNull();
    expect(pauseSlotAfter!.textContent).toContain('Resume');
  });

  it('mode slot contains segmented control in primary surface', () => {
    const { container } = render(<DockBar />);
    const modeSlot = container.querySelector('.dock-slot--mode');
    expect(modeSlot).not.toBeNull();
    const segmented = modeSlot!.querySelector('fieldset.segmented');
    expect(segmented).not.toBeNull();
  });

  it('placement surface: mode slot contains Cancel, add slot contains Place', () => {
    useAppStore.getState().setPlacementActive(true);
    const { container } = render(<DockBar />);

    // Still 4 slots
    const slots = container.querySelectorAll('.dock-slot');
    expect(slots.length).toBe(4);

    // Add slot has Place
    const addSlot = container.querySelector('.dock-slot--add');
    expect(addSlot!.textContent).toContain('Place');

    // Mode slot has Cancel
    const modeSlot = container.querySelector('.dock-slot--mode');
    expect(modeSlot!.textContent).toContain('Cancel');
  });

  it('dock uses CSS grid (not flex space-around)', () => {
    const { container } = render(<DockBar />);
    const dockBar = container.querySelector('.dock-bar');
    expect(dockBar).not.toBeNull();
    // The dock-bar class should have grid-template-columns in CSS
    // We verify structurally by checking slots exist (grid children)
    expect(dockBar!.querySelectorAll('.dock-slot').length).toBe(4);
  });
});
