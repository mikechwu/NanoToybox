/**
 * Input bindings — owns InputManager construction, sync, and callback wiring.
 *
 * inputBindings.sync() is part of the scene mutation contract — called by
 * scene commit, clear, and placement callbacks. Scene wrappers depend on
 * this narrow method, not on InputManager internals.
 *
 * Does NOT own interaction dispatch — that is interaction-dispatch.ts.
 * Does NOT attach global listeners or write to window.
 */

import { InputManager } from '../input';
import type { Renderer } from '../renderer';
import type { StateMachine, Command } from '../state-machine';
import { useAppStore } from '../store/app-store';
import { focusMoleculeByAtom } from './focus-runtime';
import type { AchievementKey } from './onboarding';
import { createAtomSource } from './atom-source';

export interface InputBindings {
  /** Resync the input manager's atom source after scene mutations. */
  sync(): void;
  /** Get the current InputManager instance. */
  getManager(): InputManager | null;
  /** Destroy the input manager. */
  destroy(): void;
}

export interface InputBindingsDeps {
  getRenderer: () => Renderer;
  getPlacement: () => { active: boolean } | null;
  getStateMachine: () => StateMachine;
  getSessionInteractionMode: () => string;
  dispatch: (cmd: Command, sx?: number, sy?: number) => void;
  onAchievement?: (key: AchievementKey) => void;
}

export function createInputBindings(deps: InputBindingsDeps): InputBindings {
  let _manager: InputManager | null = null;

  function buildAtomSource() {
    return createAtomSource(deps.getRenderer());
  }

  function ensureManager() {
    if (_manager) return;
    const r = deps.getRenderer();
    _manager = new InputManager(
      r.getCanvas(),
      r.camera,
      buildAtomSource(),
      {
        onHover: (atomIdx) => {
          const p = deps.getPlacement();
          if (p && p.active) return;
          const sm = deps.getStateMachine();
          const cmd = atomIdx >= 0
            ? sm.onPointerOverAtom(atomIdx)
            : sm.onPointerOutAtom();
          if (cmd) deps.dispatch(cmd);
        },
        onPointerDown: (atomIdx, sx, sy, isRotate) => {
          const p = deps.getPlacement();
          if (p && p.active) return;
          const mode = isRotate ? 'rotate' : deps.getSessionInteractionMode();
          const cmd = deps.getStateMachine().onPointerDown(atomIdx, sx, sy, mode);
          if (cmd) deps.dispatch(cmd, sx, sy);
        },
        onPointerMove: (sx, sy) => {
          const p = deps.getPlacement();
          if (p && p.active) return;
          const cmd = deps.getStateMachine().onPointerMove(sx, sy);
          if (cmd) deps.dispatch(cmd, sx, sy);
        },
        onPointerUp: () => {
          const p = deps.getPlacement();
          if (p && p.active) return;
          const cmd = deps.getStateMachine().onPointerUp();
          if (cmd) deps.dispatch(cmd);
        },
      }
    );
    // Wire camera state getter and triad interaction source
    const renderer = deps.getRenderer();
    _manager.setCameraStateGetter(() => useAppStore.getState().cameraMode);
    _manager.setTriadSource({
      isInsideTriad: (cx, cy) => renderer.isInsideTriad(cx, cy),
      applyOrbitDelta: (dx, dy) => renderer.applyOrbitDelta(dx, dy),
      applyFreeLookDelta: (dx, dy) => renderer.applyFreeLookDelta(dx, dy),
      applyFreeLookZoom: (delta) => renderer.applyFreeLookZoom(delta),
      applyFreeLookTranslate: (dx, dy) => renderer.applyFreeLookTranslate(dx, dy),
      onBackgroundOrbitStart: () => renderer.startBackgroundOrbitCue(),
      onBackgroundOrbitEnd: () => {
        renderer.endBackgroundOrbitCue();
        // Only record orbit-drag in Orbit mode (not Free-Look background look)
        if (useAppStore.getState().cameraMode === 'orbit') deps.onAchievement?.('orbit-drag');
      },
      getNearestAxisEndpoint: (cx, cy) => renderer.getNearestAxisEndpoint(cx, cy),
      snapToAxis: (dir) => { renderer.snapToAxis(dir); deps.onAchievement?.('axis-snap'); },
      animatedResetView: () => { renderer.animatedResetView(); deps.onAchievement?.('view-reset'); },
      showAxisHighlight: (dir) => renderer.showAxisHighlight(dir),
      onReturnToOrbit: () => useAppStore.getState().setCameraMode('orbit'),
      onFreeLookFocusSelect: (atomIdx) => focusMoleculeByAtom(atomIdx, deps.getRenderer()),
      resetOrientation: () => renderer.resetOrientation(),
      onTriadDragEnd: () => {
        if (useAppStore.getState().cameraMode === 'orbit') deps.onAchievement?.('orbit-drag');
      },
    });
  }

  return {
    sync() {
      ensureManager();
      _manager!.updateAtomSource(buildAtomSource());
    },
    getManager() {
      return _manager;
    },
    destroy() {
      if (_manager) { _manager.destroy(); _manager = null; }
    },
  };
}
