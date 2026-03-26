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
  setCameraFocusTarget(target: THREE.Vector3): void;
}

/**
 * Find the molecule containing the given atom and focus the camera on it.
 * Updates controls.target and lastFocusedMoleculeId.
 * No-op if the atom doesn't belong to any known molecule or physics is unavailable.
 */
export function focusMoleculeByAtom(
  atomIdx: number,
  renderer: FocusRendererSurface,
): void {
  const molecules = useAppStore.getState().molecules;
  const mol = findMoleculeForAtom(atomIdx, molecules);
  if (!mol) return;
  const centroid = renderer.getMoleculeCentroid(mol.atomOffset, mol.atomCount);
  if (!centroid) return;
  renderer.setCameraFocusTarget(centroid);
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
  renderer.setCameraFocusTarget(centroid);
  useAppStore.getState().setLastFocusedMoleculeId(newest.id);
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
      const centroid = renderer.getMoleculeCentroid(mol.atomOffset, mol.atomCount);
      if (centroid) {
        renderer.setCameraFocusTarget(centroid);
        return true;
      }
    }
  }

  // Priority 2: single molecule — direct center
  if (molecules.length === 1) {
    const mol = molecules[0];
    const centroid = renderer.getMoleculeCentroid(mol.atomOffset, mol.atomCount);
    if (centroid) {
      renderer.setCameraFocusTarget(centroid);
      useAppStore.getState().setLastFocusedMoleculeId(mol.id);
    }
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
