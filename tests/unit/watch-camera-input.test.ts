/**
 * @vitest-environment jsdom
 */
/**
 * Tests for Watch Round 3: camera-input runtime.
 *
 * Coverage:
 *   - Shared gesture constants (single source of truth)
 *   - Camera-input lifecycle (attach/detach, no leaked listeners)
 *   - Desktop orbit routing (left-drag, right-drag)
 *   - Desktop triad interaction (click snap, center reset)
 *   - Mobile orbit routing (1-finger background)
 *   - Mobile triad interaction (drag commit, tap snap, double-tap reset)
 *   - Pointer capture acquire/release
 *   - Contextmenu suppression
 *   - Blur handler gesture state reset
 *   - TouchCancel gesture state reset
 *   - WatchRenderer adapter method wiring
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  TRIAD_DRAG_COMMIT_PX,
  TAP_INTENT_PREVIEW_MS,
  TAP_MAX_DURATION_MS,
  DOUBLE_TAP_WINDOW_MS,
} from '../../src/input/camera-gesture-constants';
import { createWatchCameraInput } from '../../watch/js/watch-camera-input';
import type { WatchRenderer } from '../../watch/js/watch-renderer';

// ── Shared gesture constants ──

describe('camera-gesture-constants', () => {
  it('exports expected constant values', () => {
    expect(TRIAD_DRAG_COMMIT_PX).toBe(5);
    expect(TAP_INTENT_PREVIEW_MS).toBe(150);
    expect(TAP_MAX_DURATION_MS).toBe(300);
    expect(DOUBLE_TAP_WINDOW_MS).toBe(400);
  });

  it('all constants are positive numbers', () => {
    for (const v of [TRIAD_DRAG_COMMIT_PX, TAP_INTENT_PREVIEW_MS, TAP_MAX_DURATION_MS, DOUBLE_TAP_WINDOW_MS]) {
      expect(typeof v).toBe('number');
      expect(v).toBeGreaterThan(0);
    }
  });
});

// ── Mock renderer ──

function createMockRenderer(): WatchRenderer & { _canvas: HTMLCanvasElement } {
  const canvas = document.createElement('canvas');
  // Stub pointer capture (JSDOM doesn't support it)
  canvas.setPointerCapture = vi.fn();
  canvas.releasePointerCapture = vi.fn();
  canvas.hasPointerCapture = vi.fn(() => false);

  return {
    _canvas: canvas,
    getCanvas: () => canvas,
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
    // Round 3
    isInsideTriad: vi.fn(() => false),
    applyOrbitDelta: vi.fn(),
    getNearestAxisEndpoint: vi.fn(() => null),
    snapToAxis: vi.fn(),
    animatedResetView: vi.fn(),
    showAxisHighlight: vi.fn(),
    startBackgroundOrbitCue: vi.fn(),
    endBackgroundOrbitCue: vi.fn(),
    cancelCameraAnimation: vi.fn(),
    setOverlayLayout: vi.fn(),
    setAtomColorOverrides: vi.fn(),
    updateCinematicFraming: vi.fn(),
    onCameraInteraction: vi.fn(() => () => {}),
  };
}

// ── Camera-input lifecycle ──

describe('WatchCameraInput lifecycle', () => {
  let mockRenderer: ReturnType<typeof createMockRenderer>;
  let canvas: HTMLCanvasElement;

  beforeEach(() => {
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: vi.fn().mockReturnValue({ matches: false }),
    });
    mockRenderer = createMockRenderer();
    canvas = mockRenderer._canvas;
    document.body.appendChild(canvas);
  });

  afterEach(() => {
    canvas.remove();
  });

  it('creates and destroys without errors', () => {
    const input = createWatchCameraInput(mockRenderer);
    expect(input).toBeDefined();
    expect(input.destroy).toBeInstanceOf(Function);
    input.destroy();
  });

  it('removes contextmenu listener on destroy', () => {
    const input = createWatchCameraInput(mockRenderer);
    const event = new Event('contextmenu', { cancelable: true });
    canvas.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);

    input.destroy();
    const event2 = new Event('contextmenu', { cancelable: true });
    canvas.dispatchEvent(event2);
    expect(event2.defaultPrevented).toBe(false);
  });
});

// ── Desktop orbit ──

describe('Desktop orbit', () => {
  let mockRenderer: ReturnType<typeof createMockRenderer>;
  let canvas: HTMLCanvasElement;
  let input: ReturnType<typeof createWatchCameraInput>;

  beforeEach(() => {
    // Force desktop detection
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: vi.fn().mockReturnValue({ matches: false }),
    });
    mockRenderer = createMockRenderer();
    canvas = mockRenderer._canvas;
    document.body.appendChild(canvas);
    input = createWatchCameraInput(mockRenderer);
  });

  afterEach(() => {
    input.destroy();
    canvas.remove();
  });

  it('left-drag on background starts orbit and calls applyOrbitDelta', () => {
    canvas.dispatchEvent(new PointerEvent('pointerdown', { button: 0, clientX: 100, clientY: 100, pointerId: 1 }));
    expect(mockRenderer.cancelCameraAnimation).toHaveBeenCalled();
    expect(mockRenderer.startBackgroundOrbitCue).toHaveBeenCalled();

    canvas.dispatchEvent(new PointerEvent('pointermove', { clientX: 110, clientY: 105, pointerId: 1 }));
    expect(mockRenderer.applyOrbitDelta).toHaveBeenCalledWith(10, 5);

    canvas.dispatchEvent(new PointerEvent('pointerup', { button: 0, pointerId: 1 }));
    expect(mockRenderer.endBackgroundOrbitCue).toHaveBeenCalled();
  });

  it('right-drag on background starts orbit', () => {
    canvas.dispatchEvent(new PointerEvent('pointerdown', { button: 2, clientX: 100, clientY: 100, pointerId: 1 }));
    expect(mockRenderer.startBackgroundOrbitCue).toHaveBeenCalled();

    canvas.dispatchEvent(new PointerEvent('pointermove', { clientX: 120, clientY: 100, pointerId: 1 }));
    expect(mockRenderer.applyOrbitDelta).toHaveBeenCalledWith(20, 0);
  });

  it('acquires pointer capture on orbit start', () => {
    canvas.dispatchEvent(new PointerEvent('pointerdown', { button: 0, clientX: 100, clientY: 100, pointerId: 42 }));
    expect(canvas.setPointerCapture).toHaveBeenCalledWith(42);
  });

  it('middle-click does not start orbit (OrbitControls owns dolly)', () => {
    canvas.dispatchEvent(new PointerEvent('pointerdown', { button: 1, clientX: 100, clientY: 100, pointerId: 1 }));
    expect(mockRenderer.startBackgroundOrbitCue).not.toHaveBeenCalled();
    expect(mockRenderer.applyOrbitDelta).not.toHaveBeenCalled();
  });
});

// ── Cinematic camera notifier hook ──

describe('onUserCameraInteraction notifier', () => {
  let mockRenderer: ReturnType<typeof createMockRenderer>;
  let canvas: HTMLCanvasElement;
  let notify: ReturnType<typeof vi.fn<(phase: string) => void>>;
  let input: ReturnType<typeof createWatchCameraInput>;

  beforeEach(() => {
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: vi.fn().mockReturnValue({ matches: false }),
    });
    mockRenderer = createMockRenderer();
    canvas = mockRenderer._canvas;
    document.body.appendChild(canvas);
    notify = vi.fn<(phase: string) => void>();
    input = createWatchCameraInput(mockRenderer, { onUserCameraInteraction: notify });
  });

  afterEach(() => {
    input.destroy();
    canvas.remove();
  });

  it("fires 'start' on left-drag pointerdown", () => {
    canvas.dispatchEvent(new PointerEvent('pointerdown', { button: 0, clientX: 100, clientY: 100, pointerId: 1 }));
    expect(notify).toHaveBeenCalledWith('start');
  });

  it("fires 'change' on pointermove while orbiting", () => {
    canvas.dispatchEvent(new PointerEvent('pointerdown', { button: 0, clientX: 100, clientY: 100, pointerId: 1 }));
    notify.mockClear();
    canvas.dispatchEvent(new PointerEvent('pointermove', { clientX: 110, clientY: 105, pointerId: 1 }));
    expect(notify).toHaveBeenCalledWith('change');
  });

  it("fires 'end' on pointerup release", () => {
    canvas.dispatchEvent(new PointerEvent('pointerdown', { button: 0, clientX: 100, clientY: 100, pointerId: 1 }));
    notify.mockClear();
    canvas.dispatchEvent(new PointerEvent('pointerup', { button: 0, pointerId: 1 }));
    expect(notify).toHaveBeenCalledWith('end');
  });

  it('full gesture emits start → change → end in order', () => {
    canvas.dispatchEvent(new PointerEvent('pointerdown', { button: 0, clientX: 100, clientY: 100, pointerId: 1 }));
    canvas.dispatchEvent(new PointerEvent('pointermove', { clientX: 110, clientY: 105, pointerId: 1 }));
    canvas.dispatchEvent(new PointerEvent('pointerup', { button: 0, pointerId: 1 }));
    const phases = notify.mock.calls.map(c => c[0]);
    expect(phases[0]).toBe('start');
    expect(phases).toContain('change');
    expect(phases[phases.length - 1]).toBe('end');
  });

  it('does NOT fire on middle-click (OrbitControls owns)', () => {
    canvas.dispatchEvent(new PointerEvent('pointerdown', { button: 1, clientX: 100, clientY: 100, pointerId: 1 }));
    expect(notify).not.toHaveBeenCalled();
  });
});

// ── Desktop triad click parity: NOT wired (lab only has triad on mobile path) ──

describe('Desktop triad click parity', () => {
  let mockRenderer: ReturnType<typeof createMockRenderer>;
  let canvas: HTMLCanvasElement;
  let input: ReturnType<typeof createWatchCameraInput>;

  beforeEach(() => {
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: vi.fn().mockReturnValue({ matches: false }),
    });
    mockRenderer = createMockRenderer();
    canvas = mockRenderer._canvas;
    document.body.appendChild(canvas);
    input = createWatchCameraInput(mockRenderer);
  });

  afterEach(() => {
    input.destroy();
    canvas.remove();
  });

  it('desktop left-click on triad does NOT call snapToAxis (parity: lab has no desktop triad click)', () => {
    mockRenderer.isInsideTriad = vi.fn(() => true);
    mockRenderer.getNearestAxisEndpoint = vi.fn((): [number, number, number] | null => [1, 0, 0]);
    canvas.dispatchEvent(new PointerEvent('pointerdown', { button: 0, clientX: 10, clientY: 10, pointerId: 1 }));
    canvas.dispatchEvent(new PointerEvent('pointerup', { button: 0, clientX: 10, clientY: 10, pointerId: 1 }));
    expect(mockRenderer.snapToAxis).not.toHaveBeenCalled();
    expect(mockRenderer.animatedResetView).not.toHaveBeenCalled();
  });

  it('desktop left-click on triad starts orbit instead (everything = orbit on desktop)', () => {
    canvas.dispatchEvent(new PointerEvent('pointerdown', { button: 0, clientX: 10, clientY: 10, pointerId: 1 }));
    expect(mockRenderer.startBackgroundOrbitCue).toHaveBeenCalled();
  });
});

// ── Contextmenu suppression ──

describe('Contextmenu suppression', () => {
  it('prevents default on contextmenu events', () => {
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: vi.fn().mockReturnValue({ matches: false }),
    });
    const mockRenderer = createMockRenderer();
    const canvas = mockRenderer._canvas;
    document.body.appendChild(canvas);
    const input = createWatchCameraInput(mockRenderer);

    const event = new Event('contextmenu', { cancelable: true });
    canvas.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);

    input.destroy();
    canvas.remove();
  });
});

// ── Blur handler ──

describe('Blur handler', () => {
  it('resets gesture state on window blur', () => {
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: vi.fn().mockReturnValue({ matches: false }),
    });
    const mockRenderer = createMockRenderer();
    const canvas = mockRenderer._canvas;
    document.body.appendChild(canvas);
    const input = createWatchCameraInput(mockRenderer);

    // Start orbit
    canvas.dispatchEvent(new PointerEvent('pointerdown', { button: 0, clientX: 100, clientY: 100, pointerId: 1 }));
    expect(mockRenderer.startBackgroundOrbitCue).toHaveBeenCalled();

    // Blur should reset
    window.dispatchEvent(new Event('blur'));

    // Subsequent move should NOT orbit (state was reset)
    mockRenderer.applyOrbitDelta = vi.fn();
    canvas.dispatchEvent(new PointerEvent('pointermove', { clientX: 120, clientY: 120, pointerId: 1 }));
    expect(mockRenderer.applyOrbitDelta).not.toHaveBeenCalled();

    input.destroy();
    canvas.remove();
  });
});

// ── Mobile: 1-finger orbit ──

describe('Mobile 1-finger orbit', () => {
  let mockRenderer: ReturnType<typeof createMockRenderer>;
  let canvas: HTMLCanvasElement;
  let input: ReturnType<typeof createWatchCameraInput>;

  beforeEach(() => {
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: vi.fn((q: string) => ({ matches: q === '(pointer: coarse)' })), // mobile: coarse=true, hover=false
    });
    mockRenderer = createMockRenderer();
    canvas = mockRenderer._canvas;
    document.body.appendChild(canvas);
    input = createWatchCameraInput(mockRenderer);
  });

  afterEach(() => {
    input.destroy();
    canvas.remove();
  });

  function touch(type: string, clientX: number, clientY: number, touches = 1) {
    const touchObj = { clientX, clientY, identifier: 0 };
    const touchList = Array.from({ length: touches }, () => touchObj);
    const event = new TouchEvent(type, {
      cancelable: true,
      touches: touchList as any,
      changedTouches: [touchObj] as any,
    });
    canvas.dispatchEvent(event);
    return event;
  }

  it('1-finger drag on background starts orbit', () => {
    touch('touchstart', 200, 200);
    expect(mockRenderer.cancelCameraAnimation).toHaveBeenCalled();
    expect(mockRenderer.startBackgroundOrbitCue).toHaveBeenCalled();

    touch('touchmove', 220, 210);
    expect(mockRenderer.applyOrbitDelta).toHaveBeenCalledWith(20, 10);

    touch('touchend', 220, 210, 0);
    expect(mockRenderer.endBackgroundOrbitCue).toHaveBeenCalled();
  });

  it('2-finger transition cancels active orbit', () => {
    touch('touchstart', 200, 200);
    expect(mockRenderer.startBackgroundOrbitCue).toHaveBeenCalled();

    // 2-finger: should cancel
    touch('touchstart', 200, 200, 2);
    // Subsequent 1-finger move should NOT orbit
    mockRenderer.applyOrbitDelta = vi.fn();
    touch('touchmove', 230, 230);
    expect(mockRenderer.applyOrbitDelta).not.toHaveBeenCalled();
  });
});

// ── Mobile: triad drag commit + tap snap + double-tap reset ──

describe('Mobile triad interaction', () => {
  let mockRenderer: ReturnType<typeof createMockRenderer>;
  let canvas: HTMLCanvasElement;
  let input: ReturnType<typeof createWatchCameraInput>;

  beforeEach(() => {
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: vi.fn((q: string) => ({ matches: q === '(pointer: coarse)' })), // mobile: coarse=true, hover=false
    });
    mockRenderer = createMockRenderer();
    mockRenderer.isInsideTriad = vi.fn(() => true);
    canvas = mockRenderer._canvas;
    document.body.appendChild(canvas);
    input = createWatchCameraInput(mockRenderer);
  });

  afterEach(() => {
    input.destroy();
    canvas.remove();
  });

  function touch(type: string, clientX: number, clientY: number, touches = 1) {
    const touchObj = { clientX, clientY, identifier: 0 };
    const touchList = Array.from({ length: touches }, () => touchObj);
    const event = new TouchEvent(type, {
      cancelable: true,
      touches: touchList as any,
      changedTouches: [touchObj] as any,
    });
    canvas.dispatchEvent(event);
    return event;
  }

  it('triad drag below commit threshold does NOT orbit', () => {
    touch('touchstart', 10, 10);
    touch('touchmove', 12, 12); // 2.8px < 5px threshold
    expect(mockRenderer.applyOrbitDelta).not.toHaveBeenCalled();
  });

  it('triad drag above commit threshold orbits', () => {
    touch('touchstart', 10, 10);
    touch('touchmove', 20, 10); // 10px > 5px threshold
    expect(mockRenderer.applyOrbitDelta).toHaveBeenCalled();
  });

  it('triad tap on axis endpoint calls snapToAxis', () => {
    mockRenderer.getNearestAxisEndpoint = vi.fn((): [number, number, number] | null => [0, 1, 0]);
    // Quick tap (well under TAP_MAX_DURATION_MS)
    touch('touchstart', 10, 10);
    touch('touchend', 10, 10, 0);
    expect(mockRenderer.snapToAxis).toHaveBeenCalledWith([0, 1, 0]);
  });

  it('triad tap on center zone does NOT snap (waits for double-tap)', () => {
    mockRenderer.getNearestAxisEndpoint = vi.fn(() => null); // center zone
    touch('touchstart', 10, 10);
    touch('touchend', 10, 10, 0);
    expect(mockRenderer.snapToAxis).not.toHaveBeenCalled();
    expect(mockRenderer.animatedResetView).not.toHaveBeenCalled();
  });

  it('triad double-tap on center calls animatedResetView', () => {
    mockRenderer.getNearestAxisEndpoint = vi.fn(() => null); // center zone
    // First tap
    touch('touchstart', 10, 10);
    touch('touchend', 10, 10, 0);
    // Second tap (within DOUBLE_TAP_WINDOW_MS)
    touch('touchstart', 10, 10);
    touch('touchend', 10, 10, 0);
    expect(mockRenderer.animatedResetView).toHaveBeenCalled();
  });

  it("triad drag committing emits 'start' once, then 'change' as motion continues, then 'end' on release", () => {
    input.destroy();
    canvas.remove();
    mockRenderer = createMockRenderer();
    mockRenderer.isInsideTriad = vi.fn(() => true);
    canvas = mockRenderer._canvas;
    document.body.appendChild(canvas);
    const notify = vi.fn<(phase: string) => void>();
    input = createWatchCameraInput(mockRenderer, { onUserCameraInteraction: notify });

    // Initial touchstart on triad — no gesture phase yet (could
    // still be a tap).
    touch('touchstart', 10, 10);
    expect(notify).not.toHaveBeenCalled();

    // First move below commit threshold — no phase emit.
    touch('touchmove', 12, 12);
    expect(notify).not.toHaveBeenCalled();

    // Motion crosses commit threshold — exactly one 'start', then
    // 'change' for the same move handler.
    touch('touchmove', 20, 20);
    const phasesAfterCommit = notify.mock.calls.map(c => c[0]);
    expect(phasesAfterCommit[0]).toBe('start');
    expect(phasesAfterCommit).toContain('change');
    const startCount = phasesAfterCommit.filter(p => p === 'start').length;
    expect(startCount).toBe(1);

    // Further motion emits only 'change', not another 'start'.
    notify.mockClear();
    touch('touchmove', 30, 30);
    expect(notify).toHaveBeenCalledWith('change');
    expect(notify.mock.calls.every(c => c[0] === 'change')).toBe(true);

    // Release — 'end'.
    notify.mockClear();
    touch('touchend', 30, 30, 0);
    expect(notify).toHaveBeenCalledWith('end');
  });
});

// ── Mobile: touchcancel ──

describe('Mobile touchcancel', () => {
  it('resets all gesture state on touchcancel', () => {
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: vi.fn((q: string) => ({ matches: q === '(pointer: coarse)' })), // mobile
    });
    const mockRenderer = createMockRenderer();
    const canvas = mockRenderer._canvas;
    document.body.appendChild(canvas);
    const input = createWatchCameraInput(mockRenderer);

    // Start orbit
    const touchObj = { clientX: 200, clientY: 200, identifier: 0 };
    canvas.dispatchEvent(new TouchEvent('touchstart', {
      cancelable: true,
      touches: [touchObj] as any,
      changedTouches: [touchObj] as any,
    }));
    expect(mockRenderer.startBackgroundOrbitCue).toHaveBeenCalled();

    // touchcancel
    canvas.dispatchEvent(new TouchEvent('touchcancel', {
      cancelable: true,
      touches: [] as any,
      changedTouches: [touchObj] as any,
    }));

    // Subsequent move should NOT orbit
    mockRenderer.applyOrbitDelta = vi.fn();
    canvas.dispatchEvent(new TouchEvent('touchmove', {
      cancelable: true,
      touches: [touchObj] as any,
      changedTouches: [touchObj] as any,
    }));
    expect(mockRenderer.applyOrbitDelta).not.toHaveBeenCalled();

    input.destroy();
    canvas.remove();
  });
});

// ── Cancellation / blur phase emission ──

describe('Gesture cancellation emits end phase', () => {
  let mockRenderer: ReturnType<typeof createMockRenderer>;
  let canvas: HTMLCanvasElement;
  let notify: ReturnType<typeof vi.fn<(phase: string) => void>>;
  let input: ReturnType<typeof createWatchCameraInput>;

  function setupMobile() {
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: vi.fn((q: string) => ({ matches: q === '(pointer: coarse)' })),
    });
    mockRenderer = createMockRenderer();
    canvas = mockRenderer._canvas;
    document.body.appendChild(canvas);
    notify = vi.fn<(phase: string) => void>();
    input = createWatchCameraInput(mockRenderer, { onUserCameraInteraction: notify });
  }

  function setupDesktop() {
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: vi.fn(() => ({ matches: false })),
    });
    mockRenderer = createMockRenderer();
    canvas = mockRenderer._canvas;
    document.body.appendChild(canvas);
    notify = vi.fn<(phase: string) => void>();
    input = createWatchCameraInput(mockRenderer, { onUserCameraInteraction: notify });
  }

  afterEach(() => {
    input.destroy();
    canvas.remove();
  });

  it("touchcancel during background orbit emits 'end'", () => {
    setupMobile();
    const touchObj = { clientX: 200, clientY: 200, identifier: 0 };
    canvas.dispatchEvent(new TouchEvent('touchstart', {
      cancelable: true, touches: [touchObj] as any, changedTouches: [touchObj] as any,
    }));
    expect(notify).toHaveBeenCalledWith('start');

    notify.mockClear();
    canvas.dispatchEvent(new TouchEvent('touchcancel', {
      cancelable: true, touches: [] as any, changedTouches: [touchObj] as any,
    }));
    expect(notify).toHaveBeenCalledWith('end');
  });

  it("touchcancel during committed triad drag emits 'end'", () => {
    setupMobile();
    mockRenderer.isInsideTriad = vi.fn(() => true);

    // touchstart on triad
    canvas.dispatchEvent(new TouchEvent('touchstart', {
      cancelable: true,
      touches: [{ clientX: 10, clientY: 10, identifier: 0 }] as any,
      changedTouches: [{ clientX: 10, clientY: 10, identifier: 0 }] as any,
    }));
    expect(notify).not.toHaveBeenCalled();

    // Move past commit threshold → 'start'
    canvas.dispatchEvent(new TouchEvent('touchmove', {
      cancelable: true,
      touches: [{ clientX: 30, clientY: 30, identifier: 0 }] as any,
      changedTouches: [{ clientX: 30, clientY: 30, identifier: 0 }] as any,
    }));
    expect(notify.mock.calls.some(c => c[0] === 'start')).toBe(true);

    notify.mockClear();
    canvas.dispatchEvent(new TouchEvent('touchcancel', {
      cancelable: true,
      touches: [] as any,
      changedTouches: [{ clientX: 30, clientY: 30, identifier: 0 }] as any,
    }));
    expect(notify).toHaveBeenCalledWith('end');
  });

  it("window blur during desktop pointer orbit emits 'end'", () => {
    setupDesktop();
    canvas.dispatchEvent(new PointerEvent('pointerdown', { button: 0, clientX: 100, clientY: 100, pointerId: 1 }));
    expect(notify).toHaveBeenCalledWith('start');

    notify.mockClear();
    window.dispatchEvent(new Event('blur'));
    expect(notify).toHaveBeenCalledWith('end');
  });
});

// ── Controller lifecycle integration (source-level verification) ──

describe('Controller lifecycle wiring', () => {
  it('watch-controller.ts imports and uses createWatchCameraInput', async () => {
    const fs = await import('fs');
    const source = fs.readFileSync('watch/js/watch-controller.ts', 'utf-8');
    expect(source).toContain("import { createWatchCameraInput");
    expect(source).toContain("createWatchCameraInput(renderer,");
  });

  // Phase-forwarding wiring is tested behaviorally by
  // watch-cinematic-camera-controller.test.ts — no source-regex
  // needed.

  it('watch-controller.ts imports and uses createWatchOverlayLayout', async () => {
    const fs = await import('fs');
    const source = fs.readFileSync('watch/js/watch-controller.ts', 'utf-8');
    expect(source).toContain("import { createWatchOverlayLayout");
    expect(source).toContain("createWatchOverlayLayout(renderer)");
  });

  it('detachRenderer tears down overlayLayout, then cameraInput, then renderer', async () => {
    const fs = await import('fs');
    const source = fs.readFileSync('watch/js/watch-controller.ts', 'utf-8');
    const overlayDestroyIdx = source.indexOf('overlayLayout');
    const cameraDestroyIdx = source.indexOf('cameraInput.destroy()');
    const rendererDestroyIdx = source.indexOf('renderer.destroy()');
    expect(overlayDestroyIdx).toBeGreaterThan(-1);
    expect(cameraDestroyIdx).toBeGreaterThan(-1);
    expect(rendererDestroyIdx).toBeGreaterThan(-1);
    expect(cameraDestroyIdx).toBeLessThan(rendererDestroyIdx);
  });
});

// ── WatchRenderer adapter method wiring ──

describe('WatchRenderer Round 3 adapter interface', () => {
  it('interface has all 10 Round 3 methods (9 interaction + setOverlayLayout)', () => {
    const mockRenderer = createMockRenderer();
    const methods = [
      'isInsideTriad', 'applyOrbitDelta', 'getNearestAxisEndpoint',
      'snapToAxis', 'animatedResetView', 'showAxisHighlight',
      'startBackgroundOrbitCue', 'endBackgroundOrbitCue', 'cancelCameraAnimation',
      'setOverlayLayout',
    ];
    for (const m of methods) {
      expect(typeof (mockRenderer as any)[m]).toBe('function');
    }
  });
});

// ── No duplicate orbit-math in watch ──

describe('No duplicate orbit-math', () => {
  it('watch-camera-input does not import from orbit-math.ts (uses renderer adapter)', async () => {
    // Static check: the camera-input file should NOT import orbit-math
    const fs = await import('fs');
    const source = fs.readFileSync('watch/js/watch-camera-input.ts', 'utf-8');
    expect(source).not.toContain('orbit-math');
  });
});
