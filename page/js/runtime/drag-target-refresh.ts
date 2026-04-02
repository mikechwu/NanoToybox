/**
 * Drag target refresh runtime — continuous reprojection of pointer intent.
 *
 * Problem: pointer intent is persistent in screen space, but the world-space
 * drag target becomes stale when the atom moves between pointer events.
 *
 * Solution: store latest pointer screen coords, reproject every frame from
 * current atom world position + camera plane, and update physics + renderer.
 *
 * @module drag-target-refresh
 *
 * Owns:        Latest pointer screen coords, active-interaction flag,
 *              per-frame world-space reprojection of drag target.
 * Depends on:  DragPhysicsSurface (dragAtom, updateDrag),
 *              DragRendererSurface (getAtomWorldPosition, showForceLine),
 *              InputManager (screenToWorldOnPlane).
 * Called by:   interaction-dispatch (activate/updatePointer/deactivate via dragRefreshAction),
 *              render loop (refresh each frame while active).
 * Teardown:    deactivate() — clears active flag, pointer coords, and hasPointer state.
 */

import type { InputManager } from '../input';

/** Map a dispatch action to a drag-refresh lifecycle event. Exported for testing. */
export function dragRefreshAction(action: string): 'activate' | 'update-pointer' | 'deactivate' | null {
  switch (action) {
    case 'startDrag': case 'startMove': case 'startRotate':
      return 'activate';
    case 'updateDrag': case 'updateMove': case 'updateRotate':
      return 'update-pointer';
    case 'endDrag': case 'endMove': case 'endRotate': case 'flick':
    case 'cancelInteraction': case 'forceIdle':
      return 'deactivate';
    default:
      return null;
  }
}

/** Minimal renderer surface for drag refresh. */
export interface DragRendererSurface {
  getAtomWorldPosition(index: number, out?: any): any;
  getAtomCount?(): number;
  showForceLine(fromAtomIndex: number, toWorldX: number, toWorldY: number, toWorldZ: number): void;
}

/** Minimal physics surface for drag updates. */
export interface DragPhysicsSurface {
  dragAtom: number;
  updateDrag(worldX: number, worldY: number, worldZ: number): void;
}

export interface DragTargetRefresh {
  /** Store latest pointer screen coords (called on every pointer event during interaction). */
  updatePointer(screenX: number, screenY: number): void;
  /** Mark interaction as active. */
  activate(): void;
  /** Clear state when interaction ends. */
  deactivate(): void;
  /** Per-frame refresh: reproject and update physics + renderer. Returns true if refresh occurred. */
  refresh(
    physics: DragPhysicsSurface,
    renderer: DragRendererSurface,
    inputManager: InputManager,
    sendWorkerDrag?: (worldX: number, worldY: number, worldZ: number) => void,
  ): boolean;
  /** Whether an interaction is currently active. */
  isActive(): boolean;
}

export function createDragTargetRefresh(): DragTargetRefresh {
  let _active = false;
  let _screenX = 0;
  let _screenY = 0;
  let _hasPointer = false;

  return {
    updatePointer(screenX: number, screenY: number) {
      _screenX = screenX;
      _screenY = screenY;
      _hasPointer = true;
    },

    activate() {
      _active = true;
    },

    deactivate() {
      _active = false;
      _hasPointer = false;
    },

    isActive() {
      return _active;
    },

    refresh(physics, renderer, inputManager, sendWorkerDrag) {
      if (!_active || !_hasPointer) return false;

      // Guard: drag target must be valid — auto-deactivate if atom is gone
      const atomCount = renderer.getAtomCount?.() ?? Infinity;
      if (physics.dragAtom < 0 || physics.dragAtom >= atomCount) {
        _active = false;
        _hasPointer = false;
        return false;
      }

      // Get current atom world position
      const atomPos = renderer.getAtomWorldPosition(physics.dragAtom);
      if (!atomPos) return false;

      // Reproject pointer onto camera-perpendicular plane through current atom position
      const target = inputManager.screenToWorldOnAtomPlane(_screenX, _screenY, atomPos);
      if (!target) return false;

      const [wx, wy, wz] = target;

      // Update physics spring target
      physics.updateDrag(wx, wy, wz);

      // Update force line visual (same target as physics)
      renderer.showForceLine(physics.dragAtom, wx, wy, wz);

      // Mirror to worker if active
      if (sendWorkerDrag) {
        sendWorkerDrag(wx, wy, wz);
      }

      return true;
    },
  };
}
