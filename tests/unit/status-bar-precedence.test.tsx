/**
 * @vitest-environment jsdom
 */
/**
 * Unit tests for StatusBar render precedence.
 *
 * Renders the actual <StatusBar /> component and asserts on rendered
 * .status-text content after store mutations. Validates the shipped JSX,
 * not a mirrored copy of its logic.
 *
 * Precedence: statusError > statusText > normal scene summary.
 */
import React from 'react';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { useAppStore } from '../../page/js/store/app-store';
import { StatusBar } from '../../page/js/components/StatusBar';

/** Helper: render StatusBar, return the .status-text content. */
function renderAndGetText(): string {
  const { container } = render(<StatusBar />);
  const el = container.querySelector('.status-text');
  return el?.textContent ?? '';
}

// StatusBar currently returns null (info block disabled). Tests skipped until re-enabled.
describe.skip('StatusBar render precedence', () => {
  beforeEach(() => {
    useAppStore.getState().resetTransientState();
  });

  afterEach(() => {
    cleanup();
  });

  it('shows scene summary when no status text or error', () => {
    useAppStore.getState().updateAtomCount(60);
    useAppStore.getState().setMolecules([
      { id: 1, name: 'C60', structureFile: 'c60.xyz', atomCount: 60, atomOffset: 0 },
    ]);
    expect(renderAndGetText()).toBe('60 atoms');
  });

  it('shows empty playground when no molecules', () => {
    expect(renderAndGetText()).toBe('Empty playground \u2014 add a molecule');
  });

  it('statusText takes precedence over scene summary', () => {
    useAppStore.getState().updateAtomCount(60);
    useAppStore.getState().setMolecules([
      { id: 1, name: 'C60', structureFile: 'c60.xyz', atomCount: 60, atomOffset: 0 },
    ]);
    useAppStore.getState().setStatusText('Loading...');
    expect(renderAndGetText()).toBe('Loading...');
  });

  it('statusError takes precedence over statusText', () => {
    useAppStore.getState().setStatusText('Loading...');
    useAppStore.getState().setStatusError('Failed to load structures.');
    expect(renderAndGetText()).toBe('Failed to load structures.');
  });

  it('statusError takes precedence over scene summary', () => {
    useAppStore.getState().updateAtomCount(60);
    useAppStore.getState().setMolecules([
      { id: 1, name: 'C60', structureFile: 'c60.xyz', atomCount: 60, atomOffset: 0 },
    ]);
    useAppStore.getState().setStatusError('Failed to load structures.');
    expect(renderAndGetText()).toBe('Failed to load structures.');
  });

  it('clearing statusError restores statusText visibility', () => {
    useAppStore.getState().setStatusText('Placing...');
    useAppStore.getState().setStatusError('Network error');
    expect(renderAndGetText()).toBe('Network error');

    cleanup();
    useAppStore.getState().setStatusError(null);
    expect(renderAndGetText()).toBe('Placing...');
  });

  it('clearing statusText restores scene summary', () => {
    useAppStore.getState().updateAtomCount(60);
    useAppStore.getState().setMolecules([
      { id: 1, name: 'C60', structureFile: 'c60.xyz', atomCount: 60, atomOffset: 0 },
    ]);
    useAppStore.getState().setStatusText('Loading...');
    expect(renderAndGetText()).toBe('Loading...');

    cleanup();
    useAppStore.getState().setStatusText(null);
    expect(renderAndGetText()).toBe('60 atoms');
  });

  it('resetTransientState clears both channels', () => {
    useAppStore.getState().setStatusText('Loading...');
    useAppStore.getState().setStatusError('Error');
    useAppStore.getState().resetTransientState();
    expect(renderAndGetText()).toBe('Empty playground \u2014 add a molecule');
  });

  it('shows plural molecule label for multiple molecules', () => {
    useAppStore.getState().updateAtomCount(120);
    useAppStore.getState().setMolecules([
      { id: 1, name: 'C60', structureFile: 'c60.xyz', atomCount: 60, atomOffset: 0 },
      { id: 2, name: 'C60', structureFile: 'c60.xyz', atomCount: 60, atomOffset: 60 },
    ]);
    expect(renderAndGetText()).toBe('2 molecules \u00b7 120 atoms');
  });

  it('renders reconciliation state when active', () => {
    useAppStore.getState().updateAtomCount(60);
    useAppStore.getState().setMolecules([
      { id: 1, name: 'C60', structureFile: 'c60.xyz', atomCount: 60, atomOffset: 0 },
    ]);
    useAppStore.getState().setReconciliationState('awaiting_positions');
    const { container } = render(<StatusBar />);
    const reconcEl = container.querySelector('.reconciliation-text');
    expect(reconcEl).not.toBeNull();
    expect(reconcEl?.textContent).toBe('Reconciling: positions');
  });

  it('hides reconciliation state when none', () => {
    useAppStore.getState().setReconciliationState('none');
    const { container } = render(<StatusBar />);
    const reconcEl = container.querySelector('.reconciliation-text');
    expect(reconcEl).toBeNull();
  });
});
