/**
 * @vitest-environment jsdom
 */
/**
 * Tests for review-mode touch and pointer routing in the REAL InputManager.
 *
 * Constructs the actual InputManager class with minimal stubs for Canvas,
 * Camera, and AtomSource. Tests drive real _onTouchStart, _onTouchMove,
 * _onTouchEnd, and _onPointerDown methods and assert against real instance
 * fields. This catches regressions in the actual routing logic, not just
 * in a mirror of it.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Stub THREE before importing InputManager
vi.mock('three', () => {
  class Vector3 {
    x = 0; y = 0; z = 0;
    set() { return this; }
    copy() { return this; }
    sub() { return this; }
    normalize() { return this; }
    cross() { return this; }
    dot() { return 0; }
    length() { return 0; }
    multiplyScalar() { return this; }
    add() { return this; }
    applyMatrix4() { return this; }
    project() { return this; }
    unproject() { return this; }
    clone() { return new Vector3(); }
  }
  class Vector2 { x = 0; y = 0; set() { return this; } }
  class Raycaster {
    set() {}
    setFromCamera() {}
    intersectObject() { return []; }
    intersectObjects() { return []; }
  }
  class Matrix4 { elements = new Float32Array(16); }
  return { Vector3, Vector2, Raycaster, Matrix4 };
});

// Stub CONFIG
vi.mock('../../page/js/config', () => ({
  CONFIG: {
    isTouchInteraction: () => true, // simulate mobile
    orbit: { rotateSpeed: 0.01 },
    picker: { mobileExpansion: 0.15, desktopExpansion: 0.08, previewAtomPreference: 0.5 },
    camera: { freeLookEnabled: false },
    freeLook: {},
    debug: { input: false },
  },
}));

import { InputManager } from '../../page/js/input';

function createRealInputManager() {
  // Minimal canvas stub
  const canvas = document.createElement('canvas');
  canvas.getBoundingClientRect = () => ({ x: 0, y: 0, width: 800, height: 600, top: 0, left: 0, right: 800, bottom: 600, toJSON: () => '' });
  canvas.setPointerCapture = vi.fn();
  canvas.releasePointerCapture = vi.fn();

  // Minimal camera stub
  const camera = { matrixWorldInverse: { elements: new Float32Array(16) }, projectionMatrix: { elements: new Float32Array(16) } } as any;

  // Atom source that always returns -1 (no atoms) unless overridden
  const atomSource = { count: 0, getWorldPosition: vi.fn(), raycastTarget: null };

  const cb = {
    onHover: vi.fn(),
    onPointerDown: vi.fn(),
    onPointerMove: vi.fn(),
    onPointerUp: vi.fn(),
  };

  const mgr = new InputManager(canvas, camera, atomSource, cb);

  // Override _raycastAtom to control atom hits
  let atomUnderCursor = -1;
  (mgr as any)._raycastAtom = () => atomUnderCursor;

  const orbitStartFn = vi.fn();
  const orbitEndFn = vi.fn();
  const orbitDeltaFn = vi.fn();

  mgr.setTriadSource({
    isInsideTriad: (x: number) => x < 50,
    applyOrbitDelta: orbitDeltaFn,
    applyFreeLookDelta: vi.fn(),
    applyFreeLookZoom: vi.fn(),
    applyFreeLookTranslate: vi.fn(),
    onBackgroundOrbitStart: orbitStartFn,
    onBackgroundOrbitEnd: orbitEndFn,
    getNearestAxisEndpoint: vi.fn(),
    snapToAxis: vi.fn(),
    animatedResetView: vi.fn(),
    showAxisHighlight: vi.fn(),
    onReturnToOrbit: vi.fn(),
    onFreeLookFocusSelect: vi.fn(),
    resetOrientation: vi.fn(),
    cancelCameraAnimation: vi.fn(),
    freezeFlight: vi.fn(),
    onTriadDragEnd: vi.fn(),
  });

  return {
    mgr,
    cb,
    canvas,
    orbitStartFn,
    orbitEndFn,
    orbitDeltaFn,
    setAtomUnderCursor: (idx: number) => { atomUnderCursor = idx; },
    setReviewMode: (review: boolean) => {
      mgr.setScenePolicyGetter(() => ({ allowAtomInteraction: !review }));
    },
  };
}

function makeTouchEvent(type: string, clientX: number, clientY: number): TouchEvent {
  const touch = { clientX, clientY, identifier: 0, target: null } as any;
  return {
    type,
    touches: type === 'touchend' ? [] : [touch],
    changedTouches: [touch],
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
  } as any;
}

function makePointerEvent(button: number, clientX: number, clientY: number): PointerEvent {
  return {
    type: 'pointerdown',
    button,
    clientX,
    clientY,
    pointerId: 1,
    isPrimary: true,
    pointerType: 'mouse',
    ctrlKey: false,
    metaKey: false,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
  } as any;
}

// ── Touch tests ──

describe('Real InputManager — review touch routing', () => {
  let ctx: ReturnType<typeof createRealInputManager>;

  beforeEach(() => {
    ctx = createRealInputManager();
  });

  it('review + touch + atom → camera orbit, not atom drag', () => {
    ctx.setReviewMode(true);
    ctx.setAtomUnderCursor(5);
    (ctx.mgr as any)._onTouchStart(makeTouchEvent('touchstart', 200, 200));
    expect(ctx.mgr.isCamera).toBe(true);
    expect(ctx.mgr.isDragging).toBe(false);
    expect(ctx.cb.onPointerDown).not.toHaveBeenCalled();
    expect(ctx.orbitStartFn).toHaveBeenCalled();
  });

  it('review + touch + empty space → camera orbit', () => {
    ctx.setReviewMode(true);
    ctx.setAtomUnderCursor(-1);
    (ctx.mgr as any)._onTouchStart(makeTouchEvent('touchstart', 200, 200));
    expect(ctx.mgr.isCamera).toBe(true);
    expect(ctx.orbitStartFn).toHaveBeenCalled();
  });

  it('live + touch + atom → atom drag', () => {
    ctx.setReviewMode(false);
    ctx.setAtomUnderCursor(5);
    (ctx.mgr as any)._onTouchStart(makeTouchEvent('touchstart', 200, 200));
    expect(ctx.mgr.isDragging).toBe(true);
    expect(ctx.mgr.isCamera).toBe(false);
    expect(ctx.cb.onPointerDown).toHaveBeenCalled();
  });

  it('review + triad touch → triad wins', () => {
    ctx.setReviewMode(true);
    ctx.setAtomUnderCursor(-1);
    (ctx.mgr as any)._onTouchStart(makeTouchEvent('touchstart', 30, 30)); // inside triad
    expect(ctx.mgr.isTriadDragging).toBe(true);
    expect(ctx.mgr.isCamera).toBe(false);
    expect(ctx.orbitStartFn).not.toHaveBeenCalled();
  });

  it('review touch clears pre-existing state', () => {
    ctx.setReviewMode(true);
    ctx.setAtomUnderCursor(5);
    (ctx.mgr as any)._onTouchStart(makeTouchEvent('touchstart', 200, 200));
    expect(ctx.mgr.isDragging).toBe(false);
    expect(ctx.mgr.isTriadDragging).toBe(false);
  });
});

describe('Real InputManager — review touch orbit lifecycle', () => {
  let ctx: ReturnType<typeof createRealInputManager>;

  beforeEach(() => {
    ctx = createRealInputManager();
    ctx.setReviewMode(true);
    ctx.setAtomUnderCursor(5);
  });

  it('touch move calls applyOrbitDelta', () => {
    (ctx.mgr as any)._onTouchStart(makeTouchEvent('touchstart', 200, 200));
    (ctx.mgr as any)._onTouchMove(makeTouchEvent('touchmove', 210, 205));
    expect(ctx.orbitDeltaFn).toHaveBeenCalled();
  });

  it('touch move does NOT call onPointerMove', () => {
    (ctx.mgr as any)._onTouchStart(makeTouchEvent('touchstart', 200, 200));
    (ctx.mgr as any)._onTouchMove(makeTouchEvent('touchmove', 210, 205));
    expect(ctx.cb.onPointerMove).not.toHaveBeenCalled();
  });

  it('touch end calls onBackgroundOrbitEnd and resets isCamera', () => {
    (ctx.mgr as any)._onTouchStart(makeTouchEvent('touchstart', 200, 200));
    (ctx.mgr as any)._onTouchEnd(makeTouchEvent('touchend', 200, 200));
    expect(ctx.orbitEndFn).toHaveBeenCalled();
    expect(ctx.mgr.isCamera).toBe(false);
  });

  it('touch end does NOT call onPointerUp', () => {
    (ctx.mgr as any)._onTouchStart(makeTouchEvent('touchstart', 200, 200));
    (ctx.mgr as any)._onTouchEnd(makeTouchEvent('touchend', 200, 200));
    expect(ctx.cb.onPointerUp).not.toHaveBeenCalled();
  });
});

// ── Desktop tests ──

describe('Real InputManager — review desktop left-click routing', () => {
  let ctx: ReturnType<typeof createRealInputManager>;

  beforeEach(() => {
    ctx = createRealInputManager();
  });

  it('review + left-click + atom → camera orbit with lifecycle hooks', () => {
    ctx.setReviewMode(true);
    ctx.setAtomUnderCursor(5);
    (ctx.mgr as any)._onPointerDown(makePointerEvent(0, 200, 200));
    expect(ctx.mgr.isCamera).toBe(true);
    expect(ctx.mgr.isDragging).toBe(false);
    expect(ctx.cb.onPointerDown).not.toHaveBeenCalled();
    expect(ctx.orbitStartFn).toHaveBeenCalled();
    expect(ctx.canvas.setPointerCapture).toHaveBeenCalled();
  });

  it('live + left-click + atom → atom drag', () => {
    ctx.setReviewMode(false);
    ctx.setAtomUnderCursor(5);
    (ctx.mgr as any)._onPointerDown(makePointerEvent(0, 200, 200));
    expect(ctx.mgr.isDragging).toBe(true);
    expect(ctx.mgr.isCamera).toBe(false);
    expect(ctx.cb.onPointerDown).toHaveBeenCalled();
  });

  it('review + left-click + empty space → camera orbit', () => {
    ctx.setReviewMode(true);
    ctx.setAtomUnderCursor(-1);
    (ctx.mgr as any)._onPointerDown(makePointerEvent(0, 200, 200));
    expect(ctx.mgr.isCamera).toBe(true);
    expect(ctx.mgr.isDragging).toBe(false);
    expect(ctx.orbitStartFn).toHaveBeenCalled();
  });
});
