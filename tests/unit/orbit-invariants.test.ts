/**
 * Orbit camera invariant tests for true arcball model.
 *
 * Verifies:
 * - One rigid rotation per drag step (offset and up evolve together)
 * - No pole singularity or special regime changes
 * - Radius preserved
 * - Camera basis remains orthonormal
 * - Consistent behavior regardless of current orientation
 */
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { computeOrbitDelta, applyOrbitRotation, TRIAD_CAMERA_DISTANCE } from '../../page/js/orbit-math';

// ── Shared orbit math from orbit-math.ts — tested directly, no duplication ──

/** Test tolerance constants */
const ORBIT_TEST_EPS = 0.001;

function applyOrbitDelta(
  cameraPos: THREE.Vector3,
  target: THREE.Vector3,
  cameraUp: THREE.Vector3,
  cameraQuat: THREE.Quaternion,
  dx: number,
  dy: number,
  speed: number,
) {
  const dq = computeOrbitDelta(dx, dy, speed, cameraQuat);
  if (!dq) return;

  applyOrbitRotation(dq, cameraPos, target, cameraUp);

  // Rebuild quaternion via lookAt (same as renderer)
  const cam = new THREE.PerspectiveCamera();
  cam.position.copy(cameraPos);
  cam.up.copy(cameraUp);
  cam.lookAt(target);
  cameraQuat.copy(cam.quaternion);
}

describe('arcball orbit invariants', () => {
  const speed = 0.005;
  const target = new THREE.Vector3(0, 0, 0);

  function makeCamera() {
    const pos = new THREE.Vector3(0, 0, 15);
    const up = new THREE.Vector3(0, 1, 0);
    const quat = new THREE.Quaternion();
    // Initialize quaternion from default pose
    const cam = new THREE.PerspectiveCamera();
    cam.position.copy(pos);
    cam.up.copy(up);
    cam.lookAt(target);
    quat.copy(cam.quaternion);
    return { pos, up, quat };
  }

  it('radius preserved through many drags', () => {
    const { pos, up, quat } = makeCamera();
    const r0 = pos.distanceTo(target);

    for (let i = 0; i < 500; i++) {
      applyOrbitDelta(pos, target, up, quat, Math.sin(i * 0.1) * 5, Math.cos(i * 0.1) * 3, speed);
    }

    expect(pos.distanceTo(target)).toBeCloseTo(r0, 4);
  });

  it('camera basis remains orthonormal after long drag sequence', () => {
    const { pos, up, quat } = makeCamera();

    for (let i = 0; i < 500; i++) {
      applyOrbitDelta(pos, target, up, quat, 3, 2, speed);
      applyOrbitDelta(pos, target, up, quat, -2, 5, speed);
    }

    // Derive basis from quaternion
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(quat);
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(quat);
    const upQ = new THREE.Vector3(0, 1, 0).applyQuaternion(quat);

    // Orthogonality
    expect(Math.abs(forward.dot(right))).toBeLessThan(0.001);
    expect(Math.abs(forward.dot(upQ))).toBeLessThan(0.001);
    expect(Math.abs(right.dot(upQ))).toBeLessThan(0.001);

    // Unit length
    expect(forward.length()).toBeCloseTo(1, 5);
    expect(right.length()).toBeCloseTo(1, 5);
    expect(upQ.length()).toBeCloseTo(1, 5);
  });

  it('continuous vertical drag passes through poles smoothly', () => {
    const { pos, up, quat } = makeCamera();
    const radius = pos.distanceTo(target);

    // Track Y values for smoothness check
    const yValues: number[] = [];
    for (let i = 0; i < 800; i++) {
      applyOrbitDelta(pos, target, up, quat, 0, 5, speed);
      yValues.push(pos.clone().sub(target).y);
    }

    // Should reach near the pole (high Y)
    const maxY = Math.max(...yValues);
    expect(maxY).toBeGreaterThan(radius * 0.9);

    // Motion should be smooth (no sudden jumps)
    for (let i = 1; i < yValues.length; i++) {
      expect(Math.abs(yValues[i] - yValues[i - 1])).toBeLessThan(1.0);
    }

    // Radius preserved
    expect(pos.distanceTo(target)).toBeCloseTo(radius, 3);
  });

  it('no special behavior at vertical extremes', () => {
    const { pos, up, quat } = makeCamera();

    // Get to near-pole position
    for (let i = 0; i < 300; i++) {
      applyOrbitDelta(pos, target, up, quat, 0, 5, speed);
    }

    // Record offset before additional drags at near-pole
    const beforeOffset = pos.clone().sub(target);

    // Further drags should still produce meaningful position changes
    for (let i = 0; i < 50; i++) {
      applyOrbitDelta(pos, target, up, quat, 0, 5, speed);
    }

    const afterOffset = pos.clone().sub(target);
    const posChange = beforeOffset.distanceTo(afterOffset);
    // Should not be stuck (meaningful motion continues)
    expect(posChange).toBeGreaterThan(0.1);
  });

  it('same drag path gives same result regardless of decomposition', () => {
    // Applying (dx=6, dy=4) in one step should give similar result
    // to applying (dx=3, dy=2) twice — tests rigid rotation consistency
    const c1 = makeCamera();
    const c2 = makeCamera();

    // One big step
    applyOrbitDelta(c1.pos, target, c1.up, c1.quat, 6, 4, speed);

    // Two half steps
    applyOrbitDelta(c2.pos, target, c2.up, c2.quat, 3, 2, speed);
    applyOrbitDelta(c2.pos, target, c2.up, c2.quat, 3, 2, speed);

    // Positions should be very close (not exact due to rotation composition)
    expect(c1.pos.distanceTo(c2.pos)).toBeLessThan(0.01);
  });

  it('triad = world axes projected through camera (semantic contract)', () => {
    // The triad scene has fixed +X/+Y/+Z arrows. _syncTriadFromCamera copies
    // camera.quaternion to the triad camera — the triad shows world-basis
    // arrows from the current view orientation.
    const { pos, up, quat } = makeCamera();

    for (let i = 0; i < 100; i++) {
      applyOrbitDelta(pos, target, up, quat, 3, 2, speed);
    }

    // Camera quaternion is valid (unit length)
    expect(quat.length()).toBeCloseTo(1, 5);

    // Forward vector from quaternion points from pos toward target
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(quat);
    const expected = new THREE.Vector3().subVectors(target, pos).normalize();
    expect(forward.dot(expected)).toBeGreaterThan(0.99);

    // World +X projected through camera quaternion gives a definite screen direction.
    // The KEY contract: the triad arrow for +X is always at world (1,0,0) in the
    // triad scene. The triad camera viewing it with this quaternion shows it from
    // the same angle as the main camera views the world. Axis identity is preserved.
    const worldX = new THREE.Vector3(1, 0, 0);
    const viewX = worldX.clone().applyQuaternion(quat.clone().invert());
    // viewX is where +X appears on screen — it should be a unit vector
    expect(viewX.length()).toBeCloseTo(1, 5);
  });

  // ── Drag-direction semantics ("dragging the world" convention) ──

  it('drag right moves camera leftward (world moves right on screen)', () => {
    // From default (0,0,15), drag right (dx>0) should orbit camera to negative X
    // so the world appears to move right ("dragging the world" convention)
    const { pos, up, quat } = makeCamera();
    applyOrbitDelta(pos, target, up, quat, 100, 0, speed);
    const offset = pos.clone().sub(target);
    expect(offset.x).toBeLessThan(0); // camera moved to -X side
  });

  it('drag left is the inverse of drag right', () => {
    const c1 = makeCamera();
    const c2 = makeCamera();
    applyOrbitDelta(c1.pos, target, c1.up, c1.quat, 100, 0, speed);
    applyOrbitDelta(c2.pos, target, c2.up, c2.quat, -100, 0, speed);
    const x1 = c1.pos.clone().sub(target).x;
    const x2 = c2.pos.clone().sub(target).x;
    expect(x1).toBeLessThan(0);
    expect(x2).toBeGreaterThan(0);
    expect(Math.abs(x1 + x2)).toBeLessThan(0.01); // symmetric
  });

  it('drag up moves camera upward (world moves up on screen)', () => {
    // From default (0,0,15), drag up (dy>0) should orbit camera to positive Y
    // so the world appears to slide up ("dragging the world" convention)
    const { pos, up, quat } = makeCamera();
    applyOrbitDelta(pos, target, up, quat, 0, 100, speed);
    const offset = pos.clone().sub(target);
    expect(offset.y).toBeGreaterThan(0); // camera moved above
  });

  it('drag down is the inverse of drag up', () => {
    const c1 = makeCamera();
    const c2 = makeCamera();
    applyOrbitDelta(c1.pos, target, c1.up, c1.quat, 0, 100, speed);
    applyOrbitDelta(c2.pos, target, c2.up, c2.quat, 0, -100, speed);
    const y1 = c1.pos.clone().sub(target).y;
    const y2 = c2.pos.clone().sub(target).y;
    expect(y1).toBeGreaterThan(0);
    expect(y2).toBeLessThan(0);
  });

  it('triad sync: real _syncTriadFromCamera preserves camera quaternion exactly', async () => {
    // Call the real Renderer method — guards against the exact regression where
    // a lookAt() call after quaternion.copy() silently overwrites the orientation.
    const { Renderer } = await import('../../page/js/renderer');
    const sync = (Renderer.prototype as any)._syncTriadFromCamera;

    // Build a minimal context with real Three.js cameras
    const camera = new THREE.PerspectiveCamera();
    const _axisCamera = new THREE.OrthographicCamera(-1.8, 1.8, 1.8, -1.8, 0.1, 10);

    // Orbit to a nontrivial orientation
    const pos = camera.position.clone().set(0, 0, 15);
    const up = camera.up.clone();
    const quat = camera.quaternion.clone();
    const cam = new THREE.PerspectiveCamera();
    cam.position.copy(pos); cam.up.copy(up); cam.lookAt(0, 0, 0);
    quat.copy(cam.quaternion);
    for (let i = 0; i < 80; i++) {
      applyOrbitDelta(pos, target, up, quat, 3, 5, speed);
    }
    camera.quaternion.copy(quat);

    // Call the real renderer method with our context
    sync.call({ camera, _axisCamera });

    // _axisCamera.quaternion must exactly match camera.quaternion
    expect(_axisCamera.quaternion.x).toBeCloseTo(camera.quaternion.x, 10);
    expect(_axisCamera.quaternion.y).toBeCloseTo(camera.quaternion.y, 10);
    expect(_axisCamera.quaternion.z).toBeCloseTo(camera.quaternion.z, 10);
    expect(_axisCamera.quaternion.w).toBeCloseTo(camera.quaternion.w, 10);

    // _axisCamera.position must be at TRIAD_CAMERA_DISTANCE along the rotated +Z axis
    expect(_axisCamera.position.length()).toBeCloseTo(TRIAD_CAMERA_DISTANCE, 5);
    const expectedPos = new THREE.Vector3(0, 0, TRIAD_CAMERA_DISTANCE)
      .applyQuaternion(camera.quaternion);
    expect(_axisCamera.position.distanceTo(expectedPos)).toBeLessThan(1e-10);
  });

  it('horizontal drag from default view preserves camera height', () => {
    const { pos, up, quat } = makeCamera();

    for (let i = 0; i < 100; i++) {
      applyOrbitDelta(pos, target, up, quat, 10, 0, speed);
    }

    const offset = pos.clone().sub(target);
    // From default (0,0,15), pure horizontal drag should keep Y near 0
    expect(Math.abs(offset.y)).toBeLessThan(0.5);
  });
});
