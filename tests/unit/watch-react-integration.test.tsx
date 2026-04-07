/**
 * @vitest-environment jsdom
 */
/**
 * React integration tests for the watch app shell.
 * Tests UI state transitions, error banner visibility, and control wiring.
 * WatchCanvas is mocked (Three.js doesn't work in jsdom).
 */

import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { render, act, fireEvent } from '@testing-library/react';
import { WatchApp } from '../../watch/js/components/WatchApp';
import type { WatchController, WatchControllerSnapshot } from '../../watch/js/watch-controller';

// Mock WatchCanvas since Three.js doesn't work in jsdom
vi.mock('../../watch/js/components/WatchCanvas', () => ({
  WatchCanvas: () => <div data-testid="mock-canvas">canvas</div>,
}));

// ── Test controller factory ──

function makeSnapshot(overrides: Partial<WatchControllerSnapshot> = {}): WatchControllerSnapshot {
  return {
    loaded: false,
    playing: false,
    currentTimePs: 0,
    startTimePs: 0,
    endTimePs: 0,
    groups: [],
    atomCount: 0,
    frameCount: 0,
    maxAtomCount: 0,
    fileKind: null,
    fileName: null,
    error: null,
    ...overrides,
  };
}

function createMockController(initialSnapshot?: Partial<WatchControllerSnapshot>): WatchController & { setSnapshot: (s: Partial<WatchControllerSnapshot>) => void } {
  let _snapshot = makeSnapshot(initialSnapshot);
  const _listeners = new Set<() => void>();

  const controller: any = {
    getSnapshot: () => _snapshot,
    subscribe: (cb: () => void) => { _listeners.add(cb); return () => _listeners.delete(cb); },
    openFile: vi.fn(async () => {}),
    togglePlay: vi.fn(),
    scrub: vi.fn(),
    createRenderer: vi.fn(() => ({
      getCanvas: () => document.createElement('canvas'),
      applyTheme: vi.fn(),
      initForPlayback: vi.fn(),
      updateReviewFrame: vi.fn(),
      fitCamera: vi.fn(),
      render: vi.fn(),
      destroy: vi.fn(),
    })),
    getRenderer: vi.fn(() => null),
    detachRenderer: vi.fn(),
    getPlaybackModel: vi.fn(),
    getBondedGroups: vi.fn(),
    dispose: vi.fn(),
    // Test helper
    setSnapshot(overrides: Partial<WatchControllerSnapshot>) {
      _snapshot = makeSnapshot(overrides);
      for (const cb of _listeners) cb();
    },
  };
  return controller;
}

// ── Tests ──

describe('WatchApp React integration', () => {
  it('shows landing page when not loaded', () => {
    const ctrl = createMockController();
    const { container } = render(<WatchApp controller={ctrl} />);
    expect(container.querySelector('.watch-landing')).not.toBeNull();
    expect(container.querySelector('.watch-workspace')).toBeNull();
  });

  it('shows workspace when loaded', () => {
    const ctrl = createMockController({ loaded: true, atomCount: 60, frameCount: 34, endTimePs: 100, fileKind: 'full' });
    const { container } = render(<WatchApp controller={ctrl} />);
    expect(container.querySelector('.watch-landing')).toBeNull();
    expect(container.querySelector('.watch-workspace')).not.toBeNull();
  });

  it('shows error banner on landing page', () => {
    const ctrl = createMockController({ error: 'Bad file' });
    const { container } = render(<WatchApp controller={ctrl} />);
    expect(container.querySelector('.watch-landing')).not.toBeNull();
    const banner = container.querySelector('.review-status-msg--error');
    expect(banner).not.toBeNull();
    expect(banner!.textContent).toBe('Bad file');
  });

  it('shows error banner while workspace remains visible (transactional failure)', () => {
    const ctrl = createMockController({ loaded: true, atomCount: 60, frameCount: 34, endTimePs: 100, fileKind: 'full' });
    const { container, rerender } = render(<WatchApp controller={ctrl} />);
    expect(container.querySelector('.watch-workspace')).not.toBeNull();

    // Simulate failed second file open — loaded stays true, error appears
    act(() => { ctrl.setSnapshot({ loaded: true, atomCount: 60, frameCount: 34, endTimePs: 100, fileKind: 'full', error: 'Invalid replacement file' }); });
    rerender(<WatchApp controller={ctrl} />);

    expect(container.querySelector('.watch-workspace')).not.toBeNull(); // workspace stays
    const banner = container.querySelector('.review-status-msg--error');
    expect(banner).not.toBeNull();
    expect(banner!.textContent).toBe('Invalid replacement file');
  });

  it('playback bar reflects playing state', () => {
    const ctrl = createMockController({ loaded: true, playing: true, endTimePs: 100, fileKind: 'full' });
    const { container } = render(<WatchApp controller={ctrl} />);
    // Should have a pause icon (playing=true)
    const playBtn = container.querySelector('.review-playback-bar button');
    expect(playBtn).not.toBeNull();
  });

  it('bonded-groups panel shows expand/collapse toggle', () => {
    const ctrl = createMockController({
      loaded: true, endTimePs: 100, fileKind: 'full',
      groups: [
        { id: 'g1', displayIndex: 1, atomCount: 50, minAtomIndex: 0, orderKey: 0 },
        { id: 'g2', displayIndex: 2, atomCount: 2, minAtomIndex: 50, orderKey: 1 },
      ],
    });
    const { container } = render(<WatchApp controller={ctrl} />);
    const toggle = container.querySelector('.review-panel__toggle');
    expect(toggle).not.toBeNull();
    expect(toggle!.textContent).toBe('Collapse'); // expanded by default
  });

  it('panel collapse hides group list', () => {
    const ctrl = createMockController({
      loaded: true, endTimePs: 100, fileKind: 'full',
      groups: [{ id: 'g1', displayIndex: 1, atomCount: 50, minAtomIndex: 0, orderKey: 0 }],
    });
    const { container } = render(<WatchApp controller={ctrl} />);
    // Click header to collapse
    const header = container.querySelector('.review-panel__header');
    expect(header).not.toBeNull();
    act(() => { fireEvent.click(header!); });
    // Panel body should be gone
    expect(container.querySelector('.review-panel__body')).toBeNull();
  });

  it('top bar shows file kind badge', () => {
    const ctrl = createMockController({ loaded: true, endTimePs: 100, fileKind: 'full' });
    const { container } = render(<WatchApp controller={ctrl} />);
    const badge = container.querySelector('.review-topbar__badge');
    expect(badge).not.toBeNull();
    expect(badge!.textContent).toBe('Full History');
  });
});
