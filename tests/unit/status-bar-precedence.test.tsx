/**
 * @vitest-environment jsdom
 */
/**
 * Unit tests for StatusBar render precedence.
 *
 * StatusBar is a message-only surface:
 * - statusError takes precedence over statusText
 * - null when neither is set (no persistent scene summary)
 */
import React from 'react';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { useAppStore } from '../../page/js/store/app-store';
import { StatusBar } from '../../page/js/components/StatusBar';

function renderAndGetText(): string {
  const { container } = render(<StatusBar />);
  const el = container.querySelector('.status-text');
  return el?.textContent ?? '';
}

describe('StatusBar render precedence', () => {
  beforeEach(() => {
    useAppStore.getState().resetTransientState();
  });

  afterEach(() => {
    cleanup();
  });

  it('returns null when no status text or error', () => {
    const { container } = render(<StatusBar />);
    expect(container.querySelector('.react-info')).toBeNull();
  });

  it('returns null even when atoms exist (no scene summary)', () => {
    useAppStore.getState().updateAtomCount(60);
    useAppStore.getState().setMolecules([
      { id: 1, name: 'C60', structureFile: 'c60.xyz', atomCount: 60, atomOffset: 0 },
    ]);
    const { container } = render(<StatusBar />);
    expect(container.querySelector('.react-info')).toBeNull();
  });

  it('shows statusText when set', () => {
    useAppStore.getState().setStatusText('Loading...');
    expect(renderAndGetText()).toBe('Loading...');
  });

  it('shows statusError when set', () => {
    useAppStore.getState().setStatusError('Failed to load structures.');
    expect(renderAndGetText()).toBe('Failed to load structures.');
  });

  it('statusError takes precedence over statusText', () => {
    useAppStore.getState().setStatusText('Loading...');
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

  it('clearing statusText returns null', () => {
    useAppStore.getState().setStatusText('Loading...');
    expect(renderAndGetText()).toBe('Loading...');

    cleanup();
    useAppStore.getState().setStatusText(null);
    const { container } = render(<StatusBar />);
    expect(container.querySelector('.react-info')).toBeNull();
  });

  it('resetTransientState clears both channels', () => {
    useAppStore.getState().setStatusText('Loading...');
    useAppStore.getState().setStatusError('Error');
    useAppStore.getState().resetTransientState();
    const { container } = render(<StatusBar />);
    expect(container.querySelector('.react-info')).toBeNull();
  });
});
