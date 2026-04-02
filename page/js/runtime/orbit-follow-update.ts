/**
 * Orbit-follow per-frame update — extracted from main.ts for testability.
 *
 * Resolves the tracked molecule's displayed bounds (live or review)
 * and smoothly tracks it via the renderer's orbit-follow camera.
 *
 * Owns: per-frame orbit-follow resolution (store read, bounds lookup, camera call).
 * Depends on: app-store (orbitFollowEnabled, cameraMode, molecules), Renderer (bounds + camera).
 * Called by: app/frame-runtime.ts (executeFrame, per-frame).
 * Teardown: stateless function — no teardown needed. Lifetime tied to caller.
 */

import type * as THREE from 'three';
import { useAppStore } from '../store/app-store';

/** Minimal renderer surface for orbit-follow updates. */
export interface OrbitFollowRendererSurface {
  getDisplayedMoleculeBounds(
    atomOffset: number,
    atomCount: number,
  ): { center: THREE.Vector3; radius: number } | null;
  updateOrbitFollow(dtMs: number, bounds: { center: THREE.Vector3; radius: number }): void;
}

/**
 * Per-frame orbit-follow update. Reads store state to determine if follow
 * is active, resolves the tracked molecule's displayed bounds, and calls
 * the renderer's smooth camera tracking.
 */
export function updateOrbitFollowFromStore(
  renderer: OrbitFollowRendererSurface,
  frameDtMs: number,
): void {
  const s = useAppStore.getState();
  if (!s.orbitFollowEnabled || s.cameraMode !== 'orbit') return;
  if (s.lastFocusedMoleculeId === null) return;
  const mol = s.molecules.find(m => m.id === s.lastFocusedMoleculeId);
  if (!mol) return;
  const bounds = renderer.getDisplayedMoleculeBounds(mol.atomOffset, mol.atomCount);
  if (bounds) renderer.updateOrbitFollow(frameDtMs, bounds);
}
