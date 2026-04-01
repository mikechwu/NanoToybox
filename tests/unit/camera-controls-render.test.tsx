/**
 * @vitest-environment jsdom
 */
/**
 * Render tests for CameraControls component (Object View panel).
 * Verifies Center and Follow buttons render correctly.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React from 'react';
import { render, cleanup, fireEvent, act } from '@testing-library/react';
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

// ── Desktop tooltip (ActionHint) presence and interaction ──

describe('CameraControls desktop tooltips', () => {
  beforeEach(() => {
    useAppStore.getState().resetTransientState();
  });
  afterEach(() => {
    cleanup();
  });

  it('Center button is wrapped with a tooltip anchor', () => {
    const { getByLabelText } = render(<CameraControls />);
    const btn = getByLabelText('Center Object');
    const anchor = btn.closest('.timeline-hint-anchor');
    expect(anchor).not.toBeNull();
  });

  it('Follow button is wrapped with a tooltip anchor', () => {
    const { getByLabelText } = render(<CameraControls />);
    const btn = getByLabelText('Follow');
    const anchor = btn.closest('.timeline-hint-anchor');
    expect(anchor).not.toBeNull();
  });

  it('Center tooltip has descriptive text', () => {
    const { container } = render(<CameraControls />);
    const tooltips = container.querySelectorAll('[role="tooltip"]');
    const texts = Array.from(tooltips).map(t => t.textContent);
    expect(texts.some(t => t?.includes('Frame the current molecule'))).toBe(true);
  });

  it('Follow tooltip has descriptive text', () => {
    const { container } = render(<CameraControls />);
    const tooltips = container.querySelectorAll('[role="tooltip"]');
    const texts = Array.from(tooltips).map(t => t.textContent);
    expect(texts.some(t => t?.includes('Keep the current molecule centered'))).toBe(true);
  });

  it('no title attributes on Center/Follow (tooltip replaces them)', () => {
    const { getByLabelText } = render(<CameraControls />);
    expect(getByLabelText('Center Object').getAttribute('title')).toBeNull();
    expect(getByLabelText('Follow').getAttribute('title')).toBeNull();
  });

  it('hover on Center anchor shows tooltip (visible class)', async () => {
    vi.useFakeTimers();
    const { getByLabelText } = render(<CameraControls />);
    const anchor = getByLabelText('Center Object').closest('.timeline-hint-anchor')!;
    fireEvent.mouseEnter(anchor);
    act(() => { vi.advanceTimersByTime(150); }); // past HINT_DELAY_MS (130)
    const tooltip = anchor.querySelector('[role="tooltip"]');
    expect(tooltip?.classList.contains('timeline-hint--visible')).toBe(true);
    fireEvent.mouseLeave(anchor);
    expect(tooltip?.classList.contains('timeline-hint--visible')).toBe(false);
    vi.useRealTimers();
  });

  it('focus on Follow anchor shows tooltip, blur hides it', async () => {
    vi.useFakeTimers();
    const { getByLabelText } = render(<CameraControls />);
    const anchor = getByLabelText('Follow').closest('.timeline-hint-anchor')!;
    fireEvent.focus(anchor);
    act(() => { vi.advanceTimersByTime(150); });
    const tooltip = anchor.querySelector('[role="tooltip"]');
    expect(tooltip?.classList.contains('timeline-hint--visible')).toBe(true);
    fireEvent.blur(anchor);
    expect(tooltip?.classList.contains('timeline-hint--visible')).toBe(false);
    vi.useRealTimers();
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
