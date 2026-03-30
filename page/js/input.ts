/**
 * Unified input handler — normalizes desktop and mobile events
 * into canonical events for the state machine.
 *
 * Desktop: left-click = interact, right-click = camera, scroll = zoom
 * Mobile:  1-finger = interact, 2-finger = camera (pinch/pan)
 *
 * Atom picking uses an atom-source abstraction, not direct mesh references.
 * The atom source provides { count, getWorldPosition(i, outVec3), raycastTarget }.
 */
import * as THREE from 'three';
import { CONFIG } from './config';

const DEBUG_INPUT = CONFIG.debug.input;

export class InputManager {
  canvas: HTMLCanvasElement;
  camera: THREE.Camera;
  _atomSource: {
    count: number;
    getWorldPosition: (i: number, out: THREE.Vector3) => THREE.Vector3;
    raycastTarget: THREE.Object3D | THREE.InstancedMesh | null;
  };
  cb: {
    onPointerDown?: (atomIdx: number, x: number, y: number, isRotate: boolean) => void;
    onPointerMove?: (x: number, y: number) => void;
    onPointerUp?: () => void;
    onHover?: (atomIdx: number) => void;
  };
  raycaster: THREE.Raycaster;
  isMobile: boolean;
  isDragging: boolean;
  isCamera: boolean;
  isTriadDragging: boolean;
  _triadLastX: number;
  _triadLastY: number;
  // Background orbit position tracking (same approach as triad drag)
  _bgOrbitLastX: number;
  _bgOrbitLastY: number;
  _cameraPointerId: number; // stored for pointer capture release in blur handler
  _triadSource: {
    isInsideTriad: (clientX: number, clientY: number) => boolean;
    applyOrbitDelta: (dx: number, dy: number) => void;
    applyFreeLookDelta?: (dx: number, dy: number) => void;
    applyFreeLookZoom?: (delta: number) => void;
    applyFreeLookTranslate?: (dx: number, dy: number) => void;
    onBackgroundOrbitStart?: () => void;
    onBackgroundOrbitEnd?: () => void;
    getNearestAxisEndpoint?: (clientX: number, clientY: number) => THREE.Vector3 | null;
    snapToAxis?: (dir: THREE.Vector3) => void;
    animatedResetView?: () => void;
    showAxisHighlight?: (dir: THREE.Vector3 | null) => void;
    onReturnToOrbit?: () => void;
    onFreeLookFocusSelect?: (atomIdx: number) => void;
    resetOrientation?: () => void;
    /** Fires when a committed triad drag ends (not on taps or canceled gestures). */
    onTriadDragEnd?: () => void;
    cancelCameraAnimation?: () => void;
    freezeFlight?: () => void;
  } | null;

  // Camera mode getter (injected from store, not read from triad source)
  _getCameraMode: () => 'orbit' | 'freelook';
  // Scene interaction policy getter (injected from input-bindings)
  _getScenePolicy: () => { allowAtomInteraction: boolean };

  // Key-tracking set for Free-Look flight (replaces key-repeat approach)
  _pressedKeys: Set<string>;

  // Triad tap/double-tap/drag discrimination
  _triadTouchStartTime: number;
  _triadTouchStartX: number;
  _triadTouchStartY: number;
  _triadLastTapTime: number;
  _triadLastTapWasCenter: boolean;
  _triadDragCommitted: boolean; // true once movement exceeds 5px — enables orbit delta
  _triadTapIntentTimer: ReturnType<typeof setTimeout> | null;
  _scratchVec3: THREE.Vector3;
  _scratchProjected: THREE.Vector3;
  _scratchNDC: THREE.Vector2;
  _scratchRayOrigin: THREE.Vector3;
  _scratchRayDir: THREE.Vector3;
  _scratchPlaneNormal: THREE.Vector3;
  _scratchDiff: THREE.Vector3;
  _scratchResult: number[];
  _handlers: Record<string, (e: Event) => void>;

  /**
   * @param {HTMLCanvasElement} canvas
   * @param {THREE.Camera} camera
   * @param {object} atomSource - { count: number, getWorldPosition(i, outVec3): Vector3, raycastTarget: THREE.Object3D[] | THREE.InstancedMesh }
   * @param {object} callbacks
   */
  constructor(canvas: HTMLCanvasElement, camera: THREE.Camera, atomSource: InputManager['_atomSource'], callbacks: InputManager['cb']) {
    this.canvas = canvas;
    this.camera = camera;
    this._atomSource = atomSource;
    this.cb = callbacks;

    this.raycaster = new THREE.Raycaster();
    // Interaction capability: coarse pointer + no hover = genuine touch device.
    // Stable across resize — does not change with viewport width.
    // Determines whether to bind touch or pointer events.
    this.isMobile = CONFIG.isTouchInteraction();
    this.isDragging = false;
    this.isCamera = false;
    this.isTriadDragging = false;
    this._triadLastX = 0;
    this._triadLastY = 0;
    this._triadSource = null;
    this._getCameraMode = () => 'orbit';
    this._getScenePolicy = () => ({ allowAtomInteraction: true });
    this._pressedKeys = new Set();
    this._bgOrbitLastX = 0;
    this._bgOrbitLastY = 0;
    this._cameraPointerId = -1;
    this._triadTouchStartTime = 0;
    this._triadTouchStartX = 0;
    this._triadTouchStartY = 0;
    this._triadLastTapTime = 0;
    this._triadLastTapWasCenter = false;
    this._triadDragCommitted = false;
    this._triadTapIntentTimer = null;

    // Pre-allocated scratch objects for picking and interaction (zero per-event allocations)
    this._scratchVec3 = new THREE.Vector3();
    this._scratchProjected = new THREE.Vector3();
    this._scratchNDC = new THREE.Vector2();
    this._scratchRayOrigin = new THREE.Vector3();
    this._scratchRayDir = new THREE.Vector3();
    this._scratchPlaneNormal = new THREE.Vector3();
    this._scratchDiff = new THREE.Vector3();
    this._scratchResult = [0, 0, 0]; // reused return value for screenToWorldOnAtomPlane

    this._handlers = {};
    this._bindEvents();
  }

  updateAtomSource(atomSource) {
    this._atomSource = atomSource;
    this.isDragging = false;
    this.isCamera = false;
    this.isTriadDragging = false;
  }

  /** Connect the triad interaction source (renderer). Called once from main.ts. */
  setTriadSource(source: InputManager['_triadSource']) {
    this._triadSource = source;
  }

  /** Inject scene interaction policy (e.g. review mode disables atom interaction). */
  setScenePolicyGetter(getter: () => { allowAtomInteraction: boolean }) {
    this._getScenePolicy = getter;
  }

  /** Inject camera mode getter (reads from store, respects feature flag). */
  setCameraStateGetter(getter: () => 'orbit' | 'freelook') {
    this._getCameraMode = () => {
      if (!CONFIG.camera.freeLookEnabled) return 'orbit';
      return getter();
    };
  }

  /** Check if a keyboard event should be suppressed (UI focus, modifier keys). */
  _shouldSuppressKey(ke: KeyboardEvent): boolean {
    if (ke.metaKey || ke.ctrlKey || ke.altKey) return true;
    const el = ke.target as HTMLElement;
    if (!el) return true;
    const tag = el.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || tag === 'BUTTON' || tag === 'A') return true;
    if (el.isContentEditable || el.getAttribute('role') === 'button') return true;
    if (el.closest('[data-camera-controls], .quick-help-card, .sheet')) return true;
    return false;
  }

  /** Read current flight input axes from pressed-key set (polled per frame). */
  getFlightInput(): { x: number; z: number } {
    const z = (this._pressedKeys.has('KeyW') ? 1 : 0) - (this._pressedKeys.has('KeyS') ? 1 : 0);
    const x = (this._pressedKeys.has('KeyD') ? 1 : 0) - (this._pressedKeys.has('KeyA') ? 1 : 0);
    return { x, z };
  }

  _screenToNDC(x, y) {
    const rect = this.canvas.getBoundingClientRect();
    return this._scratchNDC.set(
      ((x - rect.left) / rect.width) * 2 - 1,
      -((y - rect.top) / rect.height) * 2 + 1
    );
  }

  _raycastAtom(screenX, screenY) {
    const src = this._atomSource;
    if (!src || src.count === 0) {
      if (DEBUG_INPUT) console.log('[raycast] no atoms');
      return -1;
    }

    const ndc = this._screenToNDC(screenX, screenY);

    // Force camera matrix update
    this.camera.updateMatrixWorld(true);

    // 3D raycast against the atom target
    this.raycaster.setFromCamera(ndc, this.camera);
    const target = src.raycastTarget;
    if (!target) return -1;
    const allHits = this.raycaster.intersectObject(target, false);

    if (DEBUG_INPUT) {
      console.log(`[raycast] screen=(${screenX.toFixed(0)},${screenY.toFixed(0)}) ndc=(${ndc.x.toFixed(3)},${ndc.y.toFixed(3)}) atoms=${src.count} hits=${allHits.length}`);

      // Log nearest 3 atoms by screen distance for debugging (debug path, allocations acceptable)
      const screenDists = [];
      for (let i = 0; i < Math.min(src.count, 200); i++) {
        src.getWorldPosition(i, this._scratchVec3);
        const sp = this._scratchProjected.copy(this._scratchVec3).project(this.camera);
        const d = Math.sqrt((sp.x - ndc.x) ** 2 + (sp.y - ndc.y) ** 2);
        screenDists.push({ i, d, sx: sp.x, sy: sp.y });
      }
      screenDists.sort((a, b) => a.d - b.d);
      for (let k = 0; k < Math.min(3, screenDists.length); k++) {
        const { i, d, sx, sy } = screenDists[k];
        const pos = src.getWorldPosition(i, this._scratchVec3);
        console.log(`  [nearest ${k}] idx=${i} screenDist=${d.toFixed(4)} ndc=(${sx.toFixed(3)},${sy.toFixed(3)}) pos=(${pos.x.toFixed(2)},${pos.y.toFixed(2)},${pos.z.toFixed(2)})`);
      }
    }

    if (allHits.length > 0) {
      // Among hits, prefer closest in screen space
      let bestIdx = -1;
      let bestScreenDist = Infinity;
      for (const hit of allHits) {
        // Resolve atom index from InstancedMesh hit
        const idx = hit.instanceId;
        if (idx < 0 || idx >= src.count) continue;

        src.getWorldPosition(idx, this._scratchVec3);
        const sp = this._scratchProjected.copy(this._scratchVec3).project(this.camera);
        const sd = (sp.x - ndc.x) ** 2 + (sp.y - ndc.y) ** 2;
        if (DEBUG_INPUT) console.log(`  [hit] idx=${idx} screenDist=${Math.sqrt(sd).toFixed(4)} rayDist=${hit.distance.toFixed(3)}`);
        if (sd < bestScreenDist) {
          bestScreenDist = sd;
          bestIdx = idx;
        }
      }
      if (bestIdx >= 0) {
        if (DEBUG_INPUT) console.log(`  → selected idx=${bestIdx} (from raycast)`);
        return bestIdx;
      }
    }

    // Fallback: screen-space proximity
    const hitExpansion = this.isMobile
      ? CONFIG.picker.mobileExpansion
      : CONFIG.picker.desktopExpansion;
    let closest = -1;
    let closestDist = Infinity;
    for (let i = 0; i < src.count; i++) {
      src.getWorldPosition(i, this._scratchVec3);
      const sp = this._scratchProjected.copy(this._scratchVec3).project(this.camera);
      if (sp.z < 0 || sp.z > 1) continue;
      const d = Math.sqrt((sp.x - ndc.x) ** 2 + (sp.y - ndc.y) ** 2);
      if (d < hitExpansion && d < closestDist) {
        closestDist = d;
        closest = i;
      }
    }
    if (DEBUG_INPUT) console.log(`  → selected idx=${closest} (from fallback, dist=${closestDist.toFixed(4)})`);
    return closest;
  }

  /**
   * Convert screen coordinates to a 3D world position on the camera-perpendicular
   * plane that passes through the given atom position.
   *
   * This ensures drag/rotation forces are always in the user's visual plane,
   * regardless of camera orientation.
   *
   * WARNING: Returns a shared internal scratch array (this._scratchResult).
   * The returned array is mutated on the next call. Callers must consume
   * the values immediately (same synchronous block) — do not store the
   * reference across events, frames, or async boundaries.
   *
   * @param {number} screenX - screen pixel X
   * @param {number} screenY - screen pixel Y
   * @param {THREE.Vector3} atomWorldPos - the atom's world position (defines the plane)
   * @returns {number[]} [wx, wy, wz] — shared scratch array, consume immediately
   */
  screenToWorldOnAtomPlane(screenX, screenY, atomWorldPos) {
    const ndc = this._screenToNDC(screenX, screenY);
    const rayOrigin = this._scratchRayOrigin.copy(this.camera.position);
    const rayDir = this._scratchRayDir.set(ndc.x, ndc.y, 0.5)
      .unproject(this.camera)
      .sub(rayOrigin)
      .normalize();

    // Plane: perpendicular to camera view direction, passing through atom
    this.camera.getWorldDirection(this._scratchPlaneNormal);

    // Ray-plane intersection: t = dot(atomPos - rayOrigin, planeNormal) / dot(rayDir, planeNormal)
    const denom = rayDir.dot(this._scratchPlaneNormal);
    const r = this._scratchResult;
    if (Math.abs(denom) < 1e-10) {
      r[0] = atomWorldPos.x; r[1] = atomWorldPos.y; r[2] = atomWorldPos.z;
      return r;
    }

    const diff = this._scratchDiff.copy(atomWorldPos).sub(rayOrigin);
    const t = diff.dot(this._scratchPlaneNormal) / denom;
    const worldPos = rayOrigin.add(rayDir.multiplyScalar(t));
    r[0] = worldPos.x; r[1] = worldPos.y; r[2] = worldPos.z;
    return r;
  }

  _bindEvents() {
    const c = this.canvas;

    this._handlers = {};

    if (this.isMobile) {
      this._handlers.touchstart = (e) => this._onTouchStart(e);
      this._handlers.touchmove = (e) => this._onTouchMove(e);
      this._handlers.touchend = (e) => this._onTouchEnd(e);
      this._handlers.touchcancel = (e) => this._onTouchCancel(e);
      c.addEventListener('touchstart', this._handlers.touchstart, { passive: false });
      c.addEventListener('touchmove', this._handlers.touchmove, { passive: false });
      c.addEventListener('touchend', this._handlers.touchend, { passive: false });
      c.addEventListener('touchcancel', this._handlers.touchcancel, { passive: false });
    } else {
      this._handlers.pointerdown = (e) => this._onPointerDown(e);
      this._handlers.pointermove = (e) => this._onPointerMove(e);
      this._handlers.pointerup = (e) => this._onPointerUp(e);
      this._handlers.contextmenu = (e) => e.preventDefault();
      c.addEventListener('pointerdown', this._handlers.pointerdown);
      c.addEventListener('pointermove', this._handlers.pointermove);
      c.addEventListener('pointerup', this._handlers.pointerup);
      c.addEventListener('pointerleave', this._handlers.pointerup);
      c.addEventListener('contextmenu', this._handlers.contextmenu);
    }

    this._handlers.blur = () => {
      if (this.isDragging) {
        this.cb.onPointerUp?.();
      }
      this.isDragging = false;
      this._pressedKeys.clear();
      if (this.isCamera && this._cameraPointerId >= 0) {
        if (this.canvas.hasPointerCapture(this._cameraPointerId)) {
          this.canvas.releasePointerCapture(this._cameraPointerId);
        }
        this._cameraPointerId = -1;
      }
      this.isCamera = false;
    };
    window.addEventListener('blur', this._handlers.blur);

    // ── Free-Look subsystem (feature-disabled when CONFIG.camera.freeLookEnabled is false) ──
    // When disabled: _getCameraMode() always returns 'orbit' (config flag checked in
    // the injected getter wrapper), so ALL mode-dependent branches in this file
    // consistently see Orbit mode. Implementation retained for future re-enable.
    //
    // Free-Look keyboard shortcuts (WASD flight + R level + Space freeze).
    // Uses key-tracking set for smooth per-frame polling instead of key-repeat.
    this._handlers.keydown = (e) => {
      if (!CONFIG.camera.freeLookEnabled || this._getCameraMode() !== 'freelook') return;
      const ke = e as KeyboardEvent;
      if (this._shouldSuppressKey(ke)) return;
      const code = ke.code;
      // Track flight keys for per-frame polling
      if (code === 'KeyW' || code === 'KeyA' || code === 'KeyS' || code === 'KeyD') {
        this._pressedKeys.add(code);
        this._triadSource?.cancelCameraAnimation?.();
        ke.preventDefault();
      }
      // Instant actions (not tracked — fire once on keydown)
      if (code === 'KeyR') {
        this._triadSource?.resetOrientation?.();
        this._triadSource?.cancelCameraAnimation?.();
        ke.preventDefault();
      }
      if (code === 'Space') {
        this._triadSource?.cancelCameraAnimation?.();
        this._triadSource?.freezeFlight?.();
        ke.preventDefault();
      }
    };
    this._handlers.keyup = (e) => {
      this._pressedKeys.delete((e as KeyboardEvent).code);
    };
    window.addEventListener('keydown', this._handlers.keydown);
    window.addEventListener('keyup', this._handlers.keyup);

    // Scroll wheel in Free-Look → forward/back zoom (desktop only)
    this._handlers.wheel = (e) => {
      if (!CONFIG.camera.freeLookEnabled || this._getCameraMode() !== 'freelook') return;
      e.preventDefault();
      this._triadSource?.cancelCameraAnimation?.();
      this._triadSource?.applyFreeLookZoom?.((e as WheelEvent).deltaY);
    };
    c.addEventListener('wheel', this._handlers.wheel, { passive: false });
  }

  destroy() {
    // Clear any pending triad tap-intent timer
    if (this._triadTapIntentTimer) {
      clearTimeout(this._triadTapIntentTimer);
      this._triadTapIntentTimer = null;
    }
    const c = this.canvas;
    if (this.isMobile) {
      c.removeEventListener('touchstart', this._handlers.touchstart);
      c.removeEventListener('touchmove', this._handlers.touchmove);
      c.removeEventListener('touchend', this._handlers.touchend);
      c.removeEventListener('touchcancel', this._handlers.touchcancel);
    } else {
      c.removeEventListener('pointerdown', this._handlers.pointerdown);
      c.removeEventListener('pointermove', this._handlers.pointermove);
      c.removeEventListener('pointerup', this._handlers.pointerup);
      c.removeEventListener('pointerleave', this._handlers.pointerup);
      c.removeEventListener('contextmenu', this._handlers.contextmenu);
    }
    window.removeEventListener('blur', this._handlers.blur);
    if (this._handlers.keydown) window.removeEventListener('keydown', this._handlers.keydown);
    if (this._handlers.keyup) window.removeEventListener('keyup', this._handlers.keyup);
    if (this._handlers.wheel) c.removeEventListener('wheel', this._handlers.wheel);
    this._handlers = {};
  }

  // --- Desktop events ---

  _onPointerDown(e) {
    this._triadSource?.cancelCameraAnimation?.();
    // Check for rotate modifier FIRST — on Mac, Ctrl+click fires as button=2
    const isRotate = e.ctrlKey || e.metaKey;

    if (isRotate) {
      // Ctrl/Cmd + any click → rotation mode (prevents Mac Ctrl+click = right-click issue)
      e.preventDefault();
      const atomIdx = this._raycastAtom(e.clientX, e.clientY);
      if (atomIdx >= 0) {
        this.isDragging = true;
        this.isCamera = false;
        this.cb.onPointerDown?.(atomIdx, e.clientX, e.clientY, true);
      }
      return;
    }

    if (e.button === 2) {
      // Right-drag → custom orbit via applyOrbitDelta (same quaternion path as mobile)
      e.preventDefault();
      this.isCamera = true;
      this._bgOrbitLastX = e.clientX;
      this._bgOrbitLastY = e.clientY;
      // Pointer capture: orbit continues even if pointer leaves the canvas
      this._cameraPointerId = e.pointerId;
      this.canvas.setPointerCapture(e.pointerId);
      return;
    }

    if (e.button === 1) {
      // Middle click → OrbitControls dolly (unchanged)
      return;
    }

    if (e.button === 0) {
      // Scene policy: in review mode, left-click becomes camera orbit
      const { allowAtomInteraction } = this._getScenePolicy();
      if (!allowAtomInteraction) {
        this.isDragging = false;
        this.isTriadDragging = false;
        this.isCamera = true;
        this._bgOrbitLastX = e.clientX;
        this._bgOrbitLastY = e.clientY;
        this._cameraPointerId = e.pointerId;
        this.canvas.setPointerCapture(e.pointerId);
        this._triadSource?.onBackgroundOrbitStart?.();
        return;
      }

      const atomIdx = this._raycastAtom(e.clientX, e.clientY);
      if (atomIdx >= 0) {
        if (this._getCameraMode() === 'freelook') {
          this._triadSource?.onFreeLookFocusSelect?.(atomIdx);
        } else {
          this.isDragging = true;
          this.isCamera = false;
          this.cb.onPointerDown?.(atomIdx, e.clientX, e.clientY, false);
        }
      }
    }
  }

  _onPointerMove(e) {
    if (this.isDragging) {
      this.cb.onPointerMove?.(e.clientX, e.clientY);
      return;
    }
    if (this.isCamera) {
      // Desktop right-drag: mode-aware routing
      const dx = e.clientX - this._bgOrbitLastX;
      const dy = e.clientY - this._bgOrbitLastY;
      this._bgOrbitLastX = e.clientX;
      this._bgOrbitLastY = e.clientY;
      if (this._getCameraMode() === 'freelook') {
        this._triadSource?.applyFreeLookDelta?.(dx, dy);
      } else {
        this._triadSource?.applyOrbitDelta(dx, dy);
      }
      return;
    }
    // Hover detection
    const atomIdx = this._raycastAtom(e.clientX, e.clientY);
    this.cb.onHover?.(atomIdx);
  }

  _onPointerUp(e) {
    if (this.isDragging) {
      this.isDragging = false;
      this.cb.onPointerUp?.();
    }
    if (this.isCamera) {
      this.isCamera = false;
      // Release pointer capture from right-drag orbit
      if (this.canvas.hasPointerCapture(e.pointerId)) {
        this.canvas.releasePointerCapture(e.pointerId);
      }
      this._cameraPointerId = -1;
    }
  }

  // --- Mobile events ---
  // Priority: triad hit > atom hit > background orbit (empty space).
  // 2+ fingers = always camera (zoom/pan). Finger-count change ends any gesture.

  _onTouchStart(e) {
    this._triadSource?.cancelCameraAnimation?.();
    if (e.touches.length >= 2) {
      // 2+ fingers → cancel any active gesture, let OrbitControls handle camera
      if (this.isDragging) {
        this.isDragging = false;
        this.cb.onPointerUp?.();
      }
      if (this.isTriadDragging) {
        this.isTriadDragging = false;
        if (this._triadTapIntentTimer) { clearTimeout(this._triadTapIntentTimer); this._triadTapIntentTimer = null; }
        this._triadSource?.showAxisHighlight?.(null);
      }
      if (this.isCamera) {
        this.isCamera = false;
        this._triadSource?.onBackgroundOrbitEnd?.();
      }
      return;
    }

    e.preventDefault();
    const touch = e.touches[0];

    // 1. Check triad hit area first (primary camera control on mobile)
    if (this._triadSource?.isInsideTriad(touch.clientX, touch.clientY)) {
      this.isTriadDragging = true;
      this._triadDragCommitted = false; // no orbit until movement exceeds 5px
      this._triadLastX = touch.clientX;
      this._triadLastY = touch.clientY;
      this._triadTouchStartX = touch.clientX;
      this._triadTouchStartY = touch.clientY;
      this._triadTouchStartTime = performance.now();

      // Tap-intent highlight: show nearest axis after 150ms if finger hasn't moved
      if (this._triadTapIntentTimer) clearTimeout(this._triadTapIntentTimer);
      this._triadTapIntentTimer = setTimeout(() => {
        this._triadTapIntentTimer = null;
        if (!this.isTriadDragging) return;
        // Only show if finger stayed close to start (tap intent, not drag)
        const dx = this._triadLastX - this._triadTouchStartX;
        const dy = this._triadLastY - this._triadTouchStartY;
        if (Math.sqrt(dx * dx + dy * dy) < 5) {
          const nearest = this._triadSource?.getNearestAxisEndpoint?.(
            this._triadLastX, this._triadLastY
          );
          this._triadSource?.showAxisHighlight?.(nearest ?? null);
        }
      }, 150);

      return;
    }

    // 2. Scene interaction policy — in review mode, all touch becomes camera orbit
    //    (no atom picking, no drag/move/rotate, no hover/select)
    const { allowAtomInteraction } = this._getScenePolicy();
    if (!allowAtomInteraction) {
      this.isDragging = false;
      this.isTriadDragging = false;
      this.isCamera = true;
      this._bgOrbitLastX = touch.clientX;
      this._bgOrbitLastY = touch.clientY;
      this._triadSource?.onBackgroundOrbitStart?.();
      return;
    }

    // 3. Try atom interaction — atom hit always wins (live mode only)
    const atomIdx = this._raycastAtom(touch.clientX, touch.clientY);
    if (atomIdx >= 0) {
      if (this._getCameraMode() === 'freelook') {
        this._triadSource?.onFreeLookFocusSelect?.(atomIdx);
      } else {
        this.isDragging = true;
        this.cb.onPointerDown?.(atomIdx, touch.clientX, touch.clientY, false);
      }
      return;
    }

    // 4. Empty space → background orbit via applyOrbitDelta (same path as triad drag)
    this.isCamera = true;
    this._bgOrbitLastX = touch.clientX;
    this._bgOrbitLastY = touch.clientY;
    this._triadSource?.onBackgroundOrbitStart?.();
  }

  _onTouchMove(e) {
    if (e.touches.length !== 1) return;
    const touch = e.touches[0];

    if (this.isTriadDragging) {
      e.preventDefault();
      const dx = touch.clientX - this._triadLastX;
      const dy = touch.clientY - this._triadLastY;
      this._triadLastX = touch.clientX;
      this._triadLastY = touch.clientY;

      // Check if movement exceeds 5px from start → commit to drag
      const totalDx = touch.clientX - this._triadTouchStartX;
      const totalDy = touch.clientY - this._triadTouchStartY;
      if (!this._triadDragCommitted && Math.sqrt(totalDx * totalDx + totalDy * totalDy) > 5) {
        this._triadDragCommitted = true;
        // Clear tap-intent highlight — this is a drag, not a tap
        if (this._triadTapIntentTimer) {
          clearTimeout(this._triadTapIntentTimer);
          this._triadTapIntentTimer = null;
        }
        this._triadSource?.showAxisHighlight?.(null);
      }

      // Only apply camera delta after drag threshold is exceeded
      if (this._triadDragCommitted) {
        if (this._getCameraMode() === 'freelook') {
          this._triadSource?.applyFreeLookDelta?.(dx, dy);
        } else {
          this._triadSource?.applyOrbitDelta(dx, dy);
        }
      }
      return;
    }

    if (this.isDragging) {
      e.preventDefault();
      this.cb.onPointerMove?.(touch.clientX, touch.clientY);
      return;
    }

    // Background camera gesture — mode-aware routing.
    if (this.isCamera) {
      e.preventDefault();
      const dx = touch.clientX - this._bgOrbitLastX;
      const dy = touch.clientY - this._bgOrbitLastY;
      this._bgOrbitLastX = touch.clientX;
      this._bgOrbitLastY = touch.clientY;
      if (this._getCameraMode() === 'freelook') {
        this._triadSource?.applyFreeLookDelta?.(dx, dy);
      } else {
        this._triadSource?.applyOrbitDelta(dx, dy);
      }
    }
  }

  _onTouchEnd(e) {
    // Finger-count decrease ends current gesture (no inheritance)
    if (this.isTriadDragging) {
      // Tap = drag threshold never exceeded (no orbit delta was applied)
      const isTap = !this._triadDragCommitted && (performance.now() - this._triadTouchStartTime) < 300;

      if (this._triadTapIntentTimer) {
        clearTimeout(this._triadTapIntentTimer);
        this._triadTapIntentTimer = null;
      }
      this._triadSource?.showAxisHighlight?.(null);

      if (isTap) {
        // Check if tap is in center zone (for double-tap reset)
        const nearest = this._triadSource?.getNearestAxisEndpoint?.(
          this._triadLastX, this._triadLastY
        );
        const isInCenter = nearest === null;

        const now = performance.now();
        const isDoubleTap = (now - this._triadLastTapTime) < 400
          && isInCenter && this._triadLastTapWasCenter;
        this._triadLastTapTime = now;
        this._triadLastTapWasCenter = isInCenter;

        if (isDoubleTap) {
          if (this._getCameraMode() === 'freelook') {
            // Free-Look: double-tap center → return to Orbit + reset view
            this._triadSource?.onReturnToOrbit?.();
          }
          // Reset to default front view (both modes)
          this._triadSource?.animatedResetView?.();
        } else if (nearest && this._getCameraMode() !== 'freelook') {
          // Single tap on axis endpoint → snap to that view (Orbit only)
          this._triadSource?.snapToAxis?.(nearest);
        }
        // Single tap on center (not double) → no action (wait for second tap)
      }

      // Notify triad drag end if an actual drag occurred (not a tap)
      if (this._triadDragCommitted) {
        this._triadSource?.onTriadDragEnd?.();
      }
      this.isTriadDragging = false;
    }
    if (this.isDragging) {
      this.isDragging = false;
      this.cb.onPointerUp?.();
    }
    if (this.isCamera) {
      this.isCamera = false;
      this._triadSource?.onBackgroundOrbitEnd?.();
    }
  }

  /**
   * System-interrupted touch (incoming call, notification, gesture).
   * Unconditionally reset all interaction state.
   */
  _onTouchCancel(_e) {
    if (this.isDragging) {
      this.cb.onPointerUp?.();
    }
    this.isDragging = false;
    this.isTriadDragging = false;
    if (this._triadTapIntentTimer) { clearTimeout(this._triadTapIntentTimer); this._triadTapIntentTimer = null; }
    this._triadSource?.showAxisHighlight?.(null);
    if (this.isCamera) {
      this.isCamera = false;
      this._triadSource?.onBackgroundOrbitEnd?.();
    }
  }
}
