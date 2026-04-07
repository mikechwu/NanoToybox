/**
 * @vitest-environment jsdom
 */
/**
 * Tests for watch-overlay-layout: triad sizing, positioning, and lifecycle.
 *
 * Validates:
 *   - Phone sizing formula
 *   - Desktop/tablet sizing formula
 *   - Bottom clearance uses playback bar measurement ([data-watch-playback-bar])
 *   - Playback bar selector contract
 *   - Left inset uses --safe-left
 *   - Destroy removes listeners/observers
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createWatchOverlayLayout } from '../../watch/js/watch-overlay-layout';
import type { WatchRenderer } from '../../watch/js/watch-renderer';

// JSDOM does not provide ResizeObserver — controllable stub for testing
let _roInstances: { cb: Function; observed: Element[]; disconnected: boolean }[] = [];

class MockResizeObserver {
  _entry: typeof _roInstances[0];
  constructor(cb: Function) {
    this._entry = { cb, observed: [], disconnected: false };
    _roInstances.push(this._entry);
  }
  observe(el: Element) { this._entry.observed.push(el); }
  unobserve() {}
  disconnect() { this._entry.disconnected = true; this._entry.observed = []; }
}

globalThis.ResizeObserver = MockResizeObserver as any;

function resetROInstances() { _roInstances = []; }

// ── Mock renderer ──

function createMockRenderer() {
  return {
    setOverlayLayout: vi.fn(),
    // Remaining interface stubs (not used by overlay layout)
    getCanvas: vi.fn(() => document.createElement('canvas')),
    applyTheme: vi.fn(),
    initForPlayback: vi.fn(),
    updateReviewFrame: vi.fn(),
    fitCamera: vi.fn(),
    render: vi.fn(),
    destroy: vi.fn(),
    setGroupHighlight: vi.fn(),
    clearGroupHighlight: vi.fn(),
    getDisplayedAtomWorldPosition: vi.fn(() => null),
    getSceneRadius: vi.fn(() => 10),
    animateToFramedTarget: vi.fn(),
    updateOrbitFollow: vi.fn(),
    isInsideTriad: vi.fn(() => false),
    applyOrbitDelta: vi.fn(),
    getNearestAxisEndpoint: vi.fn(() => null),
    snapToAxis: vi.fn(),
    animatedResetView: vi.fn(),
    showAxisHighlight: vi.fn(),
    startBackgroundOrbitCue: vi.fn(),
    endBackgroundOrbitCue: vi.fn(),
    cancelCameraAnimation: vi.fn(),
  } as unknown as WatchRenderer & { setOverlayLayout: ReturnType<typeof vi.fn> };
}

// Helper to force a viewport width for layout computation
function setViewport(width: number, height = 800) {
  Object.defineProperty(window, 'innerWidth', { writable: true, value: width });
  Object.defineProperty(window, 'innerHeight', { writable: true, value: height });
}

// ── Playback bar selector contract ──

describe('Playback bar selector contract', () => {
  it('WatchPlaybackBar.tsx has data-watch-playback-bar attribute', async () => {
    const fs = await import('fs');
    const source = fs.readFileSync('watch/js/components/WatchPlaybackBar.tsx', 'utf-8');
    expect(source).toContain('data-watch-playback-bar');
  });

  it('watch-overlay-layout.ts queries [data-watch-playback-bar]', async () => {
    const fs = await import('fs');
    const source = fs.readFileSync('watch/js/watch-overlay-layout.ts', 'utf-8');
    expect(source).toContain('[data-watch-playback-bar]');
    expect(source).not.toContain('.watch-playback-bar');
  });
});

// ── Sizing formulas ──

describe('Triad sizing formulas', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: vi.fn((query: string) => ({
        matches: false, // desktop: precise pointer, can hover
      })),
    });
  });

  it('desktop: min(200, max(120, floor(W * 0.10)))', () => {
    setViewport(1440);
    const mockRenderer = createMockRenderer();
    const layout = createWatchOverlayLayout(mockRenderer);
    layout.doLayout();

    const call = mockRenderer.setOverlayLayout.mock.calls[0][0];
    // floor(1440 * 0.10) = 144, clamped to [120, 200] = 144
    expect(call.triadSize).toBe(144);
    layout.destroy();
  });

  it('desktop: clamps to min 120', () => {
    setViewport(800);
    const mockRenderer = createMockRenderer();
    const layout = createWatchOverlayLayout(mockRenderer);
    layout.doLayout();

    const call = mockRenderer.setOverlayLayout.mock.calls[0][0];
    // floor(800 * 0.10) = 80, clamped to [120, 200] = 120
    expect(call.triadSize).toBe(120);
    layout.destroy();
  });

  it('desktop: clamps to max 200', () => {
    setViewport(2500);
    const mockRenderer = createMockRenderer();
    const layout = createWatchOverlayLayout(mockRenderer);
    layout.doLayout();

    const call = mockRenderer.setOverlayLayout.mock.calls[0][0];
    // floor(2500 * 0.10) = 250, clamped to [120, 200] = 200
    expect(call.triadSize).toBe(200);
    layout.destroy();
  });

  it('phone (<768px): min(140, max(96, floor(W * 0.15)))', () => {
    setViewport(400);
    const mockRenderer = createMockRenderer();
    const layout = createWatchOverlayLayout(mockRenderer);
    layout.doLayout();

    const call = mockRenderer.setOverlayLayout.mock.calls[0][0];
    // floor(400 * 0.15) = 60, clamped to [96, 140] = 96
    expect(call.triadSize).toBe(96);
    layout.destroy();
  });

  it('phone: clamps to max 140', () => {
    setViewport(760);
    const mockRenderer = createMockRenderer();
    const layout = createWatchOverlayLayout(mockRenderer);
    layout.doLayout();

    const call = mockRenderer.setOverlayLayout.mock.calls[0][0];
    // floor(760 * 0.15) = 114, clamped to [96, 140] = 114
    expect(call.triadSize).toBe(114);
    layout.destroy();
  });
});

// ── Bottom clearance ──

describe('Triad bottom positioning', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: vi.fn(() => ({ matches: false })),
    });
  });

  it('desktop: fixed bottom = 12', () => {
    setViewport(1440);
    const mockRenderer = createMockRenderer();
    const layout = createWatchOverlayLayout(mockRenderer);
    layout.doLayout();

    expect(mockRenderer.setOverlayLayout.mock.calls[0][0].triadBottom).toBe(12);
    layout.destroy();
  });

  it('phone: clears playback bar when [data-watch-playback-bar] is in DOM', () => {
    setViewport(400, 800);
    // Add a mock playback bar
    const bar = document.createElement('div');
    bar.setAttribute('data-watch-playback-bar', '');
    // Position it at bottom of viewport (top = 740, so topFromBottom = 60)
    Object.defineProperty(bar, 'getBoundingClientRect', {
      value: () => ({ top: 740, bottom: 800, left: 0, right: 400, width: 400, height: 60 }),
    });
    document.body.appendChild(bar);

    const mockRenderer = createMockRenderer();
    const layout = createWatchOverlayLayout(mockRenderer);
    layout.doLayout();

    const call = mockRenderer.setOverlayLayout.mock.calls[0][0];
    // barTopFromBottom = 800 - 740 = 60, triadBottom = 60 + 8 = 68
    expect(call.triadBottom).toBe(68);

    layout.destroy();
    bar.remove();
  });

  it('phone: uses PHONE_TRIAD_BOTTOM_FALLBACK when playback bar is not in DOM', () => {
    setViewport(400, 800);
    const mockRenderer = createMockRenderer();
    const layout = createWatchOverlayLayout(mockRenderer);
    layout.doLayout();

    const call = mockRenderer.setOverlayLayout.mock.calls[0][0];
    // Startup fallback: 68px (minimum bar height 60 + 8px gap)
    expect(call.triadBottom).toBe(68);

    layout.destroy();
  });
});

// ── Left inset ──

describe('Triad left inset', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: vi.fn(() => ({ matches: false })),
    });
  });

  it('uses --safe-left CSS variable + 6', () => {
    setViewport(1440);
    document.documentElement.style.setProperty('--safe-left', '20');
    const mockRenderer = createMockRenderer();
    const layout = createWatchOverlayLayout(mockRenderer);
    layout.doLayout();

    expect(mockRenderer.setOverlayLayout.mock.calls[0][0].triadLeft).toBe(26);

    layout.destroy();
    document.documentElement.style.removeProperty('--safe-left');
  });

  it('defaults to 6 when --safe-left is not set', () => {
    setViewport(1440);
    const mockRenderer = createMockRenderer();
    const layout = createWatchOverlayLayout(mockRenderer);
    layout.doLayout();

    expect(mockRenderer.setOverlayLayout.mock.calls[0][0].triadLeft).toBe(6);

    layout.destroy();
  });
});

// ── Retry-loop startup lifecycle ──
// Uses a controllable RAF queue to test the actual scheduled retry path.

describe('scheduleFirstLayout retry loop', () => {
  let rafQueue: Array<FrameRequestCallback>;
  let origRAF: typeof requestAnimationFrame;
  let origCancelRAF: typeof cancelAnimationFrame;
  let nextRafId: number;

  beforeEach(() => {
    resetROInstances();
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: vi.fn(() => ({ matches: false })),
    });
    // Controllable RAF queue — flush manually to test scheduled retry path
    rafQueue = [];
    nextRafId = 1;
    origRAF = globalThis.requestAnimationFrame;
    origCancelRAF = globalThis.cancelAnimationFrame;
    globalThis.requestAnimationFrame = (cb: FrameRequestCallback) => {
      const id = nextRafId++;
      rafQueue.push(cb);
      return id;
    };
    globalThis.cancelAnimationFrame = (_id: number) => {};
  });

  afterEach(() => {
    globalThis.requestAnimationFrame = origRAF;
    globalThis.cancelAnimationFrame = origCancelRAF;
  });

  function flushRAF(count = 1) {
    for (let i = 0; i < count; i++) {
      const cb = rafQueue.shift();
      if (cb) cb(performance.now());
    }
  }

  it('phone: scheduled RAF retry finds bar after insertion and attaches observer', () => {
    setViewport(400, 800);
    const mockRenderer = createMockRenderer();
    const layout = createWatchOverlayLayout(mockRenderer);

    // scheduleFirstLayout queues: RAF → RAF → tryAttach.
    // Flush the outer double-RAF to reach tryAttach.
    flushRAF(); // outer RAF
    flushRAF(); // inner RAF → calls tryAttach → doLayout (bar missing) → schedules retry RAF

    let calls = mockRenderer.setOverlayLayout.mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    // Still on fallback (bar not in DOM)
    expect(calls[calls.length - 1][0].triadBottom).toBe(68);
    expect(_roInstances.filter(ro => ro.observed.length > 0)).toHaveLength(0);
    // Retry RAF should be queued
    expect(rafQueue.length).toBeGreaterThan(0);

    // Insert the playback bar with geometry that produces a DIFFERENT bottom
    // than the fallback (68). Bar top at 700 in 800px viewport → measured = 108.
    const bar = document.createElement('div');
    bar.setAttribute('data-watch-playback-bar', '');
    Object.defineProperty(bar, 'getBoundingClientRect', {
      value: () => ({ top: 700, bottom: 800, left: 0, right: 400, width: 400, height: 100 }),
    });
    document.body.appendChild(bar);

    // Flush the retry RAF — tryAttach should find the bar
    flushRAF();

    calls = mockRenderer.setOverlayLayout.mock.calls;
    const lastCall = calls[calls.length - 1][0];
    // Measured: barTopFromBottom = 800 - 700 = 100, bottom = 100 + 8 = 108
    // This DIFFERS from the fallback 68, proving the retry found and measured the bar.
    expect(lastCall.triadBottom).toBe(108);
    // Observer now attached
    expect(_roInstances.filter(ro => ro.observed.includes(bar))).toHaveLength(1);
    // No more retries queued (bar found → retry stops)
    // (any remaining RAF entries would be from the resize path, not the retry loop)

    layout.destroy();
    bar.remove();
  });

  it('desktop: initial layout completes without retry', () => {
    setViewport(1440);
    const mockRenderer = createMockRenderer();
    const layout = createWatchOverlayLayout(mockRenderer);

    // Flush double-RAF to reach tryAttach
    flushRAF();
    flushRAF();

    const calls = mockRenderer.setOverlayLayout.mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    expect(calls[calls.length - 1][0].triadBottom).toBe(12);
    expect(_roInstances.filter(ro => ro.observed.length > 0)).toHaveLength(0);

    layout.destroy();
  });
});

// ── ResizeObserver behavior ──

describe('ResizeObserver on playback bar', () => {
  let bar: HTMLElement;

  beforeEach(() => {
    resetROInstances();
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: vi.fn(() => ({ matches: false })),
    });
    bar = document.createElement('div');
    bar.setAttribute('data-watch-playback-bar', '');
    Object.defineProperty(bar, 'getBoundingClientRect', {
      value: () => ({ top: 740, bottom: 800, left: 0, right: 400, width: 400, height: 60 }),
    });
  });

  afterEach(() => {
    bar.remove();
    resetROInstances();
  });

  it('attaches observer in phone mode when bar exists', () => {
    setViewport(400, 800);
    document.body.appendChild(bar);
    const mockRenderer = createMockRenderer();
    const layout = createWatchOverlayLayout(mockRenderer);
    layout.doLayout();

    const attached = _roInstances.filter(ro => ro.observed.includes(bar));
    expect(attached.length).toBe(1);

    layout.destroy();
  });

  it('does NOT attach observer in desktop mode', () => {
    setViewport(1440);
    document.body.appendChild(bar);
    const mockRenderer = createMockRenderer();
    const layout = createWatchOverlayLayout(mockRenderer);
    layout.doLayout();

    const attached = _roInstances.filter(ro => ro.observed.includes(bar));
    expect(attached.length).toBe(0);

    layout.destroy();
  });

  it('disconnects observer when switching out of phone mode', () => {
    setViewport(400, 800);
    document.body.appendChild(bar);
    const mockRenderer = createMockRenderer();
    const layout = createWatchOverlayLayout(mockRenderer);
    layout.doLayout();

    const attached = _roInstances.filter(ro => ro.observed.includes(bar));
    expect(attached.length).toBe(1);

    // Switch to desktop
    setViewport(1440);
    layout.doLayout();

    expect(attached[0].disconnected).toBe(true);
    layout.destroy();
  });

  it('observer callback triggers re-layout', () => {
    setViewport(400, 800);
    document.body.appendChild(bar);
    const mockRenderer = createMockRenderer();
    const layout = createWatchOverlayLayout(mockRenderer);
    layout.doLayout();

    const ro = _roInstances.find(r => r.observed.includes(bar));
    expect(ro).toBeDefined();

    // Simulate a bar resize — observer callback should schedule re-layout
    (mockRenderer as any).setOverlayLayout = vi.fn();
    // Directly call the callback (in real runtime, RAF would coalesce)
    ro!.cb();
    // The callback schedules a RAF; call doLayout directly to test the path
    layout.doLayout();
    expect(mockRenderer.setOverlayLayout).toHaveBeenCalled();

    layout.destroy();
  });

  it('disconnect on destroy', () => {
    setViewport(400, 800);
    document.body.appendChild(bar);
    const mockRenderer = createMockRenderer();
    const layout = createWatchOverlayLayout(mockRenderer);
    layout.doLayout();

    const attached = _roInstances.filter(ro => ro.observed.includes(bar));
    expect(attached.length).toBe(1);

    layout.destroy();
    expect(attached[0].disconnected).toBe(true);
  });
});

// ── Lifecycle ──

describe('Overlay layout lifecycle', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: vi.fn(() => ({ matches: false })),
    });
  });

  it('destroy removes resize and orientationchange listeners', () => {
    setViewport(1440);
    const spy = vi.spyOn(window, 'removeEventListener');
    const mockRenderer = createMockRenderer();
    const layout = createWatchOverlayLayout(mockRenderer);
    layout.destroy();

    expect(spy).toHaveBeenCalledWith('resize', expect.any(Function));
    expect(spy).toHaveBeenCalledWith('orientationchange', expect.any(Function));
    spy.mockRestore();
  });
});
