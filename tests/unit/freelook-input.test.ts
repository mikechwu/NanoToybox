/**
 * @vitest-environment jsdom
 */
/**
 * Integration tests for Free-Look input pipeline.
 *
 * These test the cross-layer composition that changed in Phase 3:
 * - Free-Look atom click/tap bypasses state machine (no DRAG state)
 * - Focus-select fires directly from InputManager (not dispatch)
 * - Wheel zoom routes to applyFreeLookZoom in Free-Look
 * - Triad double-tap center returns to orbit in Free-Look
 * - R key fires resetOrientation in Free-Look
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as THREE from 'three';

// Mock matchMedia before importing InputManager (uses CONFIG.isTouchInteraction)
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
});

import { InputManager } from '../../page/js/input';

// Minimal stubs for InputManager construction
function makeCanvas() {
  const canvas = document.createElement('canvas');
  // Mock getBoundingClientRect for NDC conversion
  canvas.getBoundingClientRect = () => ({
    left: 0, top: 0, width: 800, height: 600,
    right: 800, bottom: 600, x: 0, y: 0, toJSON: () => ({}),
  });
  return canvas;
}

function makeCamera() {
  const cam = new THREE.PerspectiveCamera(60, 800 / 600, 0.1, 1000);
  cam.position.set(0, 0, 20);
  cam.updateMatrixWorld(true);
  return cam;
}

function makeAtomSource(count = 0) {
  return {
    count,
    getWorldPosition: vi.fn((_i, out) => out.set(0, 0, 0)),
    raycastTarget: null as THREE.Object3D | null,
  };
}

function makeCallbacks() {
  return {
    onPointerDown: vi.fn(),
    onPointerMove: vi.fn(),
    onPointerUp: vi.fn(),
    onHover: vi.fn(),
  };
}

function makeTriadSource() {
  return {
    isInsideTriad: vi.fn(() => false),
    applyOrbitDelta: vi.fn(),
    applyFreeLookDelta: vi.fn(),
    applyFreeLookZoom: vi.fn(),
    applyFreeLookTranslate: vi.fn(),
    onBackgroundOrbitStart: vi.fn(),
    onBackgroundOrbitEnd: vi.fn(),
    getNearestAxisEndpoint: vi.fn(() => null),
    snapToAxis: vi.fn(),
    animatedResetView: vi.fn(),
    showAxisHighlight: vi.fn(),
    onReturnToOrbit: vi.fn(),
    onFreeLookFocusSelect: vi.fn(),
    resetOrientation: vi.fn(),
    onTriadDragEnd: vi.fn(),
    cancelCameraAnimation: vi.fn(),
    freezeFlight: vi.fn(),
  };
}

describe('Free-Look input pipeline', () => {
  let canvas: HTMLCanvasElement;
  let camera: THREE.PerspectiveCamera;
  let callbacks: ReturnType<typeof makeCallbacks>;
  let triadSource: ReturnType<typeof makeTriadSource>;
  let im: InputManager;

  beforeEach(() => {
    canvas = makeCanvas();
    camera = makeCamera();
    callbacks = makeCallbacks();
    triadSource = makeTriadSource();
  });

  /** Create a KeyboardEvent with canvas as target (non-interactive element). */
  function canvasKey(key: string, opts: KeyboardEventInit = {}) {
    const evt = new KeyboardEvent('keydown', { key, ...opts });
    Object.defineProperty(evt, 'target', { value: canvas });
    return evt;
  }

  /** Create a KeyboardEvent with code + canvas target (for physical key testing). */
  function canvasCode(code: string, opts: KeyboardEventInit = {}) {
    const evt = new KeyboardEvent('keydown', { code, ...opts });
    Object.defineProperty(evt, 'target', { value: canvas });
    return evt;
  }

  afterEach(() => {
    im?.destroy();
  });

  function createManager(atomCount = 0) {
    im = new InputManager(canvas, camera, makeAtomSource(atomCount), callbacks);
    im.setTriadSource(triadSource);
    return im;
  }

  // ── Desktop: Free-Look left-click on atom ──

  describe('desktop Free-Look left-click on atom', () => {
    it('does not set isDragging or call onPointerDown', () => {
      createManager(10);
      im.setCameraStateGetter(() => 'freelook');

      // Mock raycast to hit atom 5
      im._raycastAtom = vi.fn(() => 5);

      // Simulate left-click
      const downEvent = new PointerEvent('pointerdown', { button: 0, clientX: 400, clientY: 300 });
      im._onPointerDown(downEvent);

      expect(im.isDragging).toBe(false);
      expect(callbacks.onPointerDown).not.toHaveBeenCalled();
      expect(triadSource.onFreeLookFocusSelect).toHaveBeenCalledWith(5);
    });

    it('subsequent pointerUp does not call onPointerUp (no dangling state)', () => {
      createManager(10);
      im.setCameraStateGetter(() => 'freelook');
      im._raycastAtom = vi.fn(() => 5);

      im._onPointerDown(new PointerEvent('pointerdown', { button: 0 }));
      im._onPointerUp(new PointerEvent('pointerup', { button: 0 }));

      expect(callbacks.onPointerUp).not.toHaveBeenCalled();
    });

    it('in Orbit mode, same click DOES set isDragging and calls onPointerDown', () => {
      createManager(10);
      im.setCameraStateGetter(() => 'orbit');
      im._raycastAtom = vi.fn(() => 5);

      im._onPointerDown(new PointerEvent('pointerdown', { button: 0, clientX: 400, clientY: 300 }));

      expect(im.isDragging).toBe(true);
      expect(callbacks.onPointerDown).toHaveBeenCalledWith(5, 400, 300, false);
      expect(triadSource.onFreeLookFocusSelect).not.toHaveBeenCalled();
    });
  });

  // ── Mobile: Free-Look touch on atom ──

  describe('mobile Free-Look touch on atom', () => {
    it('does not set isDragging or call onPointerDown', () => {
      // Force mobile path
      Object.defineProperty(im = new InputManager(canvas, camera, makeAtomSource(10), callbacks), 'isMobile', { value: true });
      im.setTriadSource(triadSource);
      im.setCameraStateGetter(() => 'freelook');
      im._raycastAtom = vi.fn(() => 3);

      // Simulate touch start on atom
      const touch = { clientX: 400, clientY: 300, identifier: 0 };
      const touchEvent = { touches: [touch], preventDefault: vi.fn() } as any;
      im._onTouchStart(touchEvent);

      expect(im.isDragging).toBe(false);
      expect(callbacks.onPointerDown).not.toHaveBeenCalled();
      expect(triadSource.onFreeLookFocusSelect).toHaveBeenCalledWith(3);
    });

    it('subsequent touchMove does not forward to onPointerMove', () => {
      Object.defineProperty(im = new InputManager(canvas, camera, makeAtomSource(10), callbacks), 'isMobile', { value: true });
      im.setTriadSource(triadSource);
      im.setCameraStateGetter(() => 'freelook');
      im._raycastAtom = vi.fn(() => 3);

      im._onTouchStart({ touches: [{ clientX: 400, clientY: 300, identifier: 0 }], preventDefault: vi.fn() } as any);
      im._onTouchMove({ touches: [{ clientX: 410, clientY: 310, identifier: 0 }], preventDefault: vi.fn() } as any);

      expect(callbacks.onPointerMove).not.toHaveBeenCalled();
    });

    it('subsequent touchEnd does not forward to onPointerUp', () => {
      Object.defineProperty(im = new InputManager(canvas, camera, makeAtomSource(10), callbacks), 'isMobile', { value: true });
      im.setTriadSource(triadSource);
      im.setCameraStateGetter(() => 'freelook');
      im._raycastAtom = vi.fn(() => 3);

      im._onTouchStart({ touches: [{ clientX: 400, clientY: 300, identifier: 0 }], preventDefault: vi.fn() } as any);
      im._onTouchEnd({ touches: [], preventDefault: vi.fn() } as any);

      expect(callbacks.onPointerUp).not.toHaveBeenCalled();
    });
  });

  // ── Wheel zoom routing ──

  describe('scroll wheel routing', () => {
    it('in Free-Look, wheel calls applyFreeLookZoom', () => {
      createManager();
      im.setCameraStateGetter(() => 'freelook');

      const wheelEvent = new WheelEvent('wheel', { deltaY: 100 });
      // The handler is bound to canvas — call it directly
      im._handlers.wheel(wheelEvent);

      expect(triadSource.applyFreeLookZoom).toHaveBeenCalledWith(100);
    });

    it('in Orbit, wheel does NOT call applyFreeLookZoom', () => {
      createManager();
      im.setCameraStateGetter(() => 'orbit');

      im._handlers.wheel(new WheelEvent('wheel', { deltaY: 100 }));

      expect(triadSource.applyFreeLookZoom).not.toHaveBeenCalled();
    });
  });

  // ── Triad double-tap center mode-aware ──

  describe('triad double-tap center', () => {
    it('in Free-Look, calls onReturnToOrbit before animatedResetView', () => {
      createManager();
      im.setCameraStateGetter(() => 'freelook');
      triadSource.isInsideTriad.mockReturnValue(true);
      triadSource.getNearestAxisEndpoint.mockReturnValue(null); // center zone

      // First tap
      im.isTriadDragging = true;
      im._triadDragCommitted = false;
      im._triadTouchStartTime = performance.now();
      im._triadLastX = 400;
      im._triadLastY = 300;
      im._triadLastTapTime = 0;
      im._triadLastTapWasCenter = false;

      im._onTouchEnd({ touches: [], preventDefault: vi.fn() } as any);

      // Second tap (double-tap)
      im.isTriadDragging = true;
      im._triadDragCommitted = false;
      im._triadTouchStartTime = performance.now();

      im._onTouchEnd({ touches: [], preventDefault: vi.fn() } as any);

      expect(triadSource.onReturnToOrbit).toHaveBeenCalled();
      expect(triadSource.animatedResetView).toHaveBeenCalled();
    });

    it('in Orbit, double-tap center does NOT call onReturnToOrbit', () => {
      createManager();
      im.setCameraStateGetter(() => 'orbit');
      triadSource.isInsideTriad.mockReturnValue(true);
      triadSource.getNearestAxisEndpoint.mockReturnValue(null);

      // First tap
      im.isTriadDragging = true;
      im._triadDragCommitted = false;
      im._triadTouchStartTime = performance.now();
      im._triadLastTapTime = 0;
      im._triadLastTapWasCenter = false;

      im._onTouchEnd({ touches: [], preventDefault: vi.fn() } as any);

      // Second tap
      im.isTriadDragging = true;
      im._triadDragCommitted = false;
      im._triadTouchStartTime = performance.now();

      im._onTouchEnd({ touches: [], preventDefault: vi.fn() } as any);

      expect(triadSource.onReturnToOrbit).not.toHaveBeenCalled();
      expect(triadSource.animatedResetView).toHaveBeenCalled();
    });
  });

  // ── R key resets orientation ──

  describe('R key in Free-Look', () => {
    it('calls resetOrientation', () => {
      createManager();
      im.setCameraStateGetter(() => 'freelook');

      im._handlers.keydown(canvasCode('KeyR'));

      expect(triadSource.resetOrientation).toHaveBeenCalled();
    });

    it('in Orbit, R key does nothing', () => {
      createManager();
      im.setCameraStateGetter(() => 'orbit');

      im._handlers.keydown(canvasCode('KeyR'));

      expect(triadSource.resetOrientation).not.toHaveBeenCalled();
    });
  });

  // ── WASD translation ──

  describe('WASD keys in Free-Look (key-tracking set)', () => {
    it.each([
      ['KeyW', 0, 1],
      ['KeyS', 0, -1],
      ['KeyA', -1, 0],
      ['KeyD', 1, 0],
    ])('%s adds to pressedKeys and getFlightInput returns (%d, %d)', (code, expectedX, expectedZ) => {
      createManager();
      im.setCameraStateGetter(() => 'freelook');

      im._handlers.keydown(canvasCode(code as string));

      expect(im._pressedKeys.has(code as string)).toBe(true);
      const input = im.getFlightInput();
      expect(input.x).toBe(expectedX);
      expect(input.z).toBe(expectedZ);
    });

    it('keyup removes from pressedKeys', () => {
      createManager();
      im.setCameraStateGetter(() => 'freelook');

      im._handlers.keydown(canvasCode('KeyW'));
      expect(im._pressedKeys.has('KeyW')).toBe(true);

      im._handlers.keyup(new KeyboardEvent('keyup', { code: 'KeyW' }));
      expect(im._pressedKeys.has('KeyW')).toBe(false);
      expect(im.getFlightInput()).toEqual({ x: 0, z: 0 });
    });

    it('WASD in Orbit does not add to pressedKeys', () => {
      createManager();
      im.setCameraStateGetter(() => 'orbit');

      for (const code of ['KeyW', 'KeyA', 'KeyS', 'KeyD']) {
        im._handlers.keydown(canvasCode(code));
      }

      expect(im._pressedKeys.size).toBe(0);
    });
  });

  // ── Keyboard suppression when form controls are focused ──

  describe('keyboard suppression', () => {
    it('ignores WASD when an <input> is focused', () => {
      createManager();
      im.setCameraStateGetter(() => 'freelook');
      const input = document.createElement('input');
      document.body.appendChild(input);

      // Canvas-targeted key works
      im._handlers.keydown(canvasCode('KeyW'));
      expect(im._pressedKeys.has('KeyW')).toBe(true);

      im._pressedKeys.clear();
      // Input-targeted key is suppressed
      const evt = new KeyboardEvent('keydown', { code: 'KeyW' });
      Object.defineProperty(evt, 'target', { value: input });
      im._handlers.keydown(evt);
      expect(im._pressedKeys.has('KeyW')).toBe(false);

      document.body.removeChild(input);
    });

    it('ignores R when a <textarea> is focused', () => {
      createManager();
      im.setCameraStateGetter(() => 'freelook');
      const textarea = document.createElement('textarea');

      const evt = new KeyboardEvent('keydown', { code: 'KeyR' });
      Object.defineProperty(evt, 'target', { value: textarea });
      im._handlers.keydown(evt);
      expect(triadSource.resetOrientation).not.toHaveBeenCalled();
    });

    it('ignores WASD when metaKey is held', () => {
      createManager();
      im.setCameraStateGetter(() => 'freelook');

      im._handlers.keydown(canvasKey('w', { metaKey: true }));
      expect(im._pressedKeys.size).toBe(0);
    });

    it('ignores WASD when ctrlKey is held', () => {
      createManager();
      im.setCameraStateGetter(() => 'freelook');

      im._handlers.keydown(canvasKey('a', { ctrlKey: true }));
      expect(im._pressedKeys.size).toBe(0);
    });

    it('ignores WASD when altKey is held', () => {
      createManager();
      im.setCameraStateGetter(() => 'freelook');

      im._handlers.keydown(canvasKey('d', { altKey: true }));
      expect(im._pressedKeys.size).toBe(0);
    });

    it('ignores WASD when a <select> is focused', () => {
      createManager();
      im.setCameraStateGetter(() => 'freelook');
      const select = document.createElement('select');

      const evt = new KeyboardEvent('keydown', { code: 'KeyW' });
      Object.defineProperty(evt, 'target', { value: select });
      im._handlers.keydown(evt);
      expect(im._pressedKeys.size).toBe(0);
    });

    it('ignores R when target is contentEditable', () => {
      createManager();
      im.setCameraStateGetter(() => 'freelook');
      const div = document.createElement('div');
      div.contentEditable = 'true';
      document.body.appendChild(div);
      // jsdom may not auto-set isContentEditable, so ensure it reads correctly
      Object.defineProperty(div, 'isContentEditable', { value: true, configurable: true });

      const evt = new KeyboardEvent('keydown', { code: 'KeyR' });
      Object.defineProperty(evt, 'target', { value: div });
      im._handlers.keydown(evt);
      expect(triadSource.resetOrientation).not.toHaveBeenCalled();
      expect(im._pressedKeys.size).toBe(0);

      document.body.removeChild(div);
    });

    it('ignores WASD when a <button> is focused', () => {
      createManager();
      im.setCameraStateGetter(() => 'freelook');
      const btn = document.createElement('button');

      const evt = new KeyboardEvent('keydown', { code: 'KeyW' });
      Object.defineProperty(evt, 'target', { value: btn });
      im._handlers.keydown(evt);
      expect(im._pressedKeys.size).toBe(0);
    });

    it('ignores WASD when target has role="button"', () => {
      createManager();
      im.setCameraStateGetter(() => 'freelook');
      const span = document.createElement('span');
      span.setAttribute('role', 'button');

      const evt = new KeyboardEvent('keydown', { code: 'KeyA' });
      Object.defineProperty(evt, 'target', { value: span });
      im._handlers.keydown(evt);
      expect(im._pressedKeys.size).toBe(0);
    });

    it('ignores WASD when target is inside [data-camera-controls]', () => {
      createManager();
      im.setCameraStateGetter(() => 'freelook');
      const wrapper = document.createElement('div');
      wrapper.setAttribute('data-camera-controls', '');
      const child = document.createElement('span');
      wrapper.appendChild(child);
      document.body.appendChild(wrapper);

      const evt = new KeyboardEvent('keydown', { code: 'KeyS' });
      Object.defineProperty(evt, 'target', { value: child });
      im._handlers.keydown(evt);
      expect(im._pressedKeys.size).toBe(0);

      document.body.removeChild(wrapper);
    });

    it('ignores WASD when target is inside .sheet', () => {
      createManager();
      im.setCameraStateGetter(() => 'freelook');
      const sheet = document.createElement('div');
      sheet.className = 'sheet';
      const child = document.createElement('span');
      sheet.appendChild(child);
      document.body.appendChild(sheet);

      const evt = new KeyboardEvent('keydown', { code: 'KeyD' });
      Object.defineProperty(evt, 'target', { value: child });
      im._handlers.keydown(evt);
      expect(im._pressedKeys.size).toBe(0);

      document.body.removeChild(sheet);
    });
  });

  // ── Triad mode-gating in Free-Look ──

  describe('triad behavior in Free-Look', () => {
    it('triad drag routes to applyFreeLookDelta, not applyOrbitDelta', () => {
      createManager();
      im.setCameraStateGetter(() => 'freelook');
      triadSource.isInsideTriad.mockReturnValue(true);

      // Set up triad dragging state (simulating committed drag)
      im.isTriadDragging = true;
      im._triadDragCommitted = true;
      im._triadLastX = 400;
      im._triadLastY = 300;
      im._triadTouchStartX = 390;
      im._triadTouchStartY = 290;

      // Simulate touch move
      im._onTouchMove({
        touches: [{ clientX: 410, clientY: 310 }],
        preventDefault: vi.fn(),
      } as any);

      expect(triadSource.applyFreeLookDelta).toHaveBeenCalledWith(10, 10);
      expect(triadSource.applyOrbitDelta).not.toHaveBeenCalled();
    });

    it('triad drag routes to applyOrbitDelta in Orbit', () => {
      createManager();
      im.setCameraStateGetter(() => 'orbit');

      im.isTriadDragging = true;
      im._triadDragCommitted = true;
      im._triadLastX = 400;
      im._triadLastY = 300;

      im._onTouchMove({
        touches: [{ clientX: 410, clientY: 310 }],
        preventDefault: vi.fn(),
      } as any);

      expect(triadSource.applyOrbitDelta).toHaveBeenCalledWith(10, 10);
      expect(triadSource.applyFreeLookDelta).not.toHaveBeenCalled();
    });

    it('axis-snap tap is disabled in Free-Look', () => {
      createManager();
      im.setCameraStateGetter(() => 'freelook');
      const axisDir = new THREE.Vector3(1, 0, 0);
      triadSource.getNearestAxisEndpoint.mockReturnValue(axisDir);

      // Simulate tap on axis endpoint
      im.isTriadDragging = true;
      im._triadDragCommitted = false;
      im._triadTouchStartTime = performance.now();
      im._triadLastX = 400;
      im._triadLastY = 300;
      im._triadLastTapTime = 0;
      im._triadLastTapWasCenter = false;

      im._onTouchEnd({ touches: [], preventDefault: vi.fn() } as any);

      expect(triadSource.snapToAxis).not.toHaveBeenCalled();
    });

    it('axis-snap tap works in Orbit', () => {
      createManager();
      im.setCameraStateGetter(() => 'orbit');
      const axisDir = new THREE.Vector3(1, 0, 0);
      triadSource.getNearestAxisEndpoint.mockReturnValue(axisDir);

      im.isTriadDragging = true;
      im._triadDragCommitted = false;
      im._triadTouchStartTime = performance.now();
      im._triadLastX = 400;
      im._triadLastY = 300;
      im._triadLastTapTime = 0;
      im._triadLastTapWasCenter = false;

      im._onTouchEnd({ touches: [], preventDefault: vi.fn() } as any);

      expect(triadSource.snapToAxis).toHaveBeenCalledWith(axisDir);
    });
  });

  // ── onTriadDragEnd lifecycle ──

  describe('onTriadDragEnd', () => {
    it('fires when a committed triad drag ends', () => {
      createManager();
      im.isTriadDragging = true;
      im._triadDragCommitted = true;
      im._triadTouchStartTime = performance.now();

      im._onTouchEnd({ touches: [], preventDefault: vi.fn() } as any);

      expect(triadSource.onTriadDragEnd).toHaveBeenCalled();
    });

    it('does not fire on tap (uncommitted drag)', () => {
      createManager();
      triadSource.getNearestAxisEndpoint.mockReturnValue(null);
      im.isTriadDragging = true;
      im._triadDragCommitted = false;
      im._triadTouchStartTime = performance.now();
      im._triadLastTapTime = 0;
      im._triadLastTapWasCenter = false;

      im._onTouchEnd({ touches: [], preventDefault: vi.fn() } as any);

      expect(triadSource.onTriadDragEnd).not.toHaveBeenCalled();
    });

    it('does not fire on touchCancel (system interruption)', () => {
      createManager();
      im.isTriadDragging = true;
      im._triadDragCommitted = true;

      im._onTouchCancel({ touches: [] } as any);

      expect(triadSource.onTriadDragEnd).not.toHaveBeenCalled();
      expect(im.isTriadDragging).toBe(false);
    });

    it('does not fire on multi-touch interruption (finger-count escalation)', () => {
      createManager();
      triadSource.isInsideTriad.mockReturnValue(true);
      im.isTriadDragging = true;
      im._triadDragCommitted = true;

      // 2-finger touch cancels triad drag
      im._onTouchStart({
        touches: [
          { clientX: 400, clientY: 300, identifier: 0 },
          { clientX: 410, clientY: 310, identifier: 1 },
        ],
        preventDefault: vi.fn(),
      } as any);

      expect(triadSource.onTriadDragEnd).not.toHaveBeenCalled();
      expect(im.isTriadDragging).toBe(false);
    });
  });

  // ── Full gesture paths for achievement callbacks ──

  describe('full gesture path: background orbit', () => {
    it('background orbit lifecycle fires onBackgroundOrbitEnd', () => {
      createManager();
      im.setCameraStateGetter(() => 'orbit');
      triadSource.isInsideTriad.mockReturnValue(false);
      im._raycastAtom = vi.fn(() => -1); // no atom hit

      // Start: touch on empty space
      im._onTouchStart({
        touches: [{ clientX: 400, clientY: 300, identifier: 0 }],
        preventDefault: vi.fn(),
      } as any);
      expect(im.isCamera).toBe(true);

      // End: lift finger
      im._onTouchEnd({ touches: [], preventDefault: vi.fn() } as any);

      expect(triadSource.onBackgroundOrbitEnd).toHaveBeenCalled();
    });
  });

  describe('full gesture path: triad drag', () => {
    it('triad drag lifecycle fires onTriadDragEnd', () => {
      createManager();
      im.setCameraStateGetter(() => 'orbit');
      triadSource.isInsideTriad.mockReturnValue(true);

      // Start: touch inside triad
      im._onTouchStart({
        touches: [{ clientX: 400, clientY: 300, identifier: 0 }],
        preventDefault: vi.fn(),
      } as any);
      expect(im.isTriadDragging).toBe(true);

      // Move: exceed 5px threshold to commit drag
      im._onTouchMove({
        touches: [{ clientX: 420, clientY: 320, identifier: 0 }],
        preventDefault: vi.fn(),
      } as any);
      expect(im._triadDragCommitted).toBe(true);

      // End: lift finger
      im._onTouchEnd({ touches: [], preventDefault: vi.fn() } as any);

      expect(triadSource.onTriadDragEnd).toHaveBeenCalled();
    });
  });
});
