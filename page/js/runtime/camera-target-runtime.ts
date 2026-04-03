/**
 * Camera target resolution runtime — resolves generic camera target references
 * (molecule or bonded group) into framing bounds { center, radius }.
 *
 * Owns: target resolution logic, default-target fallback, target validity.
 * Does not: own camera state, trigger camera actions, or modify store.
 * Called by: focus-runtime.ts, orbit-follow-update.ts, main.ts wiring.
 * Teardown: stateless module (pure functions).
 */

import type * as THREE from 'three';
import type { MoleculeMetadata, CameraTargetRef } from '../store/app-store';
import { CONFIG } from '../config';

// ── Types ──

export interface CameraTargetRendererSurface {
  getDisplayedMoleculeBounds(
    atomOffset: number,
    atomCount: number,
  ): { center: THREE.Vector3; radius: number } | null;

  getDisplayedAtomWorldPosition(atomIndex: number): THREE.Vector3 | null;

  camera: { position: THREE.Vector3 };
  getSceneRadius(): number;
}

export interface CameraTargetDeps {
  renderer: CameraTargetRendererSurface;
  molecules: readonly MoleculeMetadata[];
  getBondedGroupAtoms: (groupId: string) => number[] | null;
}

export interface ResolvedCameraTarget {
  kind: 'molecule' | 'bonded-group';
  center: THREE.Vector3;
  radius: number;
  moleculeId?: number;
  groupId?: string;
}

// ── Resolution ──

/**
 * Resolve a CameraTargetRef to framing bounds using displayed positions.
 * Returns null if the target is invalid or positions are unavailable.
 */
export function resolveCameraTargetRef(
  ref: CameraTargetRef,
  deps: CameraTargetDeps,
): ResolvedCameraTarget | null {
  if (ref.kind === 'molecule') {
    return resolveMoleculeTarget(ref.moleculeId, deps);
  }
  if (ref.kind === 'bonded-group') {
    return resolveBondedGroupTarget(ref.groupId, deps);
  }
  return null;
}

function resolveMoleculeTarget(
  moleculeId: number,
  deps: CameraTargetDeps,
): ResolvedCameraTarget | null {
  const mol = deps.molecules.find(m => m.id === moleculeId);
  if (!mol) return null;
  const bounds = deps.renderer.getDisplayedMoleculeBounds(mol.atomOffset, mol.atomCount);
  if (!bounds) return null;
  return {
    kind: 'molecule',
    center: bounds.center,
    radius: bounds.radius,
    moleculeId,
  };
}

function resolveBondedGroupTarget(
  groupId: string,
  deps: CameraTargetDeps,
): ResolvedCameraTarget | null {
  const atomIndices = deps.getBondedGroupAtoms(groupId);
  if (!atomIndices || atomIndices.length === 0) return null;

  // Compute centroid from displayed positions
  let cx = 0, cy = 0, cz = 0;
  let count = 0;
  for (const idx of atomIndices) {
    const pos = deps.renderer.getDisplayedAtomWorldPosition(idx);
    if (!pos) return null; // conservative: fail if any atom position unavailable
    cx += pos.x;
    cy += pos.y;
    cz += pos.z;
    count++;
  }
  if (count === 0) return null;
  cx /= count; cy /= count; cz /= count;

  // Compute bounding radius from centroid
  let maxDistSq = 0;
  for (const idx of atomIndices) {
    const pos = deps.renderer.getDisplayedAtomWorldPosition(idx)!;
    const dx = pos.x - cx, dy = pos.y - cy, dz = pos.z - cz;
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 > maxDistSq) maxDistSq = d2;
  }

  // Use same atom visual radius as molecule bounds for consistency
  const radius = Math.sqrt(maxDistSq) + CONFIG.camera.atomVisualRadius;

  // Construct center Vector3 from the first resolved position's constructor
  const firstPos = deps.renderer.getDisplayedAtomWorldPosition(atomIndices[0])!;
  const center = firstPos.clone().set(cx, cy, cz);

  return {
    kind: 'bonded-group',
    center,
    radius,
    groupId,
  };
}

// ── Default target fallback ──

/**
 * Find the best default camera target when no explicit target is set.
 * Priority: single molecule → nearest molecule to camera.
 */
export function resolveBestDefaultCameraTarget(
  deps: CameraTargetDeps,
): CameraTargetRef | null {
  if (deps.molecules.length === 0) return null;
  if (deps.molecules.length === 1) {
    return { kind: 'molecule', moleculeId: deps.molecules[0].id };
  }
  // Nearest molecule to camera
  let bestMol = deps.molecules[0];
  let bestDist = Infinity;
  const camPos = deps.renderer.camera.position;
  for (const mol of deps.molecules) {
    const bounds = deps.renderer.getDisplayedMoleculeBounds(mol.atomOffset, mol.atomCount);
    if (!bounds) continue;
    const d = camPos.distanceToSquared(bounds.center);
    if (d < bestDist) { bestDist = d; bestMol = mol; }
  }
  return { kind: 'molecule', moleculeId: bestMol.id };
}

// ── Validity ──

/**
 * Check whether a stored camera target ref is still usable.
 */
export function isCameraTargetRefValid(
  ref: CameraTargetRef,
  deps: CameraTargetDeps,
): boolean {
  if (ref.kind === 'molecule') {
    return deps.molecules.some(m => m.id === ref.moleculeId);
  }
  if (ref.kind === 'bonded-group') {
    const atoms = deps.getBondedGroupAtoms(ref.groupId);
    return atoms !== null && atoms.length > 0;
  }
  return false;
}
