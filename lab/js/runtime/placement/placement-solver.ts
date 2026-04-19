/**
 * Placement solver — computes rigid transform (rotation + translation) for
 * molecule preview placement in the user's current camera frame.
 *
 * Owns: PCA local-frame analysis, camera-frame construction, shape-aware
 *       orientation candidates, no-initial-bond feasibility check,
 *       translation/depth optimization for collision readiness.
 * Depends on: THREE.js (Vector3, Matrix3, Quaternion), CONFIG (placement thresholds).
 * Called by: PlacementController (consumes PlacementResult).
 * Teardown: stateless pure functions — no teardown needed.
 *
 * Policy architecture (keep in sync when editing):
 *   chooseCameraFamily()            — base policy preference (vertical-first)
 *   selectOrientationByGeometry()   — final runtime arbiter (geometry-scored)
 *   tests: [policy conformance]     — conformance to chooseCameraFamily()
 *   tests: [external oracle]        — hand-written canonical backstop
 *   tests: [observable behavior]    — policy-independent user-facing sanity
 */

import * as THREE from 'three';
import { CONFIG } from '../../config';

// ── Types ──

export interface StructureAtom {
  x: number; y: number; z: number;
}

export type ShapeClass = 'elongated' | 'planar' | 'compact';

export interface MoleculeLocalFrame {
  centroid: THREE.Vector3;
  axes: [THREE.Vector3, THREE.Vector3, THREE.Vector3]; // major, mid, minor (PCA)
  eigenvalues: [number, number, number];
  shapeClass: ShapeClass;
}

/** Placement-specific frame mode — controls orientation policy.
 *  Uses a lower threshold than ShapeClass to catch real library CNTs. */
export type FrameMode = 'line_dominant' | 'plane_dominant' | 'volumetric';

/**
 * Robust molecule intrinsic frame (Msys).
 * m1 = PCA primary direction, m2 = geometry-derived stable secondary, m3 = derived.
 * Unlike raw PCA axes, m2 is anchored to actual geometry, making it stable
 * under near-degenerate transverse eigenvalues.
 */
export interface MoleculeFrame {
  centroid: THREE.Vector3;
  m1: THREE.Vector3; // primary geometric direction
  m2: THREE.Vector3; // stable secondary reference
  m3: THREE.Vector3; // derived: m1 × m2
  /** Placement-specific mode (lower threshold than ShapeClass). */
  frameMode: FrameMode;
  /** How strongly line-dominant (major/mid eigenvalue ratio). Higher = more elongated. */
  lineConfidence: number;
  /** How symmetric the transverse cross-section is (0 = perfectly symmetric, 1 = very asymmetric). */
  transverseAsymmetry: number;
}

export interface CameraFrame {
  position: THREE.Vector3;
  forward: THREE.Vector3;
  right: THREE.Vector3;
  up: THREE.Vector3;
}

export interface PlacementResult {
  rotation: THREE.Quaternion;
  offset: [number, number, number];
  centroid: THREE.Vector3;
  shapeClass: ShapeClass;
  /** Pre-transformed atoms in world space (authoritative for both preview and commit).
   *  Preserves all original atom properties (element, etc.) with updated positions. */
  transformedAtoms: Array<StructureAtom & Record<string, any>>;
  /** Whether the solver found a feasible non-overlapping placement.
   *  false means the placement is a fallback — the preview may still be usable
   *  but was not validated by checkNoInitialBond. */
  feasible: boolean;
}

export interface SceneAtom {
  x: number; y: number; z: number;
}

// ── Constants ──

/** Safety margin above bond cutoff for no-initial-bond invariant. */
const SAFETY_MARGIN = 0.5; // Å
/** Extra margin for "ready to collide" distance. */
const READY_MARGIN = 1.0; // Å
/** Anisotropy ratio threshold for elongated classification (ShapeClass). */
const ELONGATED_RATIO = 3.0;
/** Anisotropy ratio threshold for planar classification (ShapeClass). */
const PLANAR_RATIO = 2.5;
/** Lower threshold for placement line_dominant mode (catches real CNTs). */
const LINE_DOMINANT_RATIO = 1.8;
/** Lower threshold for placement plane_dominant mode. */
const PLANE_DOMINANT_RATIO = 1.8;
/** Epsilon for near-max-radius m2 averaging (permutation stability). */
const M2_RADIUS_EPSILON = 0.05; // fraction of max radius

// ── 0. Shared Perspective Projection ──

/** Renderer camera FOV in degrees (matches THREE.PerspectiveCamera(50, ...)). */
const CAMERA_FOV_DEG = 50;
const CAMERA_FOV_SCALE = 1 / Math.tan((CAMERA_FOV_DEG / 2) * Math.PI / 180);

/**
 * Project a world-space point through perspective camera.
 * Matches the renderer's projection: position + basis + FOV + depth divide.
 * Returns screen-proportional coordinates scaled by FOV.
 * Shared between solver refinement and test QA gate for consistency.
 */
export function projectToScreen(
  worldPos: THREE.Vector3, cam: CameraFrame,
): { x: number; y: number; depth: number } {
  const toPoint = worldPos.clone().sub(cam.position);
  const depth = toPoint.dot(cam.forward);
  if (depth < 0.01) return { x: 0, y: 0, depth: 0.01 };
  return {
    x: (toPoint.dot(cam.right) / depth) * CAMERA_FOV_SCALE,
    y: (toPoint.dot(cam.up) / depth) * CAMERA_FOV_SCALE,
    depth,
  };
}

// ── 1. Local Frame Analysis (PCA) ──

/**
 * Compute molecule local frame via PCA on atom positions.
 * Returns principal axes, eigenvalues, and shape classification.
 */
export function computeLocalFrame(atoms: StructureAtom[]): MoleculeLocalFrame {
  const n = atoms.length;
  if (n === 0) {
    return {
      centroid: new THREE.Vector3(),
      axes: [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1)],
      eigenvalues: [0, 0, 0],
      shapeClass: 'compact',
    };
  }

  // Compute centroid
  let cx = 0, cy = 0, cz = 0;
  for (const a of atoms) { cx += a.x; cy += a.y; cz += a.z; }
  cx /= n; cy /= n; cz /= n;
  const centroid = new THREE.Vector3(cx, cy, cz);

  // Compute 3x3 covariance matrix (symmetric)
  let cov00 = 0, cov01 = 0, cov02 = 0;
  let cov11 = 0, cov12 = 0, cov22 = 0;
  for (const a of atoms) {
    const dx = a.x - cx, dy = a.y - cy, dz = a.z - cz;
    cov00 += dx * dx; cov01 += dx * dy; cov02 += dx * dz;
    cov11 += dy * dy; cov12 += dy * dz; cov22 += dz * dz;
  }
  cov00 /= n; cov01 /= n; cov02 /= n;
  cov11 /= n; cov12 /= n; cov22 /= n;

  // Eigendecomposition via Jacobi iteration (3x3 symmetric)
  const { eigenvalues, eigenvectors } = jacobi3x3(
    cov00, cov01, cov02,
    cov11, cov12, cov22,
  );

  // Sort by eigenvalue descending (major axis first)
  const indices = [0, 1, 2].sort((a, b) => eigenvalues[b] - eigenvalues[a]);
  const sortedEvals: [number, number, number] = [eigenvalues[indices[0]], eigenvalues[indices[1]], eigenvalues[indices[2]]];
  let sortedAxes: [THREE.Vector3, THREE.Vector3, THREE.Vector3] = [
    new THREE.Vector3(...eigenvectors[indices[0]]),
    new THREE.Vector3(...eigenvectors[indices[1]]),
    new THREE.Vector3(...eigenvectors[indices[2]]),
  ];

  // Canonicalize PCA frame: fix major-axis sign using first→last atom direction
  // This prevents sign flips between equivalent PCA solutions
  if (n >= 2) {
    const first = atoms[0], last = atoms[n - 1];
    const span = new THREE.Vector3(last.x - first.x, last.y - first.y, last.z - first.z);
    if (span.dot(sortedAxes[0]) < 0) sortedAxes[0].negate();
    // Fix mid-axis sign to keep right-handed frame
    const cross = new THREE.Vector3().crossVectors(sortedAxes[0], sortedAxes[1]);
    if (cross.dot(sortedAxes[2]) < 0) sortedAxes[1].negate();
    // Recompute minor axis for guaranteed right-handedness
    sortedAxes[2] = new THREE.Vector3().crossVectors(sortedAxes[0], sortedAxes[1]).normalize();
  }

  // Shape classification from eigenvalue ratios
  const shapeClass = classifyShape(sortedEvals);

  return { centroid, axes: sortedAxes, eigenvalues: sortedEvals, shapeClass };
}

/**
 * Build a robust molecule intrinsic frame (Msys).
 *
 * m1 is always high-confidence (from PCA primary axis).
 * m2 is best-effort from transverse cross-section PCA — for symmetric
 * cross-sections (tubes, rings), m2 is low-confidence. The orientation
 * solver handles this: buildViewPolicyTarget derives twist from the
 * camera view, not from m2, so m2 quality does not affect final orientation.
 *
 * Uses PCA for m1 (primary direction), then cross-section PCA for
 * atoms to build a permutation-stable m2 (independent of atom ordering).
 */
export function buildMoleculeFrame(atoms: StructureAtom[]): MoleculeFrame {
  const local = computeLocalFrame(atoms);
  const { centroid } = local;
  const m1 = local.axes[0].clone().normalize();

  // Compute placement-specific frame mode (lower thresholds than ShapeClass)
  const frameMode = classifyFrameMode(local.eigenvalues);

  if (atoms.length < 2) {
    const m2 = new THREE.Vector3(0, 1, 0);
    return { centroid, m1, m2, m3: new THREE.Vector3(0, 0, 1), frameMode, lineConfidence: 0, transverseAsymmetry: 0 };
  }

  // Compute perpendicular vectors from m1 axis for all atoms
  const perpVecs: THREE.Vector3[] = [];
  const perpDists: number[] = [];
  let maxPerpSq = 0;
  for (let i = 0; i < atoms.length; i++) {
    const v = new THREE.Vector3(atoms[i].x - centroid.x, atoms[i].y - centroid.y, atoms[i].z - centroid.z);
    v.sub(m1.clone().multiplyScalar(v.dot(m1))); // remove m1 component
    const perpSq = v.lengthSq();
    perpVecs.push(v);
    perpDists.push(perpSq);
    if (perpSq > maxPerpSq) maxPerpSq = perpSq;
  }

  // Build m2 from geometry only: find the dominant direction in the
  // transverse cross-section via a mini-PCA of near-max-radius vectors.
  // This is permutation-stable and geometry-only (no world-axis bias).
  const threshold = maxPerpSq * (1 - M2_RADIUS_EPSILON);
  let covRR = 0, covRU = 0, covUU = 0;

  // Build a temporary transverse basis from m1 for 2D analysis
  const tmpPerp1 = Math.abs(m1.x) < 0.9
    ? new THREE.Vector3().crossVectors(new THREE.Vector3(1, 0, 0), m1).normalize()
    : new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), m1).normalize();
  const tmpPerp2 = new THREE.Vector3().crossVectors(m1, tmpPerp1).normalize();

  let ringCount = 0;
  for (let i = 0; i < atoms.length; i++) {
    if (perpDists[i] >= threshold) {
      const pr = perpVecs[i].dot(tmpPerp1);
      const pu = perpVecs[i].dot(tmpPerp2);
      covRR += pr * pr;
      covRU += pr * pu;
      covUU += pu * pu;
      ringCount++;
    }
  }

  let m2: THREE.Vector3;
  if (ringCount > 0) {
    // 2D PCA of the cross-section: dominant transverse eigenvector
    const trace = covRR + covUU;
    const det = covRR * covUU - covRU * covRU;
    const disc = Math.sqrt(Math.max(0, trace * trace / 4 - det));
    const lambda1 = trace / 2 + disc;
    // Eigenvector for lambda1
    let ex: number, ey: number;
    if (Math.abs(covRU) > 1e-10) {
      ex = lambda1 - covUU;
      ey = covRU;
    } else {
      ex = covRR >= covUU ? 1 : 0;
      ey = covRR >= covUU ? 0 : 1;
    }
    const len = Math.sqrt(ex * ex + ey * ey);
    if (len > 1e-8) {
      m2 = tmpPerp1.clone().multiplyScalar(ex / len).add(tmpPerp2.clone().multiplyScalar(ey / len));
    } else {
      m2 = tmpPerp1.clone();
    }
  } else {
    // Degenerate: all atoms on the m1 axis
    m2 = tmpPerp1.clone();
  }

  const m3 = new THREE.Vector3().crossVectors(m1, m2).normalize();
  m2 = new THREE.Vector3().crossVectors(m3, m1).normalize();

  // Frame confidence metrics
  const [ev0, ev1] = local.eigenvalues;
  const lineConfidence = ev1 > 0 ? ev0 / ev1 : Infinity;
  // Transverse asymmetry from cross-section PCA eigenvalue ratio
  const trace = covRR + covUU;
  const det = covRR * covUU - covRU * covRU;
  const disc2 = Math.sqrt(Math.max(0, trace * trace / 4 - det));
  const csLambda1 = trace / 2 + disc2;
  const csLambda2 = trace / 2 - disc2;
  const transverseAsymmetry = csLambda2 > 1e-6 ? 1 - csLambda2 / csLambda1 : 1;

  return { centroid, m1, m2, m3, frameMode, lineConfidence, transverseAsymmetry };
}

/** Classify placement frame mode from eigenvalues using scored regime selection.
 *  Computes both line and plane scores and picks the stronger regime.
 *  Planarity wins ties because thin sheets benefit more from the plane-facing solver. */
export function classifyFrameMode(eigenvalues: [number, number, number]): FrameMode {
  const [major, mid, minor] = eigenvalues;
  if (major <= 0) return 'volumetric';
  if (mid <= 0) return 'line_dominant';
  const majorMidRatio = major / mid;
  const midMinorRatio = minor > 1e-6 ? mid / minor : Infinity;
  // Score each regime by how far above its threshold the ratio is
  const lineScore = majorMidRatio / LINE_DOMINANT_RATIO;  // > 1 = line-dominant
  const planeScore = midMinorRatio / PLANE_DOMINANT_RATIO; // > 1 = plane-dominant
  // Choose the stronger regime; planarity wins ties
  if (planeScore >= 1 && planeScore >= lineScore) return 'plane_dominant';
  if (lineScore > 1) return 'line_dominant';
  if (planeScore >= 1) return 'plane_dominant';
  return 'volumetric';
}

/** Classify shape from sorted eigenvalues (descending). */
export function classifyShape(eigenvalues: [number, number, number]): ShapeClass {
  const [major, mid, minor] = eigenvalues;
  if (major <= 0) return 'compact';
  if (mid <= 0) return 'elongated';
  const majorMidRatio = major / mid;
  // Planar: major ≈ mid, both >> minor (thin in one direction)
  const midMinorRatio = minor > 1e-6 ? mid / minor : Infinity;
  if (majorMidRatio > ELONGATED_RATIO) return 'elongated';
  if (midMinorRatio > PLANAR_RATIO) return 'planar';
  return 'compact';
}

// ── 2. Camera Frame ──

/** Build orthonormal camera frame from renderer camera state.
 *  Handles near-pole views where forward ≈ ±up by using a fallback reference axis. */
export function buildCameraFrame(cameraState: { position: number[]; direction: number[]; up: number[] }): CameraFrame {
  const forward = new THREE.Vector3(...cameraState.direction).normalize();
  let refUp = new THREE.Vector3(...cameraState.up).normalize();

  // Near-pole guard: if forward is nearly parallel to up, use world-X as fallback
  if (Math.abs(forward.dot(refUp)) > 0.99) {
    refUp = new THREE.Vector3(1, 0, 0);
    // If forward is also near X, use Z
    if (Math.abs(forward.dot(refUp)) > 0.99) {
      refUp = new THREE.Vector3(0, 0, 1);
    }
  }

  const right = new THREE.Vector3().crossVectors(forward, refUp).normalize();
  const up = new THREE.Vector3().crossVectors(right, forward).normalize();
  return {
    position: new THREE.Vector3(...cameraState.position),
    forward,
    right,
    up,
  };
}

// ── 3. Orientation Selection: Msys → Tsys(Lsys) → R ──

/**
 * Select orientation for preview placement.
 *
 * Formulation: R = Tsys × Msys^T
 * - Msys: molecule intrinsic frame from buildMoleculeFrame
 * - Lsys: live camera frame from buildCameraFrame
 * - Tsys: explicit view-policy target frame
 *
 * View-policy targets by frame mode:
 * - line_dominant: place m1 in the screen plane along the most readable direction,
 *   m2 fills the remaining in-plane direction, m3 goes into depth.
 * - plane_dominant: place m3 (least-variance axis) into depth (face the camera),
 *   m1 and m2 fill the screen plane.
 * - volumetric: preserve library orientation (identity).
 *
 * Frame confidence (lineConfidence) controls how strongly the policy is applied.
 * Scene-independent: scene atoms never influence orientation.
 */
export function selectOrientation(
  localFrame: MoleculeLocalFrame,
  cameraFrame: CameraFrame,
  moleculeFrame?: MoleculeFrame,
): THREE.Quaternion {
  const msys = moleculeFrame ?? {
    m1: localFrame.axes[0], m2: localFrame.axes[1], m3: localFrame.axes[2],
    centroid: localFrame.centroid,
    frameMode: (localFrame.shapeClass === 'compact' ? 'volumetric' : localFrame.shapeClass === 'elongated' ? 'line_dominant' : 'plane_dominant') as FrameMode,
    lineConfidence: localFrame.eigenvalues[1] > 0 ? localFrame.eigenvalues[0] / localFrame.eigenvalues[1] : Infinity,
    transverseAsymmetry: 0,
  };

  if (msys.frameMode === 'volumetric') {
    return new THREE.Quaternion();
  }

  return buildViewPolicyTarget(msys, cameraFrame);
}

/**
 * Build view-policy orientation. Camera-first: always prefer vertical.
 *
 * - line_dominant: align m1 to camera.up. Fall back to camera.right only
 *   when vertical presentation would be unreadably foreshortened.
 * - plane_dominant: m3 faces camera, m1 aligns to camera.up in-plane (same rule).
 *
 * Scene-independent. View-local. Vertical-preferred.
 */
function buildViewPolicyTarget(msys: MoleculeFrame, lsys: CameraFrame): THREE.Quaternion {
  if (msys.frameMode === 'plane_dominant') {
    return solvePlaneDominant(msys, lsys);
  }
  return solveLineDominant(msys, lsys);
}

/**
 * Compute the camera-relative policy target direction for geometry refinement.
 * Returns a camera-axis-aligned direction (±up or ±right) that the visible
 * silhouette should align to. Used by refinement to correct toward the
 * declared view-local target, not toward the molecule's internal frame.
 */
function computePolicyTargetDirection(
  msys: MoleculeFrame, lsys: CameraFrame,
): THREE.Vector3 {
  const { right, up } = lsys;
  if (msys.frameMode === 'line_dominant') {
    return computeProjectionMaxTarget(msys.m1, msys.m2, right, up);
  }
  // plane_dominant: compute the in-plane target after facing rotation
  const m3norm = msys.m3.clone().normalize();
  const qNormal = new THREE.Quaternion().setFromUnitVectors(m3norm, lsys.forward.clone());
  const m1After = msys.m1.clone().applyQuaternion(qNormal).normalize();
  const m2After = msys.m2.clone().applyQuaternion(qNormal).normalize();
  return computePlaneInPlaneTarget(m1After, m2After, right, up);
}

/** Base max corrective twist from geometry refinement (radians).
 *  Adaptive: doubled for high-anisotropy shapes where correction is reliable. */
const BASE_GEOMETRY_CORRECTION = 0.12; // ~6.9°

/** Geometry family switch margin: right only wins over vertical when its
 *  projected readability score exceeds up's score by this fraction.
 *  Prevents instability from small score fluctuations (twist artifacts,
 *  cross-section variations). Set to 0 for pure score-based selection. */
const GEOMETRY_FAMILY_SWITCH_MARGIN = 0.2; // 20%

/** Hermite smoothstep: 0 below edge0, 1 above edge1, smooth between. */
function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/**
 * Line-dominant: align m1 to camera.up (preferred) or camera.right (fallback).
 *
 * Step 1: camera-first target — prefer vertical, sign from m1 projection.
 * Step 2: unified twist resolution (camera/shape blend by transverse asymmetry).
 * (Step 3 geometry refinement runs in solvePlacement after this returns.)
 */
function solveLineDominant(msys: MoleculeFrame, lsys: CameraFrame): THREE.Quaternion {
  const { right, up, forward } = lsys;

  // Step 1: frame-based target for m1
  const t1 = computeProjectionMaxTarget(msys.m1, msys.m2, right, up);
  const q1 = new THREE.Quaternion().setFromUnitVectors(msys.m1.clone().normalize(), t1);

  // Step 2: unified twist
  return resolveUnifiedTwist(q1, t1, msys, lsys);
}

/**
 * Unified twist resolution. Blends the twist *target* between camera-defined
 * and shape-defined, weighted by transverseAsymmetry.
 *
 * At asymmetry=0 (symmetric tube): twist target = camera perpendicular.
 * At asymmetry=1 (strongly asymmetric): twist target = projected m2After.
 * Smooth transition between, no hard threshold.
 */
function resolveUnifiedTwist(
  q1: THREE.Quaternion, t1: THREE.Vector3,
  msys: MoleculeFrame, lsys: CameraFrame,
): THREE.Quaternion {
  const { right, up, forward } = lsys;
  const preferredTwistDir = Math.abs(t1.dot(up)) > 0.8 ? right.clone() : up.clone();

  // Stable source perpendicular: cross(t1, forward), camera-defined
  const srcPerp = new THREE.Vector3().crossVectors(t1, forward);
  if (srcPerp.lengthSq() < 1e-6) srcPerp.crossVectors(t1, up);
  if (srcPerp.lengthSq() < 1e-6) return q1;
  srcPerp.normalize();

  // Camera-defined twist target: preferredTwistDir projected perpendicular to t1
  const cameraTarget = preferredTwistDir.clone()
    .sub(t1.clone().multiplyScalar(preferredTwistDir.dot(t1)));
  if (cameraTarget.lengthSq() < 1e-6) return q1;
  cameraTarget.normalize();

  // Shape-defined twist target: m2After projected perpendicular to t1
  const m2After = msys.m2.clone().applyQuaternion(q1).normalize();
  const shapeTarget = m2After.clone()
    .sub(t1.clone().multiplyScalar(m2After.dot(t1)));

  // Nonlinear confidence curve: damp small asymmetry aggressively.
  // smoothstep(0.2, 0.7) keeps low-confidence cases camera-defined while
  // allowing strong shape-based roll for genuinely asymmetric cross-sections.
  const rawW = Math.min(1, msys.transverseAsymmetry);
  const w = smoothstep(0.2, 0.7, rawW);
  let blendedTarget: THREE.Vector3;
  if (shapeTarget.lengthSq() > 1e-6) {
    shapeTarget.normalize();
    blendedTarget = cameraTarget.clone().multiplyScalar(1 - w)
      .add(shapeTarget.multiplyScalar(w));
    if (blendedTarget.lengthSq() < 1e-8) blendedTarget = cameraTarget.clone();
    else blendedTarget.normalize();
  } else {
    blendedTarget = cameraTarget;
  }

  return applyTwistToward(q1, t1, srcPerp, blendedTarget);
}

/** Apply twist around axis to move `from` toward `toward` in the perpendicular plane. */
function applyTwistToward(
  baseQ: THREE.Quaternion, axis: THREE.Vector3,
  from: THREE.Vector3, toward: THREE.Vector3,
): THREE.Quaternion {
  const fromProj = from.clone().sub(axis.clone().multiplyScalar(from.dot(axis)));
  const toProj = toward.clone().sub(axis.clone().multiplyScalar(toward.dot(axis)));
  if (fromProj.lengthSq() < 1e-6 || toProj.lengthSq() < 1e-6) return baseQ;
  fromProj.normalize();
  toProj.normalize();
  const cosAngle = Math.max(-1, Math.min(1, fromProj.dot(toProj)));
  const cross = new THREE.Vector3().crossVectors(fromProj, toProj);
  const sign = cross.dot(axis) >= 0 ? 1 : -1;
  const angle = sign * Math.acos(cosAngle);
  const qTwist = new THREE.Quaternion().setFromAxisAngle(axis, angle);
  return qTwist.multiply(baseQ);
}

/**
 * Plane-dominant: m3 faces camera, in-plane twist maximizes m1 readability.
 *
 * Step 1: rotate m3 → camera.forward (facing the camera).
 * Step 2: twist to maximize m1 visibility in screen plane. No styling bias.
 */
function solvePlaneDominant(msys: MoleculeFrame, lsys: CameraFrame): THREE.Quaternion {
  const { right, up, forward } = lsys;

  // Step 1: rotate m3 → camera.forward (plane surface faces viewer).
  const m3norm = msys.m3.clone().normalize();
  const targetNormal = forward.clone();
  const qNormal = new THREE.Quaternion().setFromUnitVectors(m3norm, targetNormal);

  // Step 2: in-plane twist to maximize m1 visibility, with fallback chain
  const m1After = msys.m1.clone().applyQuaternion(qNormal).normalize();
  const m2After = msys.m2.clone().applyQuaternion(qNormal).normalize();

  // Determine in-plane twist target via fallback chain
  const targetInPlane = computePlaneInPlaneTarget(m1After, m2After, right, up);

  // Project both into perpendicular-to-normal plane and twist
  // Use m1After as the source direction to twist from
  const m1Proj = m1After.clone().sub(targetNormal.clone().multiplyScalar(m1After.dot(targetNormal)));
  const tProj = targetInPlane.clone().sub(targetNormal.clone().multiplyScalar(targetInPlane.dot(targetNormal)));

  if (m1Proj.lengthSq() > 1e-6 && tProj.lengthSq() > 1e-6) {
    m1Proj.normalize();
    tProj.normalize();
    const cosA = Math.max(-1, Math.min(1, m1Proj.dot(tProj)));
    const cross = new THREE.Vector3().crossVectors(m1Proj, tProj);
    const sign = cross.dot(targetNormal) >= 0 ? 1 : -1;
    const angle = sign * Math.acos(cosA);
    const qTwist = new THREE.Quaternion().setFromAxisAngle(targetNormal, angle);
    return qTwist.multiply(qNormal);
  }

  return qNormal;
}

/** Compute in-plane twist target for plane-dominant shapes.
 *  Delegates entirely to the central product rule including fallback. */
function computePlaneInPlaneTarget(
  m1After: THREE.Vector3, m2After: THREE.Vector3,
  right: THREE.Vector3, up: THREE.Vector3,
): THREE.Vector3 {
  const m1R = m1After.dot(right);
  const m1U = m1After.dot(up);
  const m1ProjSq = m1R * m1R + m1U * m1U;
  return chooseCameraFamily(m1R, m1U, m1ProjSq, right, up, m2After).target;
}

/** Foreshortening threshold: below this m1ProjSq, the projection is too weak
 *  to determine a readable direction → fall back to m2 or camera axis. */
const PROJ_WEAK = 0.05;

/** Compute m2-derived fallback direction: perpendicular to m2's screen projection.
 *  Returns camera.up if m2 is also foreshortened. */
function computeM2Fallback(
  m2: THREE.Vector3,
  right: THREE.Vector3, up: THREE.Vector3,
): THREE.Vector3 {
  const m2R = m2.dot(right);
  const m2U = m2.dot(up);
  const m2ProjSq = m2R * m2R + m2U * m2U;

  if (m2ProjSq > PROJ_WEAK) {
    const len = Math.sqrt(m2ProjSq);
    const perpR = -m2U / len;
    const perpU = m2R / len;
    const fallback = right.clone().multiplyScalar(perpR).add(up.clone().multiplyScalar(perpU));
    if (perpU < 0) fallback.negate();
    return fallback.normalize();
  }

  return up.clone();
}

/** Threshold for readable vertical alignment: if |m1·up|/|m1_proj| < this,
 *  vertical presentation would be unreadable → use right instead. */
const VERT_READABLE_THRESHOLD = 0.25; // ~14° from horizontal

/** Full family decision result including fallback reason. */
type FamilyDecision = {
  family: 'up' | 'right';
  target: THREE.Vector3;
  reason: 'vertical' | 'horizontal' | 'm2_fallback' | 'default_vertical';
};

/**
 * Base policy preference for axis-family selection.
 *
 * Rule: "prefer vertical (camera.up) unless the molecule would be unreadably
 * foreshortened vertically, then use horizontal (camera.right). When the
 * primary axis is fully foreshortened, fall back through the secondary axis
 * (m2 perpendicular), then default to vertical."
 *
 * This is the base preference, not the final decision.
 * selectOrientationByGeometry() is the final arbiter in the runtime path
 * and may override this when projected atom geometry shows a different
 * family is more readable.
 */
export function chooseCameraFamily(
  axisR: number, axisU: number, axisProjSq: number,
  right: THREE.Vector3, up: THREE.Vector3,
  m2?: THREE.Vector3,
): FamilyDecision {
  if (axisProjSq <= PROJ_WEAK) {
    // Primary axis foreshortened — try m2 fallback
    if (m2) {
      const fb = computeM2Fallback(m2, right, up);
      // Determine which family the m2 fallback aligns to
      const fbR = Math.abs(fb.dot(right));
      const fbU = Math.abs(fb.dot(up));
      return {
        family: fbU >= fbR ? 'up' : 'right',
        target: fb,
        reason: 'm2_fallback',
      };
    }
    return { family: 'up', target: up.clone(), reason: 'default_vertical' };
  }

  const axisProjLen = Math.sqrt(axisProjSq);
  const verticalFraction = Math.abs(axisU) / axisProjLen;

  if (verticalFraction >= VERT_READABLE_THRESHOLD) {
    return {
      family: 'up',
      target: axisU >= 0 ? up.clone() : up.clone().negate(),
      reason: 'vertical',
    };
  }

  return {
    family: 'right',
    target: axisR >= 0 ? right.clone() : right.clone().negate(),
    reason: 'horizontal',
  };
}

/** Compute target for line-dominant m1 using the central product rule. */
function computeProjectionMaxTarget(
  m1: THREE.Vector3, m2: THREE.Vector3,
  right: THREE.Vector3, up: THREE.Vector3,
): THREE.Vector3 {
  const m1R = m1.dot(right);
  const m1U = m1.dot(up);
  const m1ProjSq = m1R * m1R + m1U * m1U;
  return chooseCameraFamily(m1R, m1U, m1ProjSq, right, up, m2).target;
}

/**
 * Compute full frame-to-frame rotation: R = target * local^T.
 * Constrains all three axes (no free twist).
 */
function computeFrameRotation(
  localAxes: [THREE.Vector3, THREE.Vector3, THREE.Vector3],
  targetAxes: [THREE.Vector3, THREE.Vector3, THREE.Vector3],
): THREE.Quaternion {
  const L = new THREE.Matrix4().makeBasis(
    localAxes[0].clone().normalize(),
    localAxes[1].clone().normalize(),
    localAxes[2].clone().normalize(),
  );
  const T = new THREE.Matrix4().makeBasis(
    targetAxes[0].clone().normalize(),
    targetAxes[1].clone().normalize(),
    targetAxes[2].clone().normalize(),
  );
  const R = T.multiply(L.clone().transpose());
  return new THREE.Quaternion().setFromRotationMatrix(R);
}

// ── 4. Feasibility: No-Initial-Bond ──

/** Check if placing preview atoms at given positions would create bonds with scene atoms. */
export function checkNoInitialBond(
  previewPositions: Float64Array | number[],
  previewN: number,
  sceneAtoms: SceneAtom[],
  sceneN: number,
): boolean {
  const minDist = CONFIG.bonds.cutoff + SAFETY_MARGIN;
  const minDistSq = minDist * minDist;
  for (let i = 0; i < previewN; i++) {
    const px = previewPositions[i * 3];
    const py = previewPositions[i * 3 + 1];
    const pz = previewPositions[i * 3 + 2];
    for (let j = 0; j < sceneN; j++) {
      const dx = px - sceneAtoms[j].x;
      const dy = py - sceneAtoms[j].y;
      const dz = pz - sceneAtoms[j].z;
      if (dx * dx + dy * dy + dz * dz < minDistSq) return false;
    }
  }
  return true;
}

/** Compute minimum cross-scene distance from preview to existing atoms. */
export function minCrossDistance(
  previewPositions: Float64Array | number[],
  previewN: number,
  sceneAtoms: SceneAtom[],
  sceneN: number,
): number {
  let minSq = Infinity;
  for (let i = 0; i < previewN; i++) {
    const px = previewPositions[i * 3];
    const py = previewPositions[i * 3 + 1];
    const pz = previewPositions[i * 3 + 2];
    for (let j = 0; j < sceneN; j++) {
      const dx = px - sceneAtoms[j].x;
      const dy = py - sceneAtoms[j].y;
      const dz = pz - sceneAtoms[j].z;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 < minSq) minSq = d2;
    }
  }
  return Math.sqrt(minSq);
}

// ── 5. Transform Helpers ──

/** Apply rigid transform (rotate then translate) to atom positions. */
export function applyRigidTransform(
  atoms: StructureAtom[],
  centroid: THREE.Vector3,
  rotation: THREE.Quaternion,
  offset: THREE.Vector3,
): Float64Array {
  const n = atoms.length;
  const out = new Float64Array(n * 3);
  const v = new THREE.Vector3();
  for (let i = 0; i < n; i++) {
    v.set(atoms[i].x - centroid.x, atoms[i].y - centroid.y, atoms[i].z - centroid.z);
    v.applyQuaternion(rotation);
    v.add(offset);
    out[i * 3] = v.x;
    out[i * 3 + 1] = v.y;
    out[i * 3 + 2] = v.z;
  }
  return out;
}

// ── 5b. Geometry-Based Orientation Refinement ──

/**
 * Compute the principal 2D axis of a set of screen-space points via 2D PCA.
 * Returns the dominant eigenvector direction (radians) and the eigenvalue ratio.
 */
export function projected2DPCA(
  points: { x: number; y: number }[],
): { angle: number; ratio: number } {
  const n = points.length;
  if (n < 2) return { angle: 0, ratio: 1 };

  let cx = 0, cy = 0;
  for (const p of points) { cx += p.x; cy += p.y; }
  cx /= n; cy /= n;

  let cov00 = 0, cov01 = 0, cov11 = 0;
  for (const p of points) {
    const dx = p.x - cx, dy = p.y - cy;
    cov00 += dx * dx;
    cov01 += dx * dy;
    cov11 += dy * dy;
  }
  cov00 /= n; cov01 /= n; cov11 /= n;

  const trace = cov00 + cov11;
  const det = cov00 * cov11 - cov01 * cov01;
  const disc = Math.sqrt(Math.max(0, trace * trace / 4 - det));
  const lambda1 = trace / 2 + disc;
  const lambda2 = trace / 2 - disc;

  // Eigenvector for lambda1
  let ex: number, ey: number;
  if (Math.abs(cov01) > 1e-10) {
    ex = lambda1 - cov11;
    ey = cov01;
  } else {
    ex = cov00 >= cov11 ? 1 : 0;
    ey = cov00 >= cov11 ? 0 : 1;
  }
  const angle = Math.atan2(ey, ex);
  const ratio = lambda2 > 1e-6 ? lambda1 / lambda2 : Infinity;
  return { angle, ratio };
}

/**
 * Refine orientation using perspective-projected atom geometry.
 *
 * Projects actual atoms through the camera (with depth divide), computes the
 * visible principal axis via 2D PCA, compares with the frame-derived intended
 * direction, and applies a corrective twist around camera.forward.
 *
 * Works for both line_dominant and plane_dominant shapes. For planes, the
 * correction aligns the visible in-plane principal axis.
 *
 * Adaptive correction: high-anisotropy shapes allow larger correction
 * (up to 2× BASE_GEOMETRY_CORRECTION). A second refinement pass runs if
 * the first pass leaves significant residual error.
 */
function refineOrientationFromGeometry(
  atoms: StructureAtom[],
  centroid: THREE.Vector3,
  rotation: THREE.Quaternion,
  cam: CameraFrame,
  _frameMode: FrameMode,
  _msys: MoleculeFrame,
  policyTarget: THREE.Vector3,
): THREE.Quaternion {
  let current = rotation.clone();

  // Run up to 2 passes for convergence
  for (let pass = 0; pass < 2; pass++) {
    const { visibleAngle, intendedAngle, ratio } = computeGeometryError(
      atoms, centroid, current, cam, policyTarget,
    );

    if (ratio < 1.5) break; // nearly circular, no dominant axis

    let correction = visibleAngle - intendedAngle;
    while (correction > Math.PI) correction -= 2 * Math.PI;
    while (correction < -Math.PI) correction += 2 * Math.PI;
    if (Math.abs(correction) > Math.PI / 2) {
      correction = correction > 0 ? correction - Math.PI : correction + Math.PI;
    }

    // Adaptive clamp: high anisotropy → larger allowed correction
    const maxCorrection = ratio > 3 ? BASE_GEOMETRY_CORRECTION * 2 : BASE_GEOMETRY_CORRECTION;
    correction = Math.max(-maxCorrection, Math.min(maxCorrection, correction));

    if (Math.abs(correction) < 0.003) break; // < 0.17°, converged

    const qCorrection = new THREE.Quaternion().setFromAxisAngle(cam.forward, -correction);
    current = qCorrection.multiply(current);
  }

  return current;
}

/** Compute the angular error between visible geometry axis and the declared
 *  policy target direction. Uses perspective projection for both the atom
 *  cloud and the target, so refinement optimizes exactly what the user sees
 *  toward the declared UX objective (not toward the current rotated m1). */
function computeGeometryError(
  atoms: StructureAtom[],
  centroid: THREE.Vector3,
  rotation: THREE.Quaternion,
  cam: CameraFrame,
  policyTarget: THREE.Vector3,
): { visibleAngle: number; intendedAngle: number; ratio: number } {
  let maxR = 0;
  for (const a of atoms) {
    const dx = a.x - centroid.x, dy = a.y - centroid.y, dz = a.z - centroid.z;
    maxR = Math.max(maxR, Math.sqrt(dx * dx + dy * dy + dz * dz));
  }
  const viewDist = Math.max(maxR * 3, 10);
  const molCenter = cam.position.clone().add(cam.forward.clone().multiplyScalar(viewDist));

  // Perspective-project each oriented atom
  const v = new THREE.Vector3();
  const screenPts: { x: number; y: number }[] = [];
  for (const a of atoms) {
    v.set(a.x - centroid.x, a.y - centroid.y, a.z - centroid.z);
    v.applyQuaternion(rotation);
    v.add(molCenter);
    const p = projectToScreen(v, cam);
    screenPts.push({ x: p.x, y: p.y });
  }

  const { angle: visibleAngle, ratio } = projected2DPCA(screenPts);

  // Intended direction: project the explicit policy target through the
  // same perspective model (not rotated m1 — the policy target is what
  // the UX objective declares, independent of the current rotation).
  const pCenter = projectToScreen(molCenter, cam);
  const pTip = projectToScreen(
    molCenter.clone().add(policyTarget.clone().multiplyScalar(maxR)), cam,
  );
  const intendedAngle = Math.atan2(pTip.y - pCenter.y, pTip.x - pCenter.x);

  return { visibleAngle, intendedAngle, ratio };
}

// ── 5c. Geometry-Aware Family Selection ──

/**
 * Build a signed camera-axis target for a given family, using m1's projection
 * only for sign resolution. Centralized so the geometry selector and the
 * policy helper construct candidates identically.
 */
function buildFamilyTarget(
  family: 'up' | 'right',
  msys: MoleculeFrame,
  cam: CameraFrame,
): THREE.Vector3 {
  const m1R = msys.m1.dot(cam.right);
  const m1U = msys.m1.dot(cam.up);
  if (family === 'up') {
    return m1U >= 0 ? cam.up.clone() : cam.up.clone().negate();
  }
  return m1R >= 0 ? cam.right.clone() : cam.right.clone().negate();
}

/**
 * Build a candidate rotation for a given family target.
 */
function buildFamilyRotation(
  target: THREE.Vector3,
  msys: MoleculeFrame,
  cam: CameraFrame,
): THREE.Quaternion {
  if (msys.frameMode === 'plane_dominant') {
    const m3norm = msys.m3.clone().normalize();
    const qNormal = new THREE.Quaternion().setFromUnitVectors(m3norm, cam.forward.clone());
    const m1After = msys.m1.clone().applyQuaternion(qNormal).normalize();
    const m1Proj = m1After.clone().sub(cam.forward.clone().multiplyScalar(m1After.dot(cam.forward)));
    const tProj = target.clone().sub(cam.forward.clone().multiplyScalar(target.dot(cam.forward)));
    if (m1Proj.lengthSq() > 1e-6 && tProj.lengthSq() > 1e-6) {
      m1Proj.normalize();
      tProj.normalize();
      const cosA = Math.max(-1, Math.min(1, m1Proj.dot(tProj)));
      const cross = new THREE.Vector3().crossVectors(m1Proj, tProj);
      const sign = cross.dot(cam.forward) >= 0 ? 1 : -1;
      const angle = sign * Math.acos(cosA);
      const qTwist = new THREE.Quaternion().setFromAxisAngle(cam.forward, angle);
      return qTwist.multiply(qNormal);
    }
    return qNormal;
  }
  const q1 = new THREE.Quaternion().setFromUnitVectors(msys.m1.clone().normalize(), target);
  return resolveUnifiedTwist(q1, target, msys, cam);
}

/**
 * Geometry-aware family selection — the final family arbiter in the runtime.
 *
 * chooseCameraFamily() provides the base policy preference (vertical-first).
 * This function may override that preference when actual projected atom
 * geometry shows that the other family is meaningfully more readable.
 *
 * Decision rule:
 *   1. Build both candidate orientations (up and right) using buildFamilyTarget().
 *   2. Score each by projected readability (extent along target axis).
 *   3. Vertical wins unless right scores > GEOMETRY_FAMILY_SWITCH_MARGIN higher.
 *
 * This means the final family can differ from chooseCameraFamily() when both
 * are equally readable (vertical wins ties) or when geometry strongly favors
 * one family over the other.
 */
function selectOrientationByGeometry(
  atoms: StructureAtom[],
  localFrame: MoleculeLocalFrame,
  cam: CameraFrame,
  msys: MoleculeFrame,
): THREE.Quaternion {
  const families: Array<'up' | 'right'> = ['up', 'right'];
  const candidates = families.map(family => {
    const target = buildFamilyTarget(family, msys, cam);
    const rotation = buildFamilyRotation(target, msys, cam);
    const score = scoreProjectedReadability(atoms, localFrame.centroid, rotation, cam, target);
    return { target, rotation, score, family };
  });

  const upC = candidates[0]; // 'up' is first
  const rightC = candidates[1];

  // Vertical wins unless right scores meaningfully higher.
  const marginThreshold = upC.score * GEOMETRY_FAMILY_SWITCH_MARGIN;
  const best = rightC.score > upC.score + marginThreshold ? rightC : upC;

  return refineOrientationFromGeometry(
    atoms, localFrame.centroid, best.rotation, cam,
    msys.frameMode, msys, best.target,
  );
}

/**
 * Score a candidate orientation by projecting atoms and measuring visible
 * extent along the intended target direction in screen space.
 *
 * Current metric: pure target-axis extent (higher = more readable).
 * This is intentionally narrow — the family selector only needs to compare
 * "how long does the molecule look along this axis?"
 *
 * Known limitation: since both rotations align m1 with their respective
 * targets, single-axis-dominant shapes always score equally for both families.
 * The vertical tie-breaker then always wins for these shapes. To distinguish
 * horizontal-family wins for rod-like molecules, extend this to include
 * perpendicular extent, silhouette breadth, or anisotropy quality.
 */
function scoreProjectedReadability(
  atoms: StructureAtom[],
  centroid: THREE.Vector3,
  rotation: THREE.Quaternion,
  cam: CameraFrame,
  target: THREE.Vector3,
): number {
  let maxR = 0;
  for (const a of atoms) {
    const dx = a.x - centroid.x, dy = a.y - centroid.y, dz = a.z - centroid.z;
    maxR = Math.max(maxR, Math.sqrt(dx * dx + dy * dy + dz * dz));
  }
  const viewDist = Math.max(maxR * 3, 10);
  const molCenter = cam.position.clone().add(cam.forward.clone().multiplyScalar(viewDist));

  const v = new THREE.Vector3();
  const pts: { x: number; y: number }[] = [];
  for (const a of atoms) {
    v.set(a.x - centroid.x, a.y - centroid.y, a.z - centroid.z);
    v.applyQuaternion(rotation);
    v.add(molCenter);
    const p = projectToScreen(v, cam);
    pts.push({ x: p.x, y: p.y });
  }

  const targetR = target.dot(cam.right);
  const targetU = target.dot(cam.up);
  const targetAngle = Math.atan2(targetU, targetR);
  const cosT = Math.cos(targetAngle);
  const sinT = Math.sin(targetAngle);

  let minProj = Infinity, maxProj = -Infinity;
  for (const p of pts) {
    const proj = p.x * cosT + p.y * sinT;
    if (proj < minProj) minProj = proj;
    if (proj > maxProj) maxProj = proj;
  }
  return maxProj - minProj;
}

// ── 6. Full Solver ──

/**
 * Solve for optimal rigid transform (rotation + translation) for preview placement.
 *
 * Translation policy:
 *   1. Orient preview via geometry-aware family selection
 *   2. Compute conservative gap (≥ bond cutoff + safety + ready margins)
 *   3. Search 8 lateral directions at progressively wider radii:
 *      [tangentDist, +1×safeStartDist, +2×safeStartDist, +4×safeStartDist]
 *   4. Stop at the first radius band with at least one feasible candidate
 *      (nearest-valid-placement policy)
 *   5. If all bands fail: fall back to camera.right at maximum radius,
 *      set feasible=false so the controller can show a warning
 *
 * @param previewAtoms Library-coordinate atoms to place
 * @param sceneAtoms Current scene atoms (for no-bond + proximity scoring)
 * @param sceneN Number of scene atoms
 * @param cameraState From renderer.getCameraState()
 * @param targetCOM Optional target molecule center to place near
 * @param targetRadius Optional target molecule radius
 */
export function solvePlacement(
  previewAtoms: StructureAtom[],
  sceneAtoms: SceneAtom[],
  sceneN: number,
  cameraState: { position: number[]; direction: number[]; up: number[] },
  targetCOM?: THREE.Vector3,
  targetRadius?: number,
): PlacementResult {
  const localFrame = computeLocalFrame(previewAtoms);
  const cameraFrame = buildCameraFrame(cameraState);
  const moleculeFrame = buildMoleculeFrame(previewAtoms);

  // ── Step 1: Choose orientation via geometry-aware family selection ──
  // For non-volumetric shapes with enough atoms, evaluate both candidate
  // families (up and right) using actual projected atom geometry, then
  // pick the one that best satisfies the view contract.
  let bestRotation: THREE.Quaternion;
  if (moleculeFrame.frameMode !== 'volumetric' && previewAtoms.length >= 3) {
    bestRotation = selectOrientationByGeometry(
      previewAtoms, localFrame, cameraFrame, moleculeFrame,
    );
  } else {
    bestRotation = selectOrientation(localFrame, cameraFrame, moleculeFrame);
  }

  // ── Step 2: Optimize translation with orientation fixed ──
  let previewRadius = 0;
  for (const a of previewAtoms) {
    const dx = a.x - localFrame.centroid.x;
    const dy = a.y - localFrame.centroid.y;
    const dz = a.z - localFrame.centroid.z;
    previewRadius = Math.max(previewRadius, Math.sqrt(dx * dx + dy * dy + dz * dz));
  }

  const safeStartDist = CONFIG.bonds.cutoff + SAFETY_MARGIN;
  const desiredReadyDist = safeStartDist + READY_MARGIN;

  const anchor = targetCOM ?? cameraFrame.position.clone().add(
    cameraFrame.forward.clone().multiplyScalar(previewRadius * 2.5 + 5)
  );

  // Conservative gap: must exceed the no-initial-bond threshold to guarantee
  // at least one feasible direction on the first ring.
  const safeGap = CONFIG.bonds.cutoff + SAFETY_MARGIN + READY_MARGIN;
  const gap = Math.max(safeGap, 0.3 * Math.min(targetRadius ?? previewRadius, previewRadius));
  const tangentDist = (targetRadius ?? 0) + previewRadius + gap;

  const searchDirs = [
    cameraFrame.right.clone(),
    cameraFrame.right.clone().negate(),
    cameraFrame.up.clone(),
    cameraFrame.up.clone().negate(),
    cameraFrame.right.clone().add(cameraFrame.up).normalize(),
    cameraFrame.right.clone().negate().add(cameraFrame.up).normalize(),
    cameraFrame.right.clone().add(cameraFrame.up.clone().negate()).normalize(),
    cameraFrame.right.clone().negate().add(cameraFrame.up.clone().negate()).normalize(),
  ];

  // Staged radius expansion: try progressively farther rings if closer ones fail.
  const candidateRadii = [
    tangentDist,
    tangentDist + safeStartDist,
    tangentDist + 2 * safeStartDist,
    tangentDist + 4 * safeStartDist,
  ];

  let bestPlacementScore = Infinity;
  let bestOffset: THREE.Vector3 | null = null;
  let feasible = false;

  for (const radius of candidateRadii) {
    for (const dir of searchDirs) {
      const offset = anchor.clone().add(dir.clone().multiplyScalar(radius));
      const transformed = applyRigidTransform(previewAtoms, localFrame.centroid, bestRotation, offset);

      // Hard constraint: no initial bond
      if (sceneN > 0 && !checkNoInitialBond(transformed, previewAtoms.length, sceneAtoms, sceneN)) {
        continue;
      }

      // Score: placement quality only (orientation already decided)
      let score = 0;
      if (sceneN > 0) {
        const minDist = minCrossDistance(transformed, previewAtoms.length, sceneAtoms, sceneN);
        score += Math.abs(minDist - desiredReadyDist) * 2.0;
      }

      const projX = offset.clone().sub(cameraFrame.position).dot(cameraFrame.right);
      const projY = offset.clone().sub(cameraFrame.position).dot(cameraFrame.up);
      const projDist = offset.clone().sub(cameraFrame.position).dot(cameraFrame.forward);
      if (projDist > 0) {
        const ndcX = projX / (projDist * 0.5);
        const ndcY = projY / (projDist * 0.5);
        if (Math.abs(ndcX) > 0.8 || Math.abs(ndcY) > 0.8) score += 10.0;
      }

      if (Math.abs(dir.dot(cameraFrame.right)) > 0.9) score -= 0.1;

      if (score < bestPlacementScore) {
        bestPlacementScore = score;
        bestOffset = offset.clone();
      }
    }
    // Policy: stop on the first radius band with at least one feasible candidate.
    // This prefers "nearest valid placement" over "globally best across all bands."
    // If globally optimal placement is needed later, score across all bands and
    // add a distance penalty so farther bands only win when materially better.
    if (bestOffset !== null) {
      feasible = true;
      break;
    }
  }

  // Last-resort fallback: if all radii failed, place along camera.right at maximum distance
  if (bestOffset === null) {
    const fallbackRadius = tangentDist + 4 * safeStartDist;
    bestOffset = anchor.clone().add(cameraFrame.right.clone().multiplyScalar(fallbackRadius));
    feasible = false;
  }

  // Compute authoritative transformed atoms (used by both preview and commit)
  const transformedPositions = applyRigidTransform(previewAtoms, localFrame.centroid, bestRotation, bestOffset);
  const transformedAtoms = previewAtoms.map((a, i) => ({
    ...a,
    x: transformedPositions[i * 3],
    y: transformedPositions[i * 3 + 1],
    z: transformedPositions[i * 3 + 2],
  }));

  return {
    rotation: bestRotation,
    offset: [bestOffset.x, bestOffset.y, bestOffset.z],
    centroid: localFrame.centroid,
    shapeClass: localFrame.shapeClass,
    transformedAtoms,
    feasible,
  };
}

// ── Jacobi 3x3 Eigendecomposition ──

/** Jacobi iteration for 3x3 symmetric matrix eigendecomposition. */
function jacobi3x3(
  a00: number, a01: number, a02: number,
  a11: number, a12: number, a22: number,
): { eigenvalues: number[]; eigenvectors: [number, number, number][] } {
  // Work on full 3x3 matrix
  const A = [
    [a00, a01, a02],
    [a01, a11, a12],
    [a02, a12, a22],
  ];
  // Eigenvector matrix (starts as identity)
  const V = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];

  for (let iter = 0; iter < 50; iter++) {
    // Find largest off-diagonal element
    let maxVal = 0, p = 0, q = 1;
    for (let i = 0; i < 3; i++) {
      for (let j = i + 1; j < 3; j++) {
        if (Math.abs(A[i][j]) > maxVal) {
          maxVal = Math.abs(A[i][j]);
          p = i; q = j;
        }
      }
    }
    if (maxVal < 1e-12) break;

    // Compute rotation angle
    const theta = 0.5 * Math.atan2(2 * A[p][q], A[q][q] - A[p][p]);
    const c = Math.cos(theta), s = Math.sin(theta);

    // Apply Givens rotation to A
    const App = A[p][p], Aqq = A[q][q], Apq = A[p][q];
    A[p][p] = c * c * App - 2 * s * c * Apq + s * s * Aqq;
    A[q][q] = s * s * App + 2 * s * c * Apq + c * c * Aqq;
    A[p][q] = A[q][p] = 0;

    for (let r = 0; r < 3; r++) {
      if (r === p || r === q) continue;
      const Arp = A[r][p], Arq = A[r][q];
      A[r][p] = A[p][r] = c * Arp - s * Arq;
      A[r][q] = A[q][r] = s * Arp + c * Arq;
    }

    // Update eigenvectors
    for (let r = 0; r < 3; r++) {
      const Vrp = V[r][p], Vrq = V[r][q];
      V[r][p] = c * Vrp - s * Vrq;
      V[r][q] = s * Vrp + c * Vrq;
    }
  }

  return {
    eigenvalues: [A[0][0], A[1][1], A[2][2]],
    eigenvectors: [
      [V[0][0], V[1][0], V[2][0]] as [number, number, number],
      [V[0][1], V[1][1], V[2][1]] as [number, number, number],
      [V[0][2], V[1][2], V[2][2]] as [number, number, number],
    ],
  };
}
