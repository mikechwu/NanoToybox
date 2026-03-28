/**
 * @vitest-environment jsdom
 */
/**
 * Render tests for CameraControls component.
 * Verifies the ⊕ button carries the iOS long-press suppression class
 * and onContextMenu guard.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, cleanup } from '@testing-library/react';
import { useAppStore } from '../../page/js/store/app-store';
import { CameraControls } from '../../page/js/components/CameraControls';

describe('CameraControls ⊕ button rendering', () => {
  beforeEach(() => {
    useAppStore.getState().resetTransientState();
  });
  afterEach(() => {
    cleanup();
  });

  it('Orbit center button has camera-action-center class', () => {
    const { getByLabelText } = render(<CameraControls />);
    const btn = getByLabelText('Center Object (long-press to follow)');
    expect(btn.classList.contains('camera-action-center')).toBe(true);
    expect(btn.classList.contains('camera-action')).toBe(true);
  });

  it('contextmenu on center button is prevented (iOS long-press guard)', () => {
    const { getByLabelText } = render(<CameraControls />);
    const btn = getByLabelText('Center Object (long-press to follow)');
    const event = new Event('contextmenu', { bubbles: true, cancelable: true });
    btn.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });
});
