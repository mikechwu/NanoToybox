/**
 * Orbit-follow per-frame update — extracted from main.ts for testability.
 *
 * Resolves the tracked camera target's displayed bounds (live or review)
 * and smoothly tracks it via the renderer's orbit-follow camera.
 *
 * Uses camera-target-runtime for generic target resolution (molecule or
 * bonded group). Falls back to lastFocusedMoleculeId for compatibility.
 *
 * Owns: per-frame orbit-follow resolution (store read, bounds lookup, camera call).
 * Depends on: app-store (cameraTargetRef, orbitFollowEnabled, cameraMode),
 *             camera-target-runtime (resolveCameraTargetRef).
 * Called by: app/frame-runtime.ts (executeFrame, per-frame).
 * Teardown: stateless function — no teardown needed.
 */

import type * as THREE from 'three';
import { useAppStore, type CameraTargetRef } from '../store/app-store';
import {
  resolveCameraTargetRef,
  type CameraTargetDeps,
  type CameraTargetRendererSurface,
} from './camera-target-runtime';

/** Minimal renderer surface for orbit-follow updates. */
export interface OrbitFollowRendererSurface extends CameraTargetRendererSurface {
  getDisplayedMoleculeBounds(
    atomOffset: number,
    atomCount: number,
  ): { center: THREE.Vector3; radius: number } | null;
  updateOrbitFollow(dtMs: number, bounds: { center: THREE.Vector3; radius: number }): void;
}

/** Dependencies injected for bonded-group support. */
export interface OrbitFollowDeps {
  getBondedGroupAtoms: (groupId: string) => number[] | null;
}

/**
 * Per-frame orbit-follow update. Reads store state to determine if follow
 * is active, resolves the tracked target's displayed bounds via generic
 * camera-target-runtime, and calls the renderer's smooth camera tracking.
 */
export function updateOrbitFollowFromStore(
  renderer: OrbitFollowRendererSurface,
  frameDtMs: number,
  deps?: OrbitFollowDeps,
): void {
  const s = useAppStore.getState();
  if (!s.orbitFollowEnabled || s.cameraMode !== 'orbit') return;

  // Resolve target: prefer cameraTargetRef, fall back to lastFocusedMoleculeId
  let ref: CameraTargetRef | null = s.cameraTargetRef;
  if (!ref && s.lastFocusedMoleculeId !== null) {
    ref = { kind: 'molecule', moleculeId: s.lastFocusedMoleculeId };
  }
  if (!ref) return;

  const ctDeps: CameraTargetDeps = {
    renderer,
    molecules: s.molecules,
    getBondedGroupAtoms: deps?.getBondedGroupAtoms ?? (() => null),
  };

  const resolved = resolveCameraTargetRef(ref, ctDeps);
  if (resolved) {
    renderer.updateOrbitFollow(frameDtMs, { center: resolved.center, radius: resolved.radius });
  } else {
    // Target is invalid — disable follow cleanly to prevent "follow on but nothing happens"
    useAppStore.getState().setOrbitFollowEnabled(false);
    // Clear invalid cameraTargetRef if it matches the ref we just failed to resolve.
    // Migration note: lastFocusedMoleculeId is intentionally preserved as non-authoritative
    // fallback memory during the CameraTargetRef migration. Once the old molecule-only
    // compatibility path is removed, invalid follow should also clear lastFocusedMoleculeId.
    if (s.cameraTargetRef && s.cameraTargetRef === ref) {
      useAppStore.getState().setCameraTargetRef(null);
    }
  }
}
