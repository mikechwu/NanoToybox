/**
 * Unified input handler — normalizes desktop and mobile events
 * into canonical events for the state machine.
 *
 * Desktop: left-click = interact, right-click = camera, scroll = zoom
 * Mobile:  1-finger = interact, 2-finger = camera (pinch/pan)
 */
import * as THREE from 'three';
import { CONFIG } from './config.js';

const DEBUG_INPUT = CONFIG.debug.input;

export class InputManager {
  constructor(canvas, camera, controls, atomMeshes, callbacks) {
    this.canvas = canvas;
    this.camera = camera;
    this.controls = controls;
    this.atomMeshes = atomMeshes;
    this.cb = callbacks;

    this.raycaster = new THREE.Raycaster();
    this.isMobile = 'ontouchstart' in window;
    this.touchCount = 0;
    this.isDragging = false;
    this.isCamera = false;

    this._bindEvents();
  }

  updateAtomMeshes(meshes) {
    this.atomMeshes = meshes;
    this.isDragging = false;
    this.isCamera = false;
    this.touchCount = 0;
  }

  _screenToNDC(x, y) {
    const rect = this.canvas.getBoundingClientRect();
    return new THREE.Vector2(
      ((x - rect.left) / rect.width) * 2 - 1,
      -((y - rect.top) / rect.height) * 2 + 1
    );
  }

  _raycastAtom(screenX, screenY) {
    if (!this.atomMeshes || this.atomMeshes.length === 0) {
      if (DEBUG_INPUT) console.log('[raycast] no meshes');
      return -1;
    }

    const ndc = this._screenToNDC(screenX, screenY);

    // Force camera matrix update
    this.camera.updateMatrixWorld(true);

    // 3D raycast
    this.raycaster.setFromCamera(ndc, this.camera);
    const allHits = this.raycaster.intersectObjects(this.atomMeshes, false);

    if (DEBUG_INPUT) {
      console.log(`[raycast] screen=(${screenX.toFixed(0)},${screenY.toFixed(0)}) ndc=(${ndc.x.toFixed(3)},${ndc.y.toFixed(3)}) meshes=${this.atomMeshes.length} hits=${allHits.length}`);

      // Log nearest 3 atoms by screen distance for debugging
      const screenDists = [];
      for (let i = 0; i < Math.min(this.atomMeshes.length, 200); i++) {
        const sp = this.atomMeshes[i].position.clone().project(this.camera);
        const d = Math.sqrt((sp.x - ndc.x) ** 2 + (sp.y - ndc.y) ** 2);
        screenDists.push({ i, d, sp });
      }
      screenDists.sort((a, b) => a.d - b.d);
      for (let k = 0; k < Math.min(3, screenDists.length); k++) {
        const { i, d, sp } = screenDists[k];
        const pos = this.atomMeshes[i].position;
        console.log(`  [nearest ${k}] idx=${i} screenDist=${d.toFixed(4)} ndc=(${sp.x.toFixed(3)},${sp.y.toFixed(3)}) meshPos=(${pos.x.toFixed(2)},${pos.y.toFixed(2)},${pos.z.toFixed(2)})`);
      }
    }

    if (allHits.length > 0) {
      // Among hits, prefer closest in screen space
      let bestIdx = -1;
      let bestScreenDist = Infinity;
      for (const hit of allHits) {
        const idx = this.atomMeshes.indexOf(hit.object);
        if (idx < 0) continue;
        const sp = hit.object.position.clone().project(this.camera);
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
    for (let i = 0; i < this.atomMeshes.length; i++) {
      const sp = this.atomMeshes[i].position.clone().project(this.camera);
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
   * @param {number} screenX - screen pixel X
   * @param {number} screenY - screen pixel Y
   * @param {THREE.Vector3} atomWorldPos - the atom's world position (defines the plane)
   * @returns {number[]} [wx, wy, wz] — 3D world position on the camera plane
   */
  screenToWorldOnAtomPlane(screenX, screenY, atomWorldPos) {
    const ndc = this._screenToNDC(screenX, screenY);
    const rayOrigin = this.camera.position.clone();
    const rayDir = new THREE.Vector3(ndc.x, ndc.y, 0.5)
      .unproject(this.camera)
      .sub(rayOrigin)
      .normalize();

    // Plane: perpendicular to camera view direction, passing through atom
    const planeNormal = new THREE.Vector3();
    this.camera.getWorldDirection(planeNormal); // points INTO screen

    // Ray-plane intersection: t = dot(atomPos - rayOrigin, planeNormal) / dot(rayDir, planeNormal)
    const denom = rayDir.dot(planeNormal);
    if (Math.abs(denom) < 1e-10) {
      // Ray parallel to plane — fallback to atom position
      return [atomWorldPos.x, atomWorldPos.y, atomWorldPos.z];
    }

    const diff = atomWorldPos.clone().sub(rayOrigin);
    const t = diff.dot(planeNormal) / denom;
    const worldPos = rayOrigin.add(rayDir.multiplyScalar(t));

    return [worldPos.x, worldPos.y, worldPos.z];
  }

  _bindEvents() {
    const c = this.canvas;

    this._handlers = {};

    if (this.isMobile) {
      this._handlers.touchstart = (e) => this._onTouchStart(e);
      this._handlers.touchmove = (e) => this._onTouchMove(e);
      this._handlers.touchend = (e) => this._onTouchEnd(e);
      c.addEventListener('touchstart', this._handlers.touchstart, { passive: false });
      c.addEventListener('touchmove', this._handlers.touchmove, { passive: false });
      c.addEventListener('touchend', this._handlers.touchend, { passive: false });
      c.addEventListener('touchcancel', this._handlers.touchend, { passive: false });
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
      this.cb.onPointerUp?.();
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
      c.removeEventListener('touchcancel', this._handlers.touchend);
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
      // Left click → drag atom or do nothing (left not mapped in OrbitControls)
      const atomIdx = this._raycastAtom(e.clientX, e.clientY);

      if (atomIdx >= 0) {
        this.isDragging = true;
        this.isCamera = false;
        this.cb.onPointerDown?.(atomIdx, e.clientX, e.clientY, false);
      }
      // If no atom hit, do nothing — left-click on empty space is a no-op
      // (right-click handles camera orbit)
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

  _onTouchStart(e) {
    this.touchCount = e.touches.length;

    if (this.touchCount >= 2) {
      // 2+ fingers → OrbitControls handles pinch/pan natively
      // Cancel any active atom drag
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
    // If no atom hit, 1-finger on empty does nothing (2-finger handles camera)
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
      this.touchCount = 0;
    }
  }
}
