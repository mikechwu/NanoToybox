/**
 * Interaction highlight resolver — maps interaction state + mode to highlight target.
 *
 * Highlight priority (highest first):
 * 1. Active interaction highlight (drag/move/rotate in progress)
 * 2. Hover interaction preview (atom under pointer, mode-dependent)
 * 3. Panel tracked highlight (bonded-group selection — separate channel)
 * 4. Panel hover highlight (bonded-group hover — separate channel)
 * 5. None
 *
 * This module resolves levels 1-2 only. Panel highlight (3-4) is owned by
 * bonded-group-highlight-runtime.ts. The renderer consumes both channels
 * via separate APIs: setInteractionHighlightedAtoms vs setHighlightedAtoms.
 *
 * @module interaction-highlight-runtime
 *
 * Owns:        Interaction highlight resolution (levels 1-2: active interaction
 *              and hover preview), mode-aware group expansion for move/rotate.
 * Depends on:  InteractionHighlightPhysicsSurface (componentId, components for
 *              group membership lookup).
 * Called by:   app/frame-runtime.ts (resolveInteractionHighlight per frame),
 *              renderer (consumes result via setInteractionHighlightedAtoms).
 * Teardown:    Stateless module (pure function) — no instance teardown needed.
 */

/** Minimal physics surface for component lookup. */
export interface InteractionHighlightPhysicsSurface {
  n: number;
  componentId: Int32Array | null;
  components: { atoms: number[]; size: number }[];
}

export interface InteractionFeedbackState {
  hoverAtom: number;
  activeAtom: number;
  isDragging: boolean;
  isMoving: boolean;
  isRotating: boolean;
}

export interface ResolvedInteractionHighlight {
  /** Single atom to highlight (Atom mode), or the picked atom for force-line anchor. */
  atomIndex: number;
  /** Full group to highlight (Move/Rotate mode), or null for atom-only. */
  groupAtomIndices: number[] | null;
  /** Visual intensity. */
  intensity: 'hover' | 'active';
}

/**
 * Resolve the interaction highlight target from current state + mode.
 * Returns null if no interaction highlight should be shown.
 */
export function resolveInteractionHighlight(
  feedback: InteractionFeedbackState,
  sessionMode: 'atom' | 'move' | 'rotate',
  physics: InteractionHighlightPhysicsSurface,
): ResolvedInteractionHighlight | null {
  const isActive = feedback.isDragging || feedback.isMoving || feedback.isRotating;

  // Determine the target atom and effective mode
  let targetAtom: number;
  let effectiveMode: 'atom' | 'move' | 'rotate';
  let intensity: 'hover' | 'active';

  if (isActive && feedback.activeAtom >= 0) {
    targetAtom = feedback.activeAtom;
    // During active interaction, use the actual interaction type, not the session mode
    effectiveMode = feedback.isDragging ? 'atom'
      : feedback.isMoving ? 'move'
      : 'rotate';
    intensity = 'active';
  } else if (feedback.hoverAtom >= 0) {
    targetAtom = feedback.hoverAtom;
    effectiveMode = sessionMode;
    intensity = 'hover';
  } else {
    return null;
  }

  // Atom mode: single atom only
  if (effectiveMode === 'atom') {
    return { atomIndex: targetAtom, groupAtomIndices: null, intensity };
  }

  // Move/Rotate mode: resolve bonded group from live physics topology
  if (physics.componentId && targetAtom < physics.n) {
    const cid = physics.componentId[targetAtom];
    if (cid >= 0 && cid < physics.components.length) {
      const group = physics.components[cid];
      if (group && group.atoms.length > 0) {
        return { atomIndex: targetAtom, groupAtomIndices: group.atoms, intensity };
      }
    }
  }

  // Topology unavailable for Move/Rotate — fail safe: no group highlight
  // (do not pretend the operation is atom-only when it actually affects a group)
  return null;
}
