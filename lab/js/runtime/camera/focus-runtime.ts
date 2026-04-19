/**
 * Focus runtime — owns focus RESOLUTION and camera-target actions.
 *
 * Uses camera-target-runtime.ts for generic target resolution (molecule or
 * bonded group). All center/follow/return actions share one resolution path.
 *
 * Responsibility split:
 * - focus-runtime.ts: target resolution, camera actions (center, follow, return).
 * - camera-target-runtime.ts: pure resolution logic (ref → bounds).
 * - interaction-dispatch.ts: calls focusMoleculeByAtom on drag/move/rotate start.
 * - scene-runtime.ts: clears target on clearPlayground.
 *
 * Placement commit does NOT change focus metadata or retarget camera (Policy A).
 *
 * @module focus-runtime
 */

import type * as THREE from 'three';
import { useAppStore, type MoleculeMetadata, type CameraTargetRef } from '../../store/app-store';
import {
  resolveCameraTargetRef,
  resolveBestDefaultCameraTarget,
  type CameraTargetDeps,
  type CameraTargetRendererSurface,
  type ResolvedCameraTarget,
} from './camera-target-runtime';

/** Minimal renderer surface needed for focus operations.
 *  Extends CameraTargetRendererSurface (getDisplayedMoleculeBounds,
 *  getDisplayedAtomWorldPosition, camera.position, getSceneRadius) which
 *  the target resolver needs. Focus-runtime itself only adds animateToFramedTarget. */
export interface FocusRendererSurface extends CameraTargetRendererSurface {
  animateToFramedTarget(target: { center: THREE.Vector3; radius: number }, opts?: { levelUp?: boolean; onComplete?: () => void }): void;
}

/** Dependencies injected by main.ts for bonded-group atom lookup. */
export interface FocusTargetDeps {
  getBondedGroupAtoms: (groupId: string) => number[] | null;
}

/** Typed return-target descriptor for shared recovery logic. */
export interface ReturnTarget {
  kind: 'molecule' | 'bonded-group' | 'scene-origin';
  position: THREE.Vector3;
  radius: number;
  moleculeId?: number;
  groupId?: string;
  guardrailEligible: boolean;
}

// ── Helpers ──

function buildCameraTargetDeps(renderer: FocusRendererSurface, deps?: FocusTargetDeps): CameraTargetDeps {
  return {
    renderer,
    molecules: useAppStore.getState().molecules,
    getBondedGroupAtoms: deps?.getBondedGroupAtoms ?? (() => null),
  };
}

/**
 * Pure resolution: resolve the current camera target ref, or fall back to
 * a default. Does NOT mutate store state (no side effects).
 * Use commitDefault=true only for explicit user actions (Center, Follow).
 */
function resolveCurrentOrDefault(
  renderer: FocusRendererSurface,
  deps?: FocusTargetDeps,
  opts?: { commitDefault?: boolean },
): ResolvedCameraTarget | null {
  const store = useAppStore.getState();
  const ctDeps = buildCameraTargetDeps(renderer, deps);

  // Try explicit cameraTargetRef first
  if (store.cameraTargetRef) {
    const resolved = resolveCameraTargetRef(store.cameraTargetRef, ctDeps);
    if (resolved) return resolved;
  }

  // Fall back to lastFocusedMoleculeId (compatibility)
  if (store.lastFocusedMoleculeId !== null) {
    const ref: CameraTargetRef = { kind: 'molecule', moleculeId: store.lastFocusedMoleculeId };
    const resolved = resolveCameraTargetRef(ref, ctDeps);
    if (resolved) return resolved;
  }

  // Fall back to best default
  const defaultRef = resolveBestDefaultCameraTarget(ctDeps);
  if (defaultRef) {
    const resolved = resolveCameraTargetRef(defaultRef, ctDeps);
    if (resolved) {
      // Only commit default to store on explicit user actions
      if (opts?.commitDefault) {
        useAppStore.getState().setCameraTargetRef(defaultRef);
        if (defaultRef.kind === 'molecule') {
          useAppStore.getState().setLastFocusedMoleculeId(defaultRef.moleculeId);
        }
      }
      return resolved;
    }
  }

  return null;
}

// ── Public API ──

/**
 * Resolve the best return target for Return to Object and far-drift guardrail.
 */
export function resolveReturnTarget(
  renderer: FocusRendererSurface,
  sceneRadius: number,
  deps?: FocusTargetDeps,
): ReturnTarget {
  const resolved = resolveCurrentOrDefault(renderer, deps, { commitDefault: false });
  if (resolved) {
    return {
      kind: resolved.kind,
      position: resolved.center,
      radius: resolved.radius,
      moleculeId: resolved.moleculeId,
      groupId: resolved.groupId,
      guardrailEligible: true,
    };
  }

  const origin = renderer.camera.position.clone().set(0, 0, 0);
  return { kind: 'scene-origin', position: origin, radius: sceneRadius, guardrailEligible: false };
}

/**
 * Track which molecule the user is interacting with (store ID only).
 * Updates both lastFocusedMoleculeId (compatibility) and cameraTargetRef.
 */
export function focusMoleculeByAtom(
  atomIdx: number,
  renderer: FocusRendererSurface,
): void {
  const molecules = useAppStore.getState().molecules;
  const mol = findMoleculeForAtom(atomIdx, molecules);
  if (!mol) return;
  if (!useAppStore.getState().orbitFollowEnabled) {
    useAppStore.getState().setLastFocusedMoleculeId(mol.id);
    useAppStore.getState().setCameraTargetRef({ kind: 'molecule', moleculeId: mol.id });
  }
}

/**
 * Ensure a valid follow target exists before enabling orbit-follow.
 * Returns true if a target was resolved (follow may proceed).
 */
export function ensureFollowTarget(
  renderer: FocusRendererSurface,
  deps?: FocusTargetDeps,
): boolean {
  const store = useAppStore.getState();
  if (store.molecules.length === 0) return false;

  const resolved = resolveCurrentOrDefault(renderer, deps, { commitDefault: true });
  if (resolved) return true;

  return false;
}

/**
 * Center Object action: animate camera to the best focus target.
 * Resolves through generic cameraTargetRef → camera-target-runtime.
 */
export function handleCenterObject(
  renderer: FocusRendererSurface,
  deps?: FocusTargetDeps,
): void {
  const store = useAppStore.getState();
  if (store.molecules.length === 0) return;

  const resolved = resolveCurrentOrDefault(renderer, deps, { commitDefault: true });
  if (resolved) {
    renderer.animateToFramedTarget({ center: resolved.center, radius: resolved.radius });
  }
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
