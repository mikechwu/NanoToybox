/**
 * Timeline context capture — produces serializable snapshots of
 * user interaction state and boundary-condition state.
 *
 * Keeps timeline logic clean by isolating context extraction from
 * the physics engine's internal representation.
 *
 * Does NOT own or mutate physics, renderer, or store state.
 */

import type { PhysicsEngine } from '../physics';

// ── Interaction state (physics-relevant external input, not raw pointer pixels) ──

export type TimelineInteractionState =
  | { kind: 'none' }
  | { kind: 'atom_drag'; atomIndex: number; target: [number, number, number] }
  | { kind: 'move_group'; atomIndex: number; componentId: number; target: [number, number, number] }
  | { kind: 'rotate_group'; atomIndex: number; componentId: number; target: [number, number, number] };

// ── Boundary state ──

export interface TimelineBoundaryState {
  mode: 'contain' | 'remove';
  wallRadius: number;
  wallCenter: [number, number, number];
  wallCenterSet: boolean;
  removedCount: number;
  damping: number;
}

// ── Capture functions ──

/** Snapshot the current interaction state from the physics engine. */
export function captureInteractionState(physics: PhysicsEngine): TimelineInteractionState {
  if (physics.dragAtom < 0) return { kind: 'none' };

  const target: [number, number, number] = [
    physics.dragTarget[0],
    physics.dragTarget[1],
    physics.dragTarget[2],
  ];

  if (physics.isRotateMode) {
    return {
      kind: 'rotate_group',
      atomIndex: physics.dragAtom,
      componentId: physics.activeComponent,
      target,
    };
  }
  if (physics.isTranslateMode) {
    return {
      kind: 'move_group',
      atomIndex: physics.dragAtom,
      componentId: physics.activeComponent,
      target,
    };
  }
  return {
    kind: 'atom_drag',
    atomIndex: physics.dragAtom,
    target,
  };
}

/** Snapshot the current boundary/wall state from the physics engine's public API. */
export function captureBoundaryState(physics: PhysicsEngine): TimelineBoundaryState {
  return physics.getBoundarySnapshot();
}

/** Restore interaction state onto the physics engine after a checkpoint restore. */
export function restoreInteractionState(physics: PhysicsEngine, state: TimelineInteractionState): void {
  // Always clear first
  if (physics.dragAtom >= 0) physics.endDrag();

  if (state.kind === 'none') return;

  // Validate atom index is in range
  if (state.atomIndex < 0 || state.atomIndex >= physics.n) return;

  switch (state.kind) {
    case 'atom_drag':
      physics.startDrag(state.atomIndex);
      physics.updateDrag(state.target[0], state.target[1], state.target[2]);
      break;
    case 'move_group':
      physics.startTranslate(state.atomIndex);
      physics.updateDrag(state.target[0], state.target[1], state.target[2]);
      break;
    case 'rotate_group':
      physics.startRotateDrag(state.atomIndex);
      physics.updateDrag(state.target[0], state.target[1], state.target[2]);
      break;
  }
}

/** Restore boundary state onto the physics engine via its public API. */
export function restoreBoundaryState(physics: PhysicsEngine, state: TimelineBoundaryState): void {
  physics.restoreBoundarySnapshot(state);
}
