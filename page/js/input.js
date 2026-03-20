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
import { CONFIG } from './config.js';

const DEBUG_INPUT = CONFIG.debug.input;

export class InputManager {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {THREE.Camera} camera
   * @param {OrbitControls} controls
   * @param {object} atomSource - { count: number, getWorldPosition(i, outVec3): Vector3, raycastTarget: THREE.Object3D[] | THREE.InstancedMesh }
   * @param {object} callbacks
   */
  constructor(canvas, camera, controls, atomSource, callbacks) {
    this.canvas = canvas;
    this.camera = camera;
    this.controls = controls;
    this._atomSource = atomSource;
    this.cb = callbacks;

    this.raycaster = new THREE.Raycaster();
    this.isMobile = 'ontouchstart' in window;
    this.isDragging = false;
    this.isCamera = false;

    // Pre-allocated scratch objects for picking and interaction (zero per-event allocations)
    this._scratchVec3 = new THREE.Vector3();
    this._scratchProjected = new THREE.Vector3();
    this._scratchNDC = new THREE.Vector2();
    this._scratchRayOrigin = new THREE.Vector3();
    this._scratchRayDir = new THREE.Vector3();
    this._scratchPlaneNormal = new THREE.Vector3();
    this._scratchDiff = new THREE.Vector3();
    this._scratchResult = [0, 0, 0]; // reused return value for screenToWorldOnAtomPlane

    this._bindEvents();
  }

  updateAtomSource(atomSource) {
    this._atomSource = atomSource;
    this.isDragging = false;
    this.isCamera = false;
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
      this.isCamera = false;
    };
    window.addEventListener('blur', this._handlers.blur);
  }

  destroy() {
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
    this._handlers = {};
  }

  // --- Desktop events ---

  _onPointerDown(e) {
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

    if (e.button === 2 || e.button === 1) {
      // Right or middle click → handled by OrbitControls directly (always enabled)
      return;
    }

    if (e.button === 0) {
      // Left click → interact with atom or do nothing
      const atomIdx = this._raycastAtom(e.clientX, e.clientY);

      if (atomIdx >= 0) {
        this.isDragging = true;
        this.isCamera = false;
        this.cb.onPointerDown?.(atomIdx, e.clientX, e.clientY, false);
      }
    }
  }

  _onPointerMove(e) {
    if (this.isDragging) {
      this.cb.onPointerMove?.(e.clientX, e.clientY);
    } else if (!this.isCamera) {
      // Hover detection
      const atomIdx = this._raycastAtom(e.clientX, e.clientY);
      this.cb.onHover?.(atomIdx);
    }
  }

  _onPointerUp(e) {
    if (this.isDragging) {
      this.isDragging = false;
      this.cb.onPointerUp?.();
    }
    // Right-click/scroll camera is handled by OrbitControls directly — no cleanup needed
  }

  // --- Mobile events ---
  // Simple rule: 1 finger = interact with molecule, 2+ fingers = always camera.
  // No multi-touch rotation — rotation is handled via the Rotate mode selector.

  _onTouchStart(e) {
    if (e.touches.length >= 2) {
      // 2+ fingers → cancel any active interaction, let OrbitControls handle camera
      if (this.isDragging) {
        this.isDragging = false;
        this.cb.onPointerUp?.();
      }
      return;
    }

    // 1 finger → try atom interaction
    e.preventDefault();
    const touch = e.touches[0];
    const atomIdx = this._raycastAtom(touch.clientX, touch.clientY);

    if (atomIdx >= 0) {
      this.isDragging = true;
      this.cb.onPointerDown?.(atomIdx, touch.clientX, touch.clientY, false);
    }
  }

  _onTouchMove(e) {
    if (this.isDragging && e.touches.length === 1) {
      e.preventDefault();
      const touch = e.touches[0];
      this.cb.onPointerMove?.(touch.clientX, touch.clientY);
    }
    // 2-finger moves handled by OrbitControls directly
  }

  _onTouchEnd(e) {
    if (e.touches.length === 0) {
      if (this.isDragging) {
        this.isDragging = false;
        this.cb.onPointerUp?.();
      }
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
  }
}
