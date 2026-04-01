/**
 * @vitest-environment jsdom
 */
/**
 * Render tests for CameraControls component (Object View panel).
 * Verifies Center and Follow buttons render correctly.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React from 'react';
import { render, cleanup, fireEvent } from '@testing-library/react';
import { useAppStore } from '../../page/js/store/app-store';
import { CameraControls } from '../../page/js/components/CameraControls';

describe('CameraControls Object View rendering', () => {
  beforeEach(() => {
    useAppStore.getState().resetTransientState();
  });
  afterEach(() => {
    cleanup();
  });

  it('renders Center button in orbit mode', () => {
    const { getByLabelText } = render(<CameraControls />);
    const btn = getByLabelText('Center Object');
    expect(btn.classList.contains('camera-action')).toBe(true);
    expect(btn.textContent).toContain('Center');
  });

  it('renders Follow button in orbit mode', () => {
    const { getByLabelText } = render(<CameraControls />);
    const btn = getByLabelText('Follow');
    expect(btn.classList.contains('camera-action')).toBe(true);
    expect(btn.textContent).toContain('Follow');
  });

  it('Follow button shows active state when follow enabled', () => {
    useAppStore.getState().setOrbitFollowEnabled(true);
    const { getByLabelText } = render(<CameraControls />);
    const btn = getByLabelText('Following target (tap to stop)');
    expect(btn.classList.contains('camera-action-active')).toBe(true);
    expect(btn.textContent).toContain('Follow');
  });

  it('no Orbit label in default UI', () => {
    const { container } = render(<CameraControls />);
    const allText = container.textContent;
    expect(allText).not.toContain('Orbit');
  });

  it('no ? help button in default UI', () => {
    const { container } = render(<CameraControls />);
    const allText = container.textContent;
    expect(allText).not.toContain('?');
  });

  it('Center button calls onCenterObject callback', () => {
    const onCenterObject = vi.fn();
    useAppStore.getState().setCameraCallbacks({ onCenterObject });
    const { getByLabelText } = render(<CameraControls />);
    fireEvent.click(getByLabelText('Center Object'));
    expect(onCenterObject).toHaveBeenCalledTimes(1);
  });

  it('Follow button toggles orbitFollowEnabled on', () => {
    const onCenterObject = vi.fn();
    const onEnableFollow = vi.fn(() => true);
    useAppStore.getState().setCameraCallbacks({ onCenterObject, onEnableFollow });
    const { getByLabelText } = render(<CameraControls />);
    fireEvent.click(getByLabelText('Follow'));
    expect(onEnableFollow).toHaveBeenCalled();
    expect(useAppStore.getState().orbitFollowEnabled).toBe(true);
  });

  it('Follow button toggles orbitFollowEnabled off when active', () => {
    useAppStore.getState().setOrbitFollowEnabled(true);
    const { getByLabelText } = render(<CameraControls />);
    fireEvent.click(getByLabelText('Following target (tap to stop)'));
    expect(useAppStore.getState().orbitFollowEnabled).toBe(false);
  });
});

// ── Touch discoverability hints ──

describe('CameraControls touch hints', () => {
  beforeEach(() => {
    useAppStore.getState().resetTransientState();
  });
  afterEach(() => {
    cleanup();
  });

  it('Center button contains hint text "Frame molecule"', () => {
    const { getByLabelText } = render(<CameraControls />);
    const btn = getByLabelText('Center Object');
    expect(btn.querySelector('.camera-action-hint')?.textContent).toBe('Frame molecule');
  });

  it('Follow button contains hint text "Track molecule"', () => {
    const { getByLabelText } = render(<CameraControls />);
    const btn = getByLabelText('Follow');
    expect(btn.querySelector('.camera-action-hint')?.textContent).toBe('Track molecule');
  });

  it('active Follow button contains hint text "Tap to stop"', () => {
    useAppStore.getState().setOrbitFollowEnabled(true);
    const { getByLabelText } = render(<CameraControls />);
    const btn = getByLabelText('Following target (tap to stop)');
    expect(btn.querySelector('.camera-action-hint')?.textContent).toBe('Tap to stop');
  });
});

// ── Follow toggle store behavior (baseline for Phase 2 refactor) ──

describe('orbitFollowEnabled store behavior', () => {
  beforeEach(() => {
    useAppStore.getState().resetTransientState();
  });

  it('defaults to false', () => {
    expect(useAppStore.getState().orbitFollowEnabled).toBe(false);
  });

  it('can be enabled and disabled', () => {
    useAppStore.getState().setOrbitFollowEnabled(true);
    expect(useAppStore.getState().orbitFollowEnabled).toBe(true);
    useAppStore.getState().setOrbitFollowEnabled(false);
    expect(useAppStore.getState().orbitFollowEnabled).toBe(false);
  });

  it('resetTransientState clears follow', () => {
    useAppStore.getState().setOrbitFollowEnabled(true);
    useAppStore.getState().resetTransientState();
    expect(useAppStore.getState().orbitFollowEnabled).toBe(false);
  });
});
