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
    repeat: true,
    playDirection: 0 as 1 | -1 | 0,
    theme: 'light',
    textSize: 'normal',
    // Round 6 defaults
    smoothPlayback: true,
    interpolationMode: 'linear',
    activeInterpolationMethod: 'linear',
    lastFallbackReason: 'none',
    importDiagnostics: [],
    openProgress: { kind: 'idle' },
    loadingShareCode: null,
    cinematicCameraEnabled: true,
    cinematicCameraActive: false,
    cinematicCameraPausedForUserInput: false,
    cinematicCameraEligibleClusterCount: 0,
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
    openSharedCapsule: vi.fn(async () => {}),
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
  it('renders Watch workspace and open panel when not loaded', () => {
    const ctrl = createMockController();
    const { container } = render(<WatchApp controller={ctrl} />);
    // Workspace shell is ALWAYS rendered now — the former
    // `.watch-landing` page is deleted and the open panel overlays
    // the canvas area instead.
    expect(container.querySelector('.watch-workspace')).not.toBeNull();
    expect(container.querySelector('.watch-open-panel')).not.toBeNull();
    expect(container.querySelector('.watch-landing')).toBeNull();
    // Right-rail panels are withheld in empty state.
    expect(container.querySelector('.watch-analysis')).toBeNull();
  });

  it('shows workspace when loaded', () => {
    const ctrl = createMockController({ loaded: true, atomCount: 60, frameCount: 34, endTimePs: 100, fileKind: 'full' });
    const { container } = render(<WatchApp controller={ctrl} />);
    expect(container.querySelector('.watch-workspace')).not.toBeNull();
    expect(container.querySelector('.watch-open-panel')).toBeNull();
    expect(container.querySelector('.watch-landing')).toBeNull();
    // Right rail returns when a file is loaded.
    expect(container.querySelector('.watch-analysis')).not.toBeNull();
  });

  it('shows error banner while empty-state open panel is visible', () => {
    const ctrl = createMockController({ error: 'Bad file' });
    const { container } = render(<WatchApp controller={ctrl} />);
    expect(container.querySelector('.watch-open-panel')).not.toBeNull();
    expect(container.querySelector('.watch-landing')).toBeNull();
    const banner = container.querySelector('.review-status-msg--error');
    expect(banner).not.toBeNull();
    expect(banner!.textContent).toBe('Bad file');
  });

  // ── Empty-state UX + open panel ──

  it('empty state renders share input as primary and local file as secondary', () => {
    const ctrl = createMockController();
    const { container } = render(<WatchApp controller={ctrl} />);
    const panel = container.querySelector('.watch-open-panel');
    expect(panel).not.toBeNull();
    expect(panel!.querySelector('.watch-open-panel__input')).not.toBeNull();
    expect(panel!.querySelector('.watch-open-panel__primary')).not.toBeNull();
    // Secondary "Open local file" button lives below the primary form.
    const secondary = panel!.querySelector('.watch-open-panel__secondary');
    expect(secondary).not.toBeNull();
    expect(secondary!.textContent?.trim()).toBe('Open local file');
  });

  it('submitting the share input invokes openSharedCapsule', async () => {
    const openSharedCapsule = vi.fn(async () => { /* no-op success */ });
    const ctrl = createMockController();
    (ctrl as any).openSharedCapsule = openSharedCapsule;
    const { container } = render(<WatchApp controller={ctrl} />);
    const input = container.querySelector<HTMLInputElement>('.watch-open-panel__input');
    const form = container.querySelector<HTMLFormElement>('.watch-open-panel__form');
    expect(input).not.toBeNull();
    expect(form).not.toBeNull();
    await act(async () => {
      fireEvent.change(input!, { target: { value: 'ABC123DEF456' } });
      fireEvent.submit(form!);
    });
    expect(openSharedCapsule).toHaveBeenCalledWith('ABC123DEF456');
  });

  it('failed share open preserves input and panel remains visible', async () => {
    // The adapter resolves `false` when controller left an error.
    const openSharedCapsule = vi.fn(async () => {
      (ctrl as any).setSnapshot({ error: 'Shared capsule not found' });
    });
    const ctrl = createMockController();
    (ctrl as any).openSharedCapsule = openSharedCapsule;
    const { container, rerender } = render(<WatchApp controller={ctrl} />);
    const input = container.querySelector<HTMLInputElement>('.watch-open-panel__input');
    const form = container.querySelector<HTMLFormElement>('.watch-open-panel__form');
    await act(async () => {
      fireEvent.change(input!, { target: { value: 'BAD1234567AB' } });
      fireEvent.submit(form!);
    });
    rerender(<WatchApp controller={ctrl} />);
    // Input draft survives the 404.
    const inputAfter = container.querySelector<HTMLInputElement>('.watch-open-panel__input');
    expect(inputAfter!.value).toBe('BAD1234567AB');
    // Panel still visible and error is surfaced.
    expect(container.querySelector('.watch-open-panel')).not.toBeNull();
    expect(container.querySelector('.review-status-msg--error')!.textContent).toBe('Shared capsule not found');
  });

  it('loading state disables input/buttons and shows Opening copy', () => {
    const ctrl = createMockController({
      openProgress: { kind: 'share', code: 'ABC123DEF456', stage: 'metadata' },
      loadingShareCode: 'ABC123DEF456',
    });
    const { container } = render(<WatchApp controller={ctrl} />);
    expect(container.querySelector('.watch-open-panel__title')!.textContent).toBe('Opening shared capsule');
    expect(container.querySelector<HTMLInputElement>('.watch-open-panel__input')!.disabled).toBe(true);
    expect(container.querySelector<HTMLButtonElement>('.watch-open-panel__primary')!.disabled).toBe(true);
    expect(container.querySelector<HTMLButtonElement>('.watch-open-panel__secondary')!.disabled).toBe(true);
    // Stage copy for metadata.
    expect(container.querySelector('.watch-open-panel__body')!.textContent).toContain('Finding shared capsule');
  });

  it('local-file loading shows source-aware title "Opening local file"', () => {
    const ctrl = createMockController({
      openProgress: { kind: 'file', fileName: 'capsule.atomdojo', stage: 'prepare' },
    });
    const { container } = render(<WatchApp controller={ctrl} />);
    // Title reflects the source path — NOT "Opening shared capsule".
    expect(container.querySelector('.watch-open-panel__title')!.textContent).toBe('Opening local file');
    // Body stage copy is shared ("Preparing interactive playback…").
    expect(container.querySelector('.watch-open-panel__body')!.textContent).toContain('Preparing interactive playback');
    // Share-code status line is NOT rendered for local-file opens
    // (no code to display).
    expect(container.querySelector('.watch-open-panel__status')).toBeNull();
  });

  it('download stage with known totalBytes renders a determinate bar with percent', () => {
    const ctrl = createMockController({
      openProgress: {
        kind: 'share', code: 'ABC123DEF456', stage: 'download',
        loadedBytes: 256_000, totalBytes: 1_000_000,
      },
    });
    const { container } = render(<WatchApp controller={ctrl} />);
    const bar = container.querySelector<HTMLElement>('.watch-open-panel__progress');
    expect(bar).not.toBeNull();
    expect(bar!.getAttribute('data-progress-mode')).toBe('determinate');
    expect(bar!.getAttribute('aria-valuenow')).toBe('26');
    expect(container.querySelector('.watch-open-panel__body')!.textContent).toContain('26%');
  });

  it('aria-live announces only the stable stage label (percent is visual-only)', () => {
    // The live region would otherwise chatter "Downloading 10%…
    // 13%… 17%…" at ~3 fps — unacceptable for screen readers. The
    // stable label lives inside aria-live; the detail (percent or
    // loaded-bytes) renders OUTSIDE as a separate aria-hidden span.
    const ctrl = createMockController({
      openProgress: {
        kind: 'share', code: 'ABC123DEF456', stage: 'download',
        loadedBytes: 256_000, totalBytes: 1_000_000,
      },
    });
    const { container } = render(<WatchApp controller={ctrl} />);
    const liveRegion = container.querySelector('.watch-open-panel__body [aria-live="polite"]');
    expect(liveRegion).not.toBeNull();
    // Live region text is the stable label — no numbers.
    expect(liveRegion!.textContent).toBe('Downloading capsule…');
    expect(liveRegion!.textContent).not.toMatch(/%|\d/);
    // Detail span carries the percent but is aria-hidden so screen
    // readers ignore it; the progressbar's aria-valuenow is the
    // correct a11y channel for the numeric value.
    const detail = container.querySelector('.watch-open-panel__detail');
    expect(detail).not.toBeNull();
    expect(detail!.getAttribute('aria-hidden')).toBe('true');
    expect(detail!.textContent).toBe('26%');
  });

  it('download stage with null totalBytes renders indeterminate bar with bytes-loaded copy', () => {
    const ctrl = createMockController({
      openProgress: {
        kind: 'share', code: 'ABC123DEF456', stage: 'download',
        loadedBytes: 1_536_000, totalBytes: null,
      },
    });
    const { container } = render(<WatchApp controller={ctrl} />);
    const bar = container.querySelector<HTMLElement>('.watch-open-panel__progress');
    expect(bar!.getAttribute('data-progress-mode')).toBe('indeterminate');
    expect(bar!.hasAttribute('aria-valuenow')).toBe(false);
    // Body copy falls back to formatBytes output (e.g. "1.5 MB").
    const body = container.querySelector('.watch-open-panel__body')!.textContent ?? '';
    expect(body).toMatch(/Downloading capsule/);
    expect(body).not.toMatch(/%/);
  });

  it('local-file button clicks the hidden file input', () => {
    const ctrl = createMockController();
    const { container } = render(<WatchApp controller={ctrl} />);
    const secondary = container.querySelector<HTMLButtonElement>('.watch-open-panel__secondary');
    expect(secondary).not.toBeNull();
    expect(secondary!.disabled).toBe(false);
    expect(secondary!.textContent?.trim()).toBe('Open local file');

    // Intercept the synthetic <input type="file"> created by
    // WatchApp.handleOpenFile. We replace input.click() with a spy
    // BEFORE the component's synchronous input.click() call runs,
    // so the spy actually fires. (jsdom would throw trying to open
    // a native picker anyway, so replacing .click is also necessary
    // for the test to finish cleanly.)
    const originalCreate = document.createElement.bind(document);
    const inputClicks: HTMLInputElement[] = [];
    const createSpy = vi.spyOn(document, 'createElement').mockImplementation(
      ((tag: string, ...rest: any[]) => {
        const el = (originalCreate as any)(tag, ...rest);
        if (tag === 'input') {
          const clickSpy = vi.fn(function (this: HTMLInputElement) { inputClicks.push(this); });
          (el as HTMLInputElement).click = clickSpy as unknown as HTMLInputElement['click'];
        }
        return el;
      }) as typeof document.createElement,
    );

    try {
      fireEvent.click(secondary!);
      expect(inputClicks.length).toBe(1);
      expect(inputClicks[0].type).toBe('file');
      expect(inputClicks[0].accept).toContain('.atomdojo');
    } finally {
      createSpy.mockRestore();
    }
  });

  it('drag/drop is ignored while loading (no concurrent openFile)', async () => {
    const openFile = vi.fn(async () => {});
    const ctrl = createMockController({
      openProgress: { kind: 'share', code: 'ABC123DEF456', stage: 'metadata' },
      loadingShareCode: 'ABC123DEF456',
    });
    (ctrl as any).openFile = openFile;
    const { container } = render(<WatchApp controller={ctrl} />);
    const panel = container.querySelector<HTMLElement>('.watch-open-panel');
    expect(panel).not.toBeNull();

    const file = new File(['{}'], 'test.atomdojo', { type: 'application/json' });
    await act(async () => {
      fireEvent.drop(panel!, { dataTransfer: { files: [file] } });
    });

    // The loading-disabled contract must apply across all input
    // methods — drop-during-load must NOT kick off a concurrent
    // openFile racing the in-flight share pipeline.
    expect(openFile).not.toHaveBeenCalled();
  });

  it('stage-copy element is aria-live="polite" during loading (announces stage transitions)', () => {
    const ctrl = createMockController({
      openProgress: { kind: 'share', code: 'ABC123DEF456', stage: 'metadata' },
      loadingShareCode: 'ABC123DEF456',
    });
    const { container } = render(<WatchApp controller={ctrl} />);
    // The body paragraph wraps the stage copy in a live span. The
    // live attribute must be on the span that actually changes
    // content between stages — not on the static share-code line.
    const body = container.querySelector('.watch-open-panel__body');
    expect(body).not.toBeNull();
    const liveSpan = body!.querySelector('[aria-live="polite"]');
    expect(liveSpan).not.toBeNull();
    expect(liveSpan!.textContent).toContain('Finding shared capsule');
    // Share-code status line is static across stages — no aria-live.
    const status = container.querySelector('.watch-open-panel__status');
    expect(status?.getAttribute('aria-live')).toBeNull();
  });

  it('dropping a file on the panel invokes controller.openFile', async () => {
    const openFile = vi.fn(async () => {});
    const ctrl = createMockController();
    (ctrl as any).openFile = openFile;
    const { container } = render(<WatchApp controller={ctrl} />);
    const panel = container.querySelector<HTMLElement>('.watch-open-panel');
    expect(panel).not.toBeNull();
    const file = new File(['{}'], 'test.atomdojo', { type: 'application/json' });
    await act(async () => {
      fireEvent.drop(panel!, {
        dataTransfer: { files: [file] },
      });
    });
    expect(openFile).toHaveBeenCalled();
    expect((openFile.mock.calls as any[])[0][0]).toBe(file);
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

  it('info panel shows file kind chip — full → history', () => {
    const ctrl = createMockController({ loaded: true, endTimePs: 100, fileKind: 'full' });
    const { container } = render(<WatchApp controller={ctrl} />);
    const kind = container.querySelector('.watch-info-panel__kind');
    expect(kind).not.toBeNull();
    expect(kind!.textContent).toBe('history');
  });

  it('info panel shows file kind chip — reduced → preview', () => {
    const ctrl = createMockController({ loaded: true, endTimePs: 100, fileKind: 'reduced' });
    const { container } = render(<WatchApp controller={ctrl} />);
    const kind = container.querySelector('.watch-info-panel__kind');
    expect(kind).not.toBeNull();
    expect(kind!.textContent).toBe('preview');
  });

  it('info panel shows file kind chip — capsule passes through', () => {
    const ctrl = createMockController({ loaded: true, endTimePs: 100, fileKind: 'capsule' });
    const { container } = render(<WatchApp controller={ctrl} />);
    const kind = container.querySelector('.watch-info-panel__kind');
    expect(kind).not.toBeNull();
    // Not in the mapping table — render the raw value.
    expect(kind!.textContent).toBe('capsule');
  });
});
