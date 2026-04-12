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
    hoveredGroupId: null,
    following: false,
    followedGroupId: null,
    speed: 1,
    repeat: false,
    playDirection: 0 as 1 | -1 | 0,
    theme: 'light',
    textSize: 'normal',
    // Round 6 defaults
    smoothPlayback: true,
    interpolationMode: 'linear',
    activeInterpolationMethod: 'linear',
    lastFallbackReason: 'none',
    importDiagnostics: [],
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
    hoverGroup: vi.fn(),
    centerOnGroup: vi.fn(),
    followGroup: vi.fn(),
    unfollowGroup: vi.fn(),
    applyGroupColor: vi.fn(),
    clearGroupColor: vi.fn(),
    getGroupColorState: vi.fn(() => ({ kind: 'default' })),
    setSpeed: vi.fn(),
    toggleRepeat: vi.fn(),
    stepForward: vi.fn(),
    stepBackward: vi.fn(),
    startDirectionalPlayback: vi.fn(),
    stopDirectionalPlayback: vi.fn(),
    setTheme: vi.fn(),
    setTextSize: vi.fn(),
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
    setSmoothPlayback: vi.fn(),
    setInterpolationMode: vi.fn(),
    getRegisteredInterpolationMethods: vi.fn(() => []),
    getInterpolationRuntime: vi.fn(() => null),
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
    // Should have dock controls (playing=true → dock with dock-item buttons)
    const dockBtns = container.querySelectorAll('.dock-item');
    expect(dockBtns.length).toBeGreaterThan(0);
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
    const toggle = container.querySelector('.bg-panel__header-toggle');
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
    const header = container.querySelector('.bg-panel__header');
    expect(header).not.toBeNull();
    act(() => { fireEvent.click(header!); });
    // Panel body should be gone (no #watch-bonded-groups-body when collapsed)
    expect(container.querySelector('#watch-bonded-groups-body')).toBeNull();
  });

  it('follow toggle: any row follow click while active turns follow off', () => {
    const ctrl = createMockController({
      loaded: true, endTimePs: 100, fileKind: 'full',
      following: true, followedGroupId: 'g1',
      groups: [
        { id: 'g1', displayIndex: 1, atomCount: 50, minAtomIndex: 0, orderKey: 0 },
        { id: 'g2', displayIndex: 2, atomCount: 10, minAtomIndex: 50, orderKey: 1 },
      ],
    });
    const { container } = render(<WatchApp controller={ctrl} />);
    // Follow On strip should be visible
    const followOnBtn = container.querySelector('.bg-panel__follow-active');
    expect(followOnBtn).not.toBeNull();
    // Row follow buttons should NOT be disabled (lab parity: any click is toggle off)
    const followBtns = container.querySelectorAll('.bg-panel__row-action');
    for (const btn of Array.from(followBtns)) {
      expect((btn as HTMLButtonElement).disabled).toBe(false);
    }
  });

  it('follow buttons use row-specific follow semantics', () => {
    const ctrl = createMockController({
      loaded: true, endTimePs: 100, fileKind: 'full',
      following: true, followedGroupId: 'g1',
      groups: [
        { id: 'g1', displayIndex: 1, atomCount: 50, minAtomIndex: 0, orderKey: 0 },
        { id: 'g2', displayIndex: 2, atomCount: 10, minAtomIndex: 50, orderKey: 1 },
      ],
    });
    const { container } = render(<WatchApp controller={ctrl} />);
    const followBtns = Array.from(container.querySelectorAll('.bg-panel__row-action')).filter((btn) => {
      const label = btn.getAttribute('aria-label') ?? '';
      return label.startsWith('Follow group') || label.startsWith('Stop following group');
    }) as HTMLButtonElement[];
    expect(followBtns).toHaveLength(2);
    expect(followBtns[0].getAttribute('aria-label')).toBe('Stop following group 1');
    expect(followBtns[0].getAttribute('aria-pressed')).toBe('true');
    expect(followBtns[1].getAttribute('aria-label')).toBe('Follow group 2');
    expect(followBtns[1].hasAttribute('aria-pressed')).toBe(false);
  });

  it('stateful follow toggle: clicking different row while active re-renders to off state', () => {
    const ctrl = createMockController({
      loaded: true, endTimePs: 100, fileKind: 'full',
      following: true, followedGroupId: 'g1',
      groups: [
        { id: 'g1', displayIndex: 1, atomCount: 50, minAtomIndex: 0, orderKey: 0 },
        { id: 'g2', displayIndex: 2, atomCount: 10, minAtomIndex: 50, orderKey: 1 },
      ],
    });
    const { container } = render(<WatchApp controller={ctrl} />);

    // Pre-condition: Follow On strip visible, g1 row active
    expect(container.querySelector('.bg-panel__follow-active')).not.toBeNull();
    expect(container.querySelector('.bg-panel__row-action--active')).not.toBeNull();

    // Click g2's follow button (global toggle: any click while active = off)
    const followBtns = Array.from(container.querySelectorAll('.bg-panel__row-action')).filter((btn) => {
      const label = btn.getAttribute('aria-label') ?? '';
      return label.startsWith('Follow group') || label.startsWith('Stop following group');
    }) as HTMLButtonElement[];
    act(() => { fireEvent.click(followBtns[1]); }); // g2's follow button

    // Controller should have been called with g2's id
    expect(ctrl.followGroup).toHaveBeenCalledWith('g2');

    // Simulate controller updating snapshot to follow-off state
    act(() => { ctrl.setSnapshot({
      loaded: true, endTimePs: 100, fileKind: 'full',
      following: false, followedGroupId: null,
      groups: [
        { id: 'g1', displayIndex: 1, atomCount: 50, minAtomIndex: 0, orderKey: 0 },
        { id: 'g2', displayIndex: 2, atomCount: 10, minAtomIndex: 50, orderKey: 1 },
      ],
    }); });

    // Post-condition: Follow On strip gone, no active follow row
    expect(container.querySelector('.bg-panel__follow-active')).toBeNull();
    expect(container.querySelector('.bg-panel__row-action--active')).toBeNull();
    // All follow buttons should say "Follow" (not "Stop following")
    const updatedFollowBtns = Array.from(container.querySelectorAll('.bg-panel__row-action')).filter((btn) => {
      const label = btn.getAttribute('aria-label') ?? '';
      return label.startsWith('Follow group') || label.startsWith('Stop following group');
    });
    for (const btn of updatedFollowBtns) {
      expect(btn.getAttribute('aria-label')).toMatch(/^Follow group/);
      expect(btn.hasAttribute('aria-pressed')).toBe(false);
    }
  });

  it('column header shows Cluster / Atoms / Center / Follow', () => {
    const ctrl = createMockController({
      loaded: true, endTimePs: 100, fileKind: 'full',
      groups: [{ id: 'g1', displayIndex: 1, atomCount: 50, minAtomIndex: 0, orderKey: 0 }],
    });
    const { container } = render(<WatchApp controller={ctrl} />);
    const header = container.querySelector('.bg-panel__col-header');
    expect(header).not.toBeNull();
    expect(header!.textContent).toContain('Cluster');
    expect(header!.textContent).toContain('Atoms');
    expect(header!.textContent).toContain('Center');
    expect(header!.textContent).toContain('Follow');
  });

  it('rows have chip placeholder for lab geometry parity', () => {
    const ctrl = createMockController({
      loaded: true, endTimePs: 100, fileKind: 'full',
      groups: [{ id: 'g1', displayIndex: 1, atomCount: 50, minAtomIndex: 0, orderKey: 0 }],
    });
    const { container } = render(<WatchApp controller={ctrl} />);
    expect(container.querySelector('.bg-panel__row-chip')).not.toBeNull();
  });

  it('small clusters section uses lab-style disclosure label', () => {
    const ctrl = createMockController({
      loaded: true, endTimePs: 100, fileKind: 'full',
      groups: [
        { id: 'g1', displayIndex: 1, atomCount: 50, minAtomIndex: 0, orderKey: 0 },
        { id: 'g2', displayIndex: 2, atomCount: 2, minAtomIndex: 50, orderKey: 1 },
      ],
    });
    const { container } = render(<WatchApp controller={ctrl} />);
    const smallToggle = container.querySelector('.bg-panel__small-toggle');
    expect(smallToggle).not.toBeNull();
    expect(smallToggle!.textContent).toContain('Small Clusters: 1');
  });

  it('no stats block inside bonded-groups panel (parity: lab panel has no file stats)', () => {
    const ctrl = createMockController({
      loaded: true, endTimePs: 100, fileKind: 'full',
      groups: [{ id: 'g1', displayIndex: 1, atomCount: 50, minAtomIndex: 0, orderKey: 0 }],
    });
    const { container } = render(<WatchApp controller={ctrl} />);
    expect(container.querySelector('.bg-panel__stats')).toBeNull();
  });

  it('active follow row has aria-pressed, inactive rows do not', () => {
    const ctrl = createMockController({
      loaded: true, endTimePs: 100, fileKind: 'full',
      following: true, followedGroupId: 'g1',
      groups: [
        { id: 'g1', displayIndex: 1, atomCount: 50, minAtomIndex: 0, orderKey: 0 },
        { id: 'g2', displayIndex: 2, atomCount: 10, minAtomIndex: 50, orderKey: 1 },
      ],
    });
    const { container } = render(<WatchApp controller={ctrl} />);
    const rows = container.querySelectorAll('.bg-panel__row');
    // First row (g1) is followed — its follow button should have aria-pressed
    const g1FollowBtn = rows[0]?.querySelectorAll('.bg-panel__row-action')[1] as HTMLButtonElement;
    expect(g1FollowBtn?.getAttribute('aria-pressed')).toBe('true');
    // Second row (g2) is not followed — no aria-pressed
    const g2FollowBtn = rows[1]?.querySelectorAll('.bg-panel__row-action')[1] as HTMLButtonElement;
    expect(g2FollowBtn?.getAttribute('aria-pressed')).toBeNull();
    // Inactive row still says "Follow", not "Stop following"
    expect(g2FollowBtn?.getAttribute('title')).toBe('Follow');
  });

  it('top bar shows file kind badge', () => {
    const ctrl = createMockController({ loaded: true, endTimePs: 100, fileKind: 'full' });
    const { container } = render(<WatchApp controller={ctrl} />);
    const badge = container.querySelector('.review-topbar__badge');
    expect(badge).not.toBeNull();
    expect(badge!.textContent).toBe('Full History');
  });
});
