/**
 * Pure orbit math — shared between renderer and tests.
 *
 * Rigid trackball: one SO(3) rotation per drag step. Screen drag maps to a
 * rotation axis perpendicular to drag direction (in camera-local space),
 * transformed to world space. Both offset and camera.up evolve under the
 * same quaternion — no yaw/pitch decomposition, no post-hoc correction.
 *
 * This is a first-order Shoemake arcball approximation, exact for small
 * per-frame deltas. "Dragging the world" convention: drag right = world
 * moves right on screen, drag up = world moves up.
 */
import * as THREE from 'three';

/** Minimum arcball rotation angle in radians. Prevents numerical noise from
 *  sub-pixel drag deltas. Not a UX tuning knob — purely numerical hygiene. */
export const MIN_ARCBALL_ANGLE_RAD = 1e-8;

/** Distance from triad camera to triad scene origin. Shared between
 *  renderer init, runtime sync, and tests. */
export const TRIAD_CAMERA_DISTANCE = 4;

/**
 * Compute the incremental orbit quaternion from a screen drag delta.
 * Returns null if the delta is below the minimum threshold.
 *
 * @param dx - horizontal screen delta (positive = drag right)
 * @param dy - vertical screen delta (positive = drag up)
 * @param speed - radians per pixel
 * @param cameraQuat - current camera orientation (for axis transform)
 */
export function computeOrbitDelta(
  dx: number,
  dy: number,
  speed: number,
  cameraQuat: THREE.Quaternion,
): THREE.Quaternion | null {
  const angle = Math.sqrt(dx * dx + dy * dy) * speed;
  if (angle < MIN_ARCBALL_ANGLE_RAD) return null;

  // Screen-space drag (dx, dy) → rotation axis (-dy, -dx, 0) in camera frame.
  // -dx: "dragging the world" horizontal convention
  // -dy: "dragging the world" vertical convention
  const localAxis = new THREE.Vector3(-dy, -dx, 0).normalize();
  const worldAxis = localAxis.applyQuaternion(cameraQuat);

  return new THREE.Quaternion().setFromAxisAngle(worldAxis, angle);
}

/**
 * Apply an orbit rotation to camera state (rigid body: offset + up together).
 *
 * @param dq - incremental rotation quaternion
 * @param cameraPos - camera position (mutated)
 * @param target - orbit target (read-only)
 * @param cameraUp - camera up vector (mutated)
 */
export function applyOrbitRotation(
  dq: THREE.Quaternion,
  cameraPos: THREE.Vector3,
  target: THREE.Vector3,
  cameraUp: THREE.Vector3,
): void {
  const offset = cameraPos.clone().sub(target);
  offset.applyQuaternion(dq);
  cameraUp.applyQuaternion(dq);
  cameraPos.copy(target).add(offset);
}
