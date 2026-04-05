/**
 * @vitest-environment jsdom
 */
/**
 * Render tests for CameraControls component.
 * After Phase 10 legacy cleanup, CameraControls only renders Free-Look
 * controls. Center/Follow have moved to BondedGroupsPanel.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, cleanup } from '@testing-library/react';
import { useAppStore } from '../../lab/js/store/app-store';
import { CameraControls } from '../../lab/js/components/CameraControls';

describe('CameraControls (Free-Look only after Phase 10)', () => {
  beforeEach(() => {
    useAppStore.getState().resetTransientState();
  });
  afterEach(() => {
    cleanup();
  });

  it('renders nothing when freeLookEnabled is false (default)', () => {
    const { container } = render(<CameraControls />);
    expect(container.innerHTML).toBe('');
  });

  it('no longer renders Center or Follow buttons', () => {
    const { container } = render(<CameraControls />);
    expect(container.querySelector('[aria-label="Center Object"]')).toBeNull();
    expect(container.querySelector('[aria-label="Follow"]')).toBeNull();
  });
});
