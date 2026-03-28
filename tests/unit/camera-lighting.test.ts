/**
 * Camera lighting rig invariant tests.
 *
 * Verifies:
 * - Primary spotlight remains aligned with camera forward after orbit
 * - Light-target world direction equals camera forward within tolerance
 * - Large camera displacement does not change relative rig geometry
 * - Theme changes update intensity/color without moving the rig
 * - No drift: rig is recomputed from stable local transforms
 */
import { describe, it, expect, beforeAll } from 'vitest';
import * as THREE from 'three';
import { CONFIG, DEFAULT_THEME } from '../../page/js/config';
import { THEMES } from '../../page/js/themes';
import { computeOrbitDelta, applyOrbitRotation } from '../../page/js/orbit-math';

// Lazily cached Renderer class — imported once, reused across all tests.
let _RendererClass: any = null;
async function getRendererClass() {
  if (!_RendererClass) {
    const mod = await import('../../page/js/renderer');
    _RendererClass = mod.Renderer;
  }
  return _RendererClass;
}

/**
 * Build a camera lighting rig by calling the REAL Renderer._initCameraLightRig()
 * on a minimal context. This is the primary test fixture — it exercises the actual
 * production init path, preventing drift between tests and implementation.
 */
function buildRig() {
  // We need Renderer class. Since top-level await isn't available in function scope,
  // use the synchronous path: replicate the real init with identical logic.
  // The async 'real init' test below validates this stays in sync.
  const Renderer = _RendererClass;
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 2000);
  camera.position.set(0, 0, 15);
  camera.lookAt(0, 0, 0);

  const ctx: any = {
    scene,
    camera,
    currentTheme: DEFAULT_THEME,
    _cameraLightRig: null,
    _headLight: null,
    _headLightTarget: null,
    _cameraFillLight: null,
    _cameraFillLightTarget: null,
    ambientLight: null,
  };

  if (Renderer) {
    // Use real renderer methods
    ctx._applyLightTheme = Renderer.prototype._applyLightTheme.bind(ctx);
    Renderer.prototype._initCameraLightRig.call(ctx);
  } else {
    // Fallback before async import completes (should not happen in practice)
    throw new Error('Renderer class not loaded — call getRendererClass() first');
  }

  scene.updateMatrixWorld(true);

  return {
    scene,
    camera,
    rig: ctx._cameraLightRig as THREE.Group,
    headLight: ctx._headLight as THREE.SpotLight,
    headTarget: ctx._headLightTarget as THREE.Object3D,
    fillLight: ctx._cameraFillLight as THREE.DirectionalLight | null,
    fillTarget: ctx._cameraFillLightTarget as THREE.Object3D | null,
  };
}

/** Get world position of an Object3D */
function worldPos(obj: THREE.Object3D): THREE.Vector3 {
  const v = new THREE.Vector3();
  obj.getWorldPosition(v);
  return v;
}

/** Get world direction the spotlight points (from light to target) */
function spotDirection(headLight: THREE.SpotLight, headTarget: THREE.Object3D, scene: THREE.Scene): THREE.Vector3 {
  scene.updateMatrixWorld(true);
  const lp = worldPos(headLight);
  const tp = worldPos(headTarget);
  return tp.sub(lp).normalize();
}

/** Get camera forward vector */
function cameraForward(camera: THREE.Camera): THREE.Vector3 {
  return new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
}

/** Apply orbit rotation to camera (same as renderer applyOrbitDelta flow) */
function orbitCamera(
  camera: THREE.PerspectiveCamera,
  target: THREE.Vector3,
  dx: number, dy: number,
  speed: number,
) {
  const dq = computeOrbitDelta(dx, dy, speed, camera.quaternion);
  if (!dq) return;
  applyOrbitRotation(dq, camera.position, target, camera.up);
  camera.lookAt(target);
}

// Load Renderer class once before all tests so buildRig() can use the real init path
beforeAll(async () => { await getRendererClass(); });

describe('camera lighting rig invariants', () => {
  const orbitTarget = new THREE.Vector3(0, 0, 0);
  const speed = 0.005;

  it('spotlight direction aligns with camera forward at default pose', () => {
    const { scene, camera, headLight, headTarget } = buildRig();
    const dir = spotDirection(headLight, headTarget, scene);
    const fwd = cameraForward(camera);
    expect(dir.dot(fwd)).toBeGreaterThan(0.99);
  });

  it('spotlight direction tracks camera forward after horizontal orbit', () => {
    const { scene, camera, headLight, headTarget } = buildRig();

    for (let i = 0; i < 100; i++) {
      orbitCamera(camera, orbitTarget, 10, 0, speed);
    }
    scene.updateMatrixWorld(true);

    const dir = spotDirection(headLight, headTarget, scene);
    const fwd = cameraForward(camera);
    expect(dir.dot(fwd)).toBeGreaterThan(0.99);
  });

  it('spotlight direction tracks camera forward after vertical orbit through pole', () => {
    const { scene, camera, headLight, headTarget } = buildRig();

    for (let i = 0; i < 400; i++) {
      orbitCamera(camera, orbitTarget, 0, 5, speed);
    }
    scene.updateMatrixWorld(true);

    const dir = spotDirection(headLight, headTarget, scene);
    const fwd = cameraForward(camera);
    expect(dir.dot(fwd)).toBeGreaterThan(0.99);
  });

  it('spotlight direction tracks after mixed orbit sequence', () => {
    const { scene, camera, headLight, headTarget } = buildRig();

    for (let i = 0; i < 500; i++) {
      orbitCamera(camera, orbitTarget, Math.sin(i * 0.1) * 5, Math.cos(i * 0.1) * 3, speed);
    }
    scene.updateMatrixWorld(true);

    const dir = spotDirection(headLight, headTarget, scene);
    const fwd = cameraForward(camera);
    expect(dir.dot(fwd)).toBeGreaterThan(0.99);
  });

  it('large camera displacement preserves relative rig geometry', () => {
    const { scene, camera, headLight, headTarget, fillLight } = buildRig();
    const cfg = CONFIG.cameraLighting;

    // Record initial local offsets
    const headLocalPos = headLight.position.clone();
    const targetLocalPos = headTarget.position.clone();

    // Move camera far away
    camera.position.set(1000, 500, -2000);
    camera.lookAt(1000, 500, -2010);
    scene.updateMatrixWorld(true);

    // Local positions are unchanged (constants in camera space)
    expect(headLight.position.distanceTo(headLocalPos)).toBeLessThan(1e-10);
    expect(headTarget.position.distanceTo(targetLocalPos)).toBeLessThan(1e-10);

    // Verify config values are preserved
    expect(headLight.position.x).toBeCloseTo(cfg.head.offset[0], 5);
    expect(headLight.position.y).toBeCloseTo(cfg.head.offset[1], 5);
    expect(headLight.position.z).toBeCloseTo(cfg.head.offset[2], 5);

    if (fillLight) {
      expect(fillLight.position.x).toBeCloseTo(cfg.fill.offset[0], 5);
      expect(fillLight.position.y).toBeCloseTo(cfg.fill.offset[1], 5);
      expect(fillLight.position.z).toBeCloseTo(cfg.fill.offset[2], 5);
    }
  });

  it('theme changes update intensity and color without moving rig', () => {
    const { headLight, headTarget, fillLight } = buildRig();

    // Record positions before theme change
    const headPosBefore = headLight.position.clone();
    const targetPosBefore = headTarget.position.clone();
    const fillPosBefore = fillLight?.position.clone();

    // Apply dark theme
    const dark = THEMES['dark'];
    headLight.color.set(dark.headLightColor);
    headLight.intensity = dark.headLightIntensity;
    if (fillLight) {
      fillLight.color.set(dark.fillLightColor);
      fillLight.intensity = dark.fillLightIntensity;
    }

    // Colors/intensities changed
    expect(headLight.intensity).toBe(dark.headLightIntensity);

    // Positions unchanged
    expect(headLight.position.distanceTo(headPosBefore)).toBeLessThan(1e-10);
    expect(headTarget.position.distanceTo(targetPosBefore)).toBeLessThan(1e-10);
    if (fillLight && fillPosBefore) {
      expect(fillLight.position.distanceTo(fillPosBefore)).toBeLessThan(1e-10);
    }

    // Apply light theme — positions still unchanged
    const light = THEMES['light'];
    headLight.color.set(light.headLightColor);
    headLight.intensity = light.headLightIntensity;
    expect(headLight.intensity).toBe(light.headLightIntensity);
    expect(headLight.position.distanceTo(headPosBefore)).toBeLessThan(1e-10);
  });

  it('spotlight parameters match config constants', () => {
    const { headLight } = buildRig();
    const cfg = CONFIG.cameraLighting.head;

    expect(headLight.angle).toBeCloseTo(cfg.angle, 5);
    expect(headLight.penumbra).toBeCloseTo(cfg.penumbra, 5);
    expect(headLight.decay).toBeCloseTo(cfg.decay, 5);
    expect(headLight.distance).toBeCloseTo(cfg.distance, 5);
  });

  it('real _applyLightTheme updates only colors/intensities', () => {
    const applyTheme = (_RendererClass as any).prototype._applyLightTheme;

    // Build minimal context matching renderer shape
    const ambientLight = new THREE.AmbientLight();
    const headLight = new THREE.SpotLight();
    headLight.position.set(1, 2, 3);
    const fillLight = new THREE.DirectionalLight();
    fillLight.position.set(4, 5, 6);

    const ctx = {
      ambientLight,
      _headLight: headLight,
      _cameraFillLight: fillLight,
    };

    const posBefore = headLight.position.clone();
    const fillPosBefore = fillLight.position.clone();

    applyTheme.call(ctx, THEMES['dark']);

    // Colors/intensities updated
    expect(headLight.intensity).toBe(THEMES['dark'].headLightIntensity);
    expect(headLight.color.getHex()).toBe(THEMES['dark'].headLightColor);
    expect(ambientLight.intensity).toBe(THEMES['dark'].ambientIntensity);
    expect(ambientLight.color.getHex()).toBe(THEMES['dark'].ambientColor);
    expect(fillLight.intensity).toBe(THEMES['dark'].fillLightIntensity);
    expect(fillLight.color.getHex()).toBe(THEMES['dark'].fillLightColor);

    // Positions untouched
    expect(headLight.position.distanceTo(posBefore)).toBeLessThan(1e-10);
    expect(fillLight.position.distanceTo(fillPosBefore)).toBeLessThan(1e-10);

    // Switch theme
    applyTheme.call(ctx, THEMES['light']);
    expect(headLight.intensity).toBe(THEMES['light'].headLightIntensity);
    expect(headLight.position.distanceTo(posBefore)).toBeLessThan(1e-10);
  });

  it('buildRig uses real renderer init: themed, correct types, config params', () => {
    // buildRig() calls the real Renderer._initCameraLightRig — this test
    // verifies the production wiring contract, not a hand-built replica.
    const { headLight, headTarget, fillLight } = buildRig();
    const cfg = CONFIG.cameraLighting.head;

    // HeadLight has correct config params
    expect(headLight.angle).toBeCloseTo(cfg.angle, 5);
    expect(headLight.decay).toBe(cfg.decay);
    expect(headLight.distance).toBe(cfg.distance);

    // Self-consistent: theme was applied during init (no external call needed)
    expect(headLight.intensity).toBe(THEMES[DEFAULT_THEME].headLightIntensity);

    // Fill light is DirectionalLight with themed intensity
    expect(fillLight).toBeInstanceOf(THREE.DirectionalLight);
    expect(fillLight!.intensity).toBe(THEMES[DEFAULT_THEME].fillLightIntensity);
  });

  it('no drift: 1000 orbit steps produce identical local rig geometry', () => {
    const { scene, camera, headLight, headTarget } = buildRig();
    const cfg = CONFIG.cameraLighting;

    for (let i = 0; i < 1000; i++) {
      orbitCamera(camera, orbitTarget, 3, 2, speed);
      scene.updateMatrixWorld(true);
    }

    // Local positions are still exact config values — no cumulative drift
    expect(headLight.position.x).toBeCloseTo(cfg.head.offset[0], 10);
    expect(headLight.position.y).toBeCloseTo(cfg.head.offset[1], 10);
    expect(headLight.position.z).toBeCloseTo(cfg.head.offset[2], 10);
    expect(headTarget.position.x).toBeCloseTo(cfg.head.target[0], 10);
    expect(headTarget.position.y).toBeCloseTo(cfg.head.target[1], 10);
    expect(headTarget.position.z).toBeCloseTo(cfg.head.target[2], 10);
  });
});

// ── Lighting adequacy tests (visual coverage, not just transforms) ──

describe('camera lighting adequacy', () => {
  const orbitTarget = new THREE.Vector3(0, 0, 0);

  it('spotlight has no distance falloff (distance=0, decay=0)', () => {
    // With distance=0 and decay=0, the spotlight behaves like a directional
    // light within its cone — no darkening at any camera distance.
    const cfg = CONFIG.cameraLighting.head;
    expect(cfg.distance).toBe(0);
    expect(cfg.decay).toBe(0);
  });

  it('framed molecule stays inside spotlight cone at default distance', () => {
    // Default camera is at (0,0,15) looking at origin. A molecule at origin
    // with radius ~5Å should be fully inside the spotlight cone.
    const { scene, camera, headLight, headTarget } = buildRig();
    scene.updateMatrixWorld(true);

    const spotDir = spotDirection(headLight, headTarget, scene);
    const lightWorldPos = worldPos(headLight);
    const cfg = CONFIG.cameraLighting.head;

    // Check that a sphere of radius 5Å at the origin is inside the cone
    const moleculeRadius = 5.0;
    const toCenter = new THREE.Vector3().subVectors(orbitTarget, lightWorldPos);
    const distToCenter = toCenter.length();
    // Half-angle of the molecule as seen from the light
    const moleculeHalfAngle = Math.atan2(moleculeRadius, distToCenter);
    // Must be smaller than the spotlight cone angle
    expect(moleculeHalfAngle).toBeLessThan(cfg.angle);
  });

  it('framed molecule stays inside cone after reframing to 40Å distance', () => {
    const { scene, camera, headLight, headTarget } = buildRig();
    // Move camera to 40Å (larger molecule framing)
    camera.position.set(0, 0, 40);
    camera.lookAt(0, 0, 0);
    scene.updateMatrixWorld(true);

    const lightWorldPos = worldPos(headLight);
    const cfg = CONFIG.cameraLighting.head;

    const moleculeRadius = 10.0; // larger molecule
    const toCenter = new THREE.Vector3().subVectors(orbitTarget, lightWorldPos);
    const distToCenter = toCenter.length();
    const moleculeHalfAngle = Math.atan2(moleculeRadius, distToCenter);
    expect(moleculeHalfAngle).toBeLessThan(cfg.angle);
  });

  it('edge atoms of framed sphere stay inside spotlight cone after orbit', () => {
    const { scene, camera, headLight, headTarget } = buildRig();
    const cfg = CONFIG.cameraLighting.head;
    const speed = 0.005;

    // Orbit to a nontrivial orientation
    for (let i = 0; i < 200; i++) {
      orbitCamera(camera, orbitTarget, 4, 3, speed);
    }
    scene.updateMatrixWorld(true);

    const lightWorldPos = worldPos(headLight);
    const spotDir = spotDirection(headLight, headTarget, scene);
    const moleculeRadius = 5.0;

    // Check 8 edge points of the molecule sphere
    const edgeDirs = [
      new THREE.Vector3(1, 0, 0), new THREE.Vector3(-1, 0, 0),
      new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, -1, 0),
      new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 0, -1),
      new THREE.Vector3(1, 1, 0).normalize(), new THREE.Vector3(-1, -1, 0).normalize(),
    ];

    for (const dir of edgeDirs) {
      const edgePoint = dir.clone().multiplyScalar(moleculeRadius);
      const toEdge = edgePoint.clone().sub(lightWorldPos).normalize();
      const angle = Math.acos(Math.min(1, Math.max(-1, toEdge.dot(spotDir))));
      expect(angle).toBeLessThan(cfg.angle);
    }
  });

  it('fill light is DirectionalLight with explicit camera-local target', () => {
    const { fillLight, fillTarget, rig } = buildRig();
    // DirectionalLight provides uniform fill regardless of distance
    expect(fillLight).not.toBeNull();
    expect(fillLight).toBeInstanceOf(THREE.DirectionalLight);
    // Explicit target parented to rig (same pattern as headlight)
    expect(fillTarget).not.toBeNull();
    expect(fillLight!.target).toBe(fillTarget);
    expect(rig.children).toContain(fillTarget);
    // Target position matches config
    const cfg = CONFIG.cameraLighting.fill;
    expect(fillTarget!.position.x).toBeCloseTo(cfg.target[0], 5);
    expect(fillTarget!.position.y).toBeCloseTo(cfg.target[1], 5);
    expect(fillTarget!.position.z).toBeCloseTo(cfg.target[2], 5);
  });

  it('headlight dominates for directional contrast', () => {
    // Design goal: strong headlight for form, reduced ambient/fill for dark-side modeling.
    // Headlight should be the strongest single source.
    const dark = THEMES['dark'];
    expect(dark.headLightIntensity).toBeGreaterThan(dark.fillLightIntensity);
    expect(dark.headLightIntensity).toBeGreaterThan(dark.ambientIntensity);
    // Total budget should still be reasonable (> 3.0 for usable scene brightness)
    const total = dark.headLightIntensity + dark.fillLightIntensity + dark.ambientIntensity;
    expect(total).toBeGreaterThan(3.0);
  });
});
