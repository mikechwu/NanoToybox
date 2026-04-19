/**
 * Watch camera-input runtime — DOM event binding for orbit and triad interaction.
 *
 * Dramatically simpler than lab's InputManager because watch has no atoms to
 * interact with. The only discrimination is triad hit area vs. background;
 * everything else routes to orbit.
 *
 * Event ownership:
 *   - This runtime: orbit rotation (left/right-drag, 1-finger), triad interaction
 *   - OrbitControls (inside Renderer): scroll zoom, middle-click dolly, 2-finger pinch+pan
 *   - Both bind to the same event families; conflicts avoided by button/touch ownership.
 */

import type { WatchRenderer } from './watch-renderer';
import type { CameraInteractionPhase } from '../../../src/camera/camera-interaction-gate';
import {
  TRIAD_DRAG_COMMIT_PX,
  TAP_INTENT_PREVIEW_MS,
  TAP_MAX_DURATION_MS,
  DOUBLE_TAP_WINDOW_MS,
} from '../../../src/input/camera-gesture-constants';
import { isTouchInteraction } from '../../../src/ui/device-mode';

export interface WatchCameraInput {
  destroy(): void;
}

export interface WatchCameraInputOpts {
  /** Called on any user-originated camera interaction. The phase
   *  distinguishes held-gesture vs. discrete action so consumers can
   *  gate automation correctly:
   *    - 'start'  — background/triad orbit begins (pointerdown, touchstart)
   *    - 'change' — orbit move delta applied; ALSO used for discrete
   *                 taps (triad snap / animated reset) since they
   *                 have no hold phase
   *    - 'end'    — pointer released; orbit ended
   *  OrbitControls-owned inputs (scroll/dolly/pinch) flow through
   *  `Renderer.onCameraInteraction` with the same phase contract. */
  onUserCameraInteraction?: (phase: CameraInteractionPhase) => void;
}

export function createWatchCameraInput(
  renderer: WatchRenderer,
  opts: WatchCameraInputOpts = {},
): WatchCameraInput {
  const canvas = renderer.getCanvas();
  const notifyInteraction = (phase: CameraInteractionPhase) => {
    opts.onUserCameraInteraction?.(phase);
  };

  // Interaction capability detection — uses shared helper (same as lab/js/config.ts:191)
  const isMobile = isTouchInteraction();

  // ── Lifecycle ──
  let _destroyed = false;

  // ── Gesture state ──
  let _orbiting = false;
  let _orbitLastX = 0;
  let _orbitLastY = 0;
  let _orbitPointerId = -1;

  let _triadDragging = false;
  let _triadDragCommitted = false;
  let _triadLastX = 0;
  let _triadLastY = 0;
  let _triadStartX = 0;
  let _triadStartY = 0;
  let _triadStartTime = 0;
  let _triadLastTapTime = 0;
  let _triadLastTapWasCenter = false;
  let _triadTapIntentTimer: ReturnType<typeof setTimeout> | null = null;

  // ── Helpers ──

  function resetGestureState() {
    // If a gesture was in flight (blur / touchcancel while held),
    // signal release so consumers don't stay paused forever waiting
    // for an 'end' that will never come.
    if (_orbiting || (_triadDragging && _triadDragCommitted)) {
      notifyInteraction('end');
    }
    _orbiting = false;
    _triadDragging = false;
    _triadDragCommitted = false;
    _triadLastTapTime = 0;
    _triadLastTapWasCenter = false;
    if (_triadTapIntentTimer) { clearTimeout(_triadTapIntentTimer); _triadTapIntentTimer = null; }
    renderer.showAxisHighlight(null);
    if (_orbitPointerId >= 0 && canvas.hasPointerCapture(_orbitPointerId)) {
      canvas.releasePointerCapture(_orbitPointerId);
    }
    _orbitPointerId = -1;
  }

  function startOrbit(x: number, y: number, pointerId?: number) {
    renderer.cancelCameraAnimation();
    notifyInteraction('start');
    _orbiting = true;
    _orbitLastX = x;
    _orbitLastY = y;
    if (pointerId !== undefined) {
      _orbitPointerId = pointerId;
      canvas.setPointerCapture(pointerId);
    }
    renderer.startBackgroundOrbitCue();
  }

  function endOrbit(pointerId?: number) {
    if (_orbiting) notifyInteraction('end');
    _orbiting = false;
    renderer.endBackgroundOrbitCue();
    if (pointerId !== undefined && canvas.hasPointerCapture(pointerId)) {
      canvas.releasePointerCapture(pointerId);
    }
    _orbitPointerId = -1;
  }

  // ── Desktop events ──

  function onPointerDown(e: PointerEvent) {
    renderer.cancelCameraAnimation();

    // Left-click or right-click on background → orbit
    // Desktop triad click is intentionally not wired — lab review mode only
    // exposes triad interaction on the mobile touch path (lab/js/input.ts:587),
    // not the desktop pointer path. Watch matches this for strict parity.
    if (e.button === 0 || e.button === 2) {
      e.preventDefault();
      startOrbit(e.clientX, e.clientY, e.pointerId);
    }
    // Middle-click → let OrbitControls handle dolly
  }

  function onPointerMove(e: PointerEvent) {
    if (!_orbiting) return;
    const dx = e.clientX - _orbitLastX;
    const dy = e.clientY - _orbitLastY;
    _orbitLastX = e.clientX;
    _orbitLastY = e.clientY;
    notifyInteraction('change');
    renderer.applyOrbitDelta(dx, dy);
  }

  function onPointerUp(e: PointerEvent) {
    if (_orbiting) {
      endOrbit(e.pointerId);
    }
  }

  function onContextMenu(e: Event) {
    e.preventDefault();
  }

  // ── Mobile events ──

  function onTouchStart(e: TouchEvent) {
    renderer.cancelCameraAnimation();

    if (e.touches.length >= 2) {
      // 2+ fingers → cancel 1-finger gesture, let OrbitControls handle zoom/pan
      if (_triadDragging) {
        _triadDragging = false;
        if (_triadTapIntentTimer) { clearTimeout(_triadTapIntentTimer); _triadTapIntentTimer = null; }
        renderer.showAxisHighlight(null);
      }
      if (_orbiting) {
        _orbiting = false;
        renderer.endBackgroundOrbitCue();
      }
      return;
    }

    e.preventDefault();
    const touch = e.touches[0];

    // 1. Triad hit area
    if (renderer.isInsideTriad(touch.clientX, touch.clientY)) {
      _triadDragging = true;
      _triadDragCommitted = false;
      _triadLastX = touch.clientX;
      _triadLastY = touch.clientY;
      _triadStartX = touch.clientX;
      _triadStartY = touch.clientY;
      _triadStartTime = performance.now();

      // Tap-intent highlight after TAP_INTENT_PREVIEW_MS
      if (_triadTapIntentTimer) clearTimeout(_triadTapIntentTimer);
      _triadTapIntentTimer = setTimeout(() => {
        _triadTapIntentTimer = null;
        if (_destroyed || !_triadDragging) return;
        const dx = _triadLastX - _triadStartX;
        const dy = _triadLastY - _triadStartY;
        if (Math.sqrt(dx * dx + dy * dy) < TRIAD_DRAG_COMMIT_PX) {
          const nearest = renderer.getNearestAxisEndpoint(_triadLastX, _triadLastY);
          renderer.showAxisHighlight(nearest);
        }
      }, TAP_INTENT_PREVIEW_MS);
      return;
    }

    // 2. Background → orbit
    startOrbit(touch.clientX, touch.clientY);
  }

  function onTouchMove(e: TouchEvent) {
    if (e.touches.length !== 1) return;
    const touch = e.touches[0];

    if (_triadDragging) {
      e.preventDefault();
      const dx = touch.clientX - _triadLastX;
      const dy = touch.clientY - _triadLastY;
      _triadLastX = touch.clientX;
      _triadLastY = touch.clientY;

      // Check drag commit threshold
      const totalDx = touch.clientX - _triadStartX;
      const totalDy = touch.clientY - _triadStartY;
      if (!_triadDragCommitted && Math.sqrt(totalDx * totalDx + totalDy * totalDy) > TRIAD_DRAG_COMMIT_PX) {
        _triadDragCommitted = true;
        // The triad gesture flipped from "maybe tap" to "held drag" —
        // emit 'start' exactly once so the cinematic camera treats
        // this as a real held gesture. Without this, a pause-mid-
        // drag-while-still-holding would let cooldown expire.
        notifyInteraction('start');
        if (_triadTapIntentTimer) { clearTimeout(_triadTapIntentTimer); _triadTapIntentTimer = null; }
        renderer.showAxisHighlight(null);
      }
      if (_triadDragCommitted) {
        notifyInteraction('change');
        renderer.applyOrbitDelta(dx, dy);
      }
      return;
    }

    if (_orbiting) {
      e.preventDefault();
      const dx = touch.clientX - _orbitLastX;
      const dy = touch.clientY - _orbitLastY;
      _orbitLastX = touch.clientX;
      _orbitLastY = touch.clientY;
      notifyInteraction('change');
      renderer.applyOrbitDelta(dx, dy);
    }
  }

  function onTouchEnd(_e: TouchEvent) {
    if (_triadDragging) {
      const isTap = !_triadDragCommitted && (performance.now() - _triadStartTime) < TAP_MAX_DURATION_MS;

      if (_triadTapIntentTimer) { clearTimeout(_triadTapIntentTimer); _triadTapIntentTimer = null; }
      renderer.showAxisHighlight(null);

      if (_triadDragCommitted) {
        // Drag was committed → emit 'end' so cinematic cooldown
        // starts from release (matches the pointer-orbit release path).
        notifyInteraction('end');
      } else if (isTap) {
        const nearest = renderer.getNearestAxisEndpoint(_triadLastX, _triadLastY);
        const isInCenter = nearest === null;
        const now = performance.now();
        const isDoubleTap = (now - _triadLastTapTime) < DOUBLE_TAP_WINDOW_MS
          && isInCenter && _triadLastTapWasCenter;
        _triadLastTapTime = now;
        _triadLastTapWasCenter = isInCenter;

        if (isDoubleTap) {
          // Discrete action — 'change' refreshes cooldown without
          // setting gesture-active (no hold to observe).
          notifyInteraction('change');
          renderer.animatedResetView();
        } else if (nearest) {
          notifyInteraction('change');
          renderer.snapToAxis(nearest);
        }
      }
      _triadDragging = false;
    }

    if (_orbiting) {
      notifyInteraction('end');
      _orbiting = false;
      renderer.endBackgroundOrbitCue();
    }
  }

  function onTouchCancel(_e: TouchEvent) {
    resetGestureState();
  }

  // ── Shared handlers ──

  function onBlur() {
    resetGestureState();
  }

  // ── Bind events ──

  if (isMobile) {
    canvas.addEventListener('touchstart', onTouchStart, { passive: false });
    canvas.addEventListener('touchmove', onTouchMove, { passive: false });
    canvas.addEventListener('touchend', onTouchEnd, { passive: false });
    canvas.addEventListener('touchcancel', onTouchCancel, { passive: false });
  } else {
    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerup', onPointerUp);
    canvas.addEventListener('pointerleave', onPointerUp);
  }
  canvas.addEventListener('contextmenu', onContextMenu);
  window.addEventListener('blur', onBlur);

  return {
    destroy() {
      _destroyed = true;
      resetGestureState();
      if (isMobile) {
        canvas.removeEventListener('touchstart', onTouchStart);
        canvas.removeEventListener('touchmove', onTouchMove);
        canvas.removeEventListener('touchend', onTouchEnd);
        canvas.removeEventListener('touchcancel', onTouchCancel);
      } else {
        canvas.removeEventListener('pointerdown', onPointerDown);
        canvas.removeEventListener('pointermove', onPointerMove);
        canvas.removeEventListener('pointerup', onPointerUp);
        canvas.removeEventListener('pointerleave', onPointerUp);
      }
      canvas.removeEventListener('contextmenu', onContextMenu);
      window.removeEventListener('blur', onBlur);
    },
  };
}
