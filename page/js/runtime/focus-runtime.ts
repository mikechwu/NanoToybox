/**
 * Focus runtime — owns focus RESOLUTION (which molecule, what centroid,
 * update camera + store). Callers own focus TRIGGER ELIGIBILITY (when to
 * call these helpers based on interaction mode, placement state, etc.).
 *
 * Responsibility split:
 * - focus-runtime.ts: molecule lookup, centroid computation, setCameraFocusTarget,
 *   setLastFocusedMoleculeId. Does NOT decide when to focus — only how.
 * - interaction-dispatch.ts: calls focusMoleculeByAtom on startDrag/Move/Rotate
 *   (trigger: any direct object interaction).
 * - scene-runtime.ts: calls focusNewestPlacedMolecule on placement commit
 *   (trigger: placementActive === true gate owned by scene-runtime).
 * - scene-runtime.ts: clears lastFocusedMoleculeId on clearPlayground
 *   (scene lifecycle reset, not focus resolution).
 *
 * Does NOT own the store fields — reads molecules and writes
 * lastFocusedMoleculeId via the store API.
 */

import type * as THREE from 'three';
import { useAppStore, type MoleculeMetadata } from '../store/app-store';

/** Minimal renderer surface needed for focus operations. */
export interface FocusRendererSurface {
  getMoleculeCentroid(atomOffset: number, atomCount: number): THREE.Vector3 | null;
  getMoleculeBounds(atomOffset: number, atomCount: number): { center: THREE.Vector3; radius: number } | null;
  setCameraFocusTarget(target: THREE.Vector3): void;
  animateToFocusedObject(opts?: { levelUp?: boolean }): void;
  camera: { position: THREE.Vector3 };
}

/** Typed return-target descriptor for shared recovery logic. */
export interface ReturnTarget {
  kind: 'molecule' | 'scene-origin';
  position: THREE.Vector3;
  radius: number;
  moleculeId?: number;
  guardrailEligible: boolean;
}

/**
 * Resolve the best return target for ↩ Return to Object and far-drift guardrail.
 * Single source of truth — consumed by both animation and threshold computation.
 */
export function resolveReturnTarget(
  renderer: FocusRendererSurface,
  sceneRadius: number,
): ReturnTarget {
  const store = useAppStore.getState();
  const molecules = store.molecules;

  // Priority 1: valid last-focused molecule
  if (store.lastFocusedMoleculeId !== null) {
    const mol = molecules.find(m => m.id === store.lastFocusedMoleculeId);
    if (mol) {
      const bounds = renderer.getMoleculeBounds(mol.atomOffset, mol.atomCount);
      if (bounds) {
        return { kind: 'molecule', position: bounds.center, radius: bounds.radius, moleculeId: mol.id, guardrailEligible: true };
      }
    }
  }

  // Priority 2: nearest molecule to camera
  if (molecules.length > 0) {
    let bestMol = molecules[0];
    let bestDist = Infinity;
    const camPos = renderer.camera.position;
    for (const mol of molecules) {
      const c = renderer.getMoleculeCentroid(mol.atomOffset, mol.atomCount);
      if (!c) continue;
      const d = camPos.distanceToSquared(c);
      if (d < bestDist) { bestDist = d; bestMol = mol; }
    }
    const bounds = renderer.getMoleculeBounds(bestMol.atomOffset, bestMol.atomCount);
    if (bounds) {
      return { kind: 'molecule', position: bounds.center, radius: bounds.radius, moleculeId: bestMol.id, guardrailEligible: true };
    }
  }

  // Priority 3: scene origin (no guardrail)
  // Use the same Vector3 constructor as the renderer's camera position
  const origin = renderer.camera.position.clone().set(0, 0, 0);
  return { kind: 'scene-origin', position: origin, radius: sceneRadius, guardrailEligible: false };
}

/**
 * Track which molecule the user is interacting with (store ID only).
 * Does NOT retarget the camera pivot — plain clicks and interaction starts
 * should not snap the view. Camera retarget only happens via explicit
 * Center Object / Return to Object actions.
 *
 * Updates lastFocusedMoleculeId for Center Object resolution.
 */
export function focusMoleculeByAtom(
  atomIdx: number,
  _renderer: FocusRendererSurface,
): void {
  const molecules = useAppStore.getState().molecules;
  const mol = findMoleculeForAtom(atomIdx, molecules);
  if (!mol) return;
  useAppStore.getState().setLastFocusedMoleculeId(mol.id);
}

/**
 * Focus the camera on the most recently added molecule.
 * Used after placement commit. No-op if no molecules exist.
 */
export function focusNewestPlacedMolecule(
  renderer: FocusRendererSurface,
): void {
  const molecules = useAppStore.getState().molecules;
  if (molecules.length === 0) return;
  const newest = molecules[molecules.length - 1];
  const centroid = renderer.getMoleculeCentroid(newest.atomOffset, newest.atomCount);
  if (!centroid) return;
  useAppStore.getState().setLastFocusedMoleculeId(newest.id);
  renderer.setCameraFocusTarget(centroid);
}

/**
 * Center Object action: resolve the best focus target.
 * Priority: valid last-focused → single molecule → pick-focus mode (ambiguous).
 * Returns true if focus was set immediately, false if pick-focus mode was entered.
 * No-ops and returns true if no molecules exist.
 */
export function handleCenterObject(renderer: FocusRendererSurface): boolean {
  const store = useAppStore.getState();
  const molecules = store.molecules;
  if (molecules.length === 0) return true;

  // Priority 1: valid last-focused molecule
  if (store.lastFocusedMoleculeId !== null) {
    const mol = molecules.find(m => m.id === store.lastFocusedMoleculeId);
    if (mol) {
      // Animated framing instead of instant pivot
      renderer.animateToFocusedObject();
      return true;
    }
  }

  // Priority 2: single molecule — direct center
  if (molecules.length === 1) {
    useAppStore.getState().setLastFocusedMoleculeId(molecules[0].id);
    renderer.animateToFocusedObject();
    return true;
  }

  // Priority 3: ambiguous — enter pick-focus mode
  useAppStore.getState().setPickFocusActive(true);
  return false;
}

/**
 * Find which molecule contains the given atom index.
 * Exported for testing.
 */
export function findMoleculeForAtom(
  atomIdx: number,
  molecules: readonly MoleculeMetadata[],
): MoleculeMetadata | null {
  for (const mol of molecules) {
    if (atomIdx >= mol.atomOffset && atomIdx < mol.atomOffset + mol.atomCount) {
      return mol;
    }
  }
  return null;
}
