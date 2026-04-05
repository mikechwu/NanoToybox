/**
 * @vitest-environment jsdom
 */
/**
 * Behavioral tests for DockBar focus-repair on surface transitions.
 *
 * When a surface change removes or disables the focused control, focus
 * should land on the primary action button. Focus outside the dock
 * should never be stolen.
 */
import React from 'react';
import { describe, it, expect, beforeEach } from 'vitest';
import { render, act } from '@testing-library/react';
import { useAppStore } from '../../lab/js/store/app-store';
import { DockBar } from '../../lab/js/components/DockBar';

describe('DockBar focus repair', () => {
  beforeEach(() => {
    useAppStore.getState().resetTransientState();
    // Register minimal dock callbacks to avoid null-ref
    useAppStore.getState().setDockCallbacks({
      onAdd: () => {},
      onPause: () => {},
      onSettings: () => {},
      onCancel: () => {},
      onModeChange: () => {},
    });
  });

  it('renders toolbar with correct role and label', () => {
    const { container } = render(<DockBar />);
    const toolbar = container.querySelector('[role="toolbar"]');
    expect(toolbar).not.toBeNull();
    expect(toolbar!.getAttribute('aria-label')).toBe('Simulation controls');
  });

  it('renders mode segmented in primary surface', () => {
    const { container } = render(<DockBar />);
    const segmented = container.querySelector('fieldset.segmented');
    expect(segmented).not.toBeNull();
  });

  it('removes mode segmented in placement surface', () => {
    useAppStore.getState().setPlacementActive(true);
    const { container } = render(<DockBar />);
    const segmented = container.querySelector('fieldset.segmented');
    expect(segmented).toBeNull();
  });

  it('shows cancel button only in placement surface', () => {
    const { container, rerender } = render(<DockBar />);
    expect(container.querySelector('.dock-cancel')).toBeNull();

    act(() => { useAppStore.getState().setPlacementActive(true); });
    rerender(<DockBar />);
    expect(container.querySelector('.dock-cancel')).not.toBeNull();
  });

  it('disables pause and settings in placement surface', () => {
    useAppStore.getState().setPlacementActive(true);
    const { container } = render(<DockBar />);
    // Pause and Settings are disabled during placement (query by disabled state)
    const disabledBtns = Array.from(container.querySelectorAll('button[disabled]'));
    expect(disabledBtns.length).toBeGreaterThanOrEqual(2);
  });

  it('primary action has Add label in primary surface, Place in placement', () => {
    const { container, rerender } = render(<DockBar />);
    const addBtn = container.querySelector('.dock-add-btn');
    expect(addBtn?.textContent).toContain('Add');

    act(() => { useAppStore.getState().setPlacementActive(true); });
    rerender(<DockBar />);
    expect(addBtn?.textContent).toContain('Place');
  });

  it('repairs focus to primary action when focused dock control is removed by surface change', () => {
    const { container } = render(<DockBar />);
    const toolbar = container.querySelector('[role="toolbar"]') as HTMLElement;

    // Focus a radio inside the mode segmented control (exists in primary surface)
    const radio = toolbar.querySelector('input[type="radio"]') as HTMLElement;
    expect(radio).not.toBeNull();
    act(() => { radio.focus(); });
    expect(document.activeElement).toBe(radio);

    // Trigger placement surface — mode segmented is removed from DOM
    act(() => { useAppStore.getState().setPlacementActive(true); });

    // Focus should have been repaired to the primary action (Add/Place button)
    const primaryBtn = toolbar.querySelector('.dock-add-btn') as HTMLElement;
    expect(document.activeElement).toBe(primaryBtn);
  });

  it('does NOT steal focus when focus is outside the dock during surface change', () => {
    // Create an external element to hold focus
    const external = document.createElement('button');
    external.textContent = 'External';
    document.body.appendChild(external);

    const { container } = render(<DockBar />);

    // Focus the external element (not inside dock)
    act(() => { external.focus(); });
    expect(document.activeElement).toBe(external);

    // Trigger placement surface
    act(() => { useAppStore.getState().setPlacementActive(true); });

    // Focus should NOT have moved to the dock
    expect(document.activeElement).toBe(external);

    document.body.removeChild(external);
  });
});
