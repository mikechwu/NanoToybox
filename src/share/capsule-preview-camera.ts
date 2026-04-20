/**
 * Canonical preview camera derivation (spec §Orientation policy).
 *
 * Takes a centered 3D point cloud and returns a 3×3 rotation matrix that
 * maps world space into the canonical preview view. The derivation:
 *
 *   1. Centroid-center the positions.
 *   2. Compute the 3×3 covariance matrix.
 *   3. Run Jacobi eigen-decomposition to obtain eigenvalues
 *      `λ₁ ≥ λ₂ ≥ λ₃` and eigenvectors `e₁, e₂, e₃`.
 *   4. Classify the geometry (spherical / planar / linear / general) using
 *      the eigenvalue ratio thresholds in the spec.
 *   5. Build the camera basis for the classified case.
 *   6. Deterministically flip eigenvector signs so two runs on the same
 *      point cloud never produce an orientation-flipped view.
 *   7. Apply a fixed display tilt of `(rotX = 0.087, rotY = 0.175)` so
 *      edge-on planar cases still have depth cues.
 *
 * Pure; no React, no DOM. Output is a {@link CapsulePreviewCamera2D} that
 * the projection module consumes.
 */

import type { CapsulePreviewScene3D } from './capsule-preview-frame';

export interface CapsulePreviewCamera2D {
  /** Applied after the camera rotation and before translation. */
  scale: number;
  /** Applied after scale in the projector — the projector resolves its own
   *  `tx`/`ty` from the final bounds, so we return 0 here. Kept in the
   *  contract for future flexibility. */
  tx: number;
  ty: number;
  /** Row-major 3×3 rotation. `[0..2]` = X row, `[3..5]` = Y row, `[6..8]`
   *  = Z row. Applied to centroid-centered world positions. */
  rotation3x3: [
    number, number, number,
    number, number, number,
    number, number, number,
  ];
  /** Geometry class used — emitted for logs and tests. */
  classification: 'spherical' | 'planar' | 'linear' | 'general' | 'degenerate';
}

const FIXED_TILT_X = 0.087; // ≈ 5°
const FIXED_TILT_Y = 0.175; // ≈ 10°

// Geometry classification thresholds (spec §Orientation policy).
const SPHERICAL_RATIO = 0.85; // λ₃/λ₁ > this → spherical (PCA underdetermined)
const PLANAR_RATIO = 0.15;    // λ₃/λ₂ < this → planar
const LINEAR_RATIO = 0.15;    // λ₂/λ₁ < this → linear

/** Symmetric 3×3 multiply: R = A * B (only the values we use are computed). */
function mul3(
  a: readonly number[],
  b: readonly number[],
): [number, number, number, number, number, number, number, number, number] {
  const out: [number, number, number, number, number, number, number, number, number] =
    [0, 0, 0, 0, 0, 0, 0, 0, 0];
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      let s = 0;
      for (let k = 0; k < 3; k++) s += a[r * 3 + k] * b[k * 3 + c];
      out[r * 3 + c] = s;
    }
  }
  return out;
}

function normalize3(v: [number, number, number]): [number, number, number] {
  const l = Math.hypot(v[0], v[1], v[2]);
  if (l === 0) return [0, 0, 0];
  return [v[0] / l, v[1] / l, v[2] / l];
}

function cross3(
  a: readonly [number, number, number],
  b: readonly [number, number, number],
): [number, number, number] {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

function dot3(
  a: readonly [number, number, number],
  b: readonly [number, number, number],
): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

/**
 * Jacobi eigen-decomposition for a 3×3 symmetric matrix. Returns sorted
 * eigenvalues (descending) and matching eigenvectors.
 *
 * Iteration cap is 50; 3×3 symmetric cases converge in well under that.
 * On divergence we still return whatever the current state is — the
 * classification step has sane fallbacks.
 */
function eigenSym3(
  m: readonly number[],
): { values: [number, number, number]; vectors: [[number, number, number], [number, number, number], [number, number, number]] } {
  // Working copy (mutated by rotations).
  const a = [
    m[0], m[1], m[2],
    m[3], m[4], m[5],
    m[6], m[7], m[8],
  ];
  // V accumulates the rotations so its columns are the eigenvectors.
  const v = [1, 0, 0, 0, 1, 0, 0, 0, 1];

  const off = () => Math.abs(a[1]) + Math.abs(a[2]) + Math.abs(a[5]);
  for (let iter = 0; iter < 50 && off() > 1e-10; iter++) {
    // Pick the largest off-diagonal element (one of a[1]=a12, a[2]=a13, a[5]=a23).
    let p = 0, q = 1;
    if (Math.abs(a[2]) > Math.abs(a[1])) { p = 0; q = 2; }
    if (Math.abs(a[5]) > Math.abs(a[p * 3 + q])) { p = 1; q = 2; }
    const app = a[p * 3 + p];
    const aqq = a[q * 3 + q];
    const apq = a[p * 3 + q];
    if (Math.abs(apq) < 1e-14) break;
    const theta = (aqq - app) / (2 * apq);
    const t = Math.sign(theta) === 0
      ? 1
      : Math.sign(theta) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
    const c = 1 / Math.sqrt(t * t + 1);
    const s = t * c;
    // Rotate a.
    a[p * 3 + p] = app - t * apq;
    a[q * 3 + q] = aqq + t * apq;
    a[p * 3 + q] = 0;
    a[q * 3 + p] = 0;
    for (let k = 0; k < 3; k++) {
      if (k === p || k === q) continue;
      const akp = a[k * 3 + p];
      const akq = a[k * 3 + q];
      a[k * 3 + p] = c * akp - s * akq;
      a[p * 3 + k] = a[k * 3 + p];
      a[k * 3 + q] = s * akp + c * akq;
      a[q * 3 + k] = a[k * 3 + q];
    }
    // Rotate v.
    for (let k = 0; k < 3; k++) {
      const vkp = v[k * 3 + p];
      const vkq = v[k * 3 + q];
      v[k * 3 + p] = c * vkp - s * vkq;
      v[k * 3 + q] = s * vkp + c * vkq;
    }
  }

  // Extract eigenvalues + eigenvectors, then sort descending by eigenvalue.
  const pairs: Array<{ val: number; vec: [number, number, number] }> = [
    { val: a[0], vec: [v[0], v[3], v[6]] },
    { val: a[4], vec: [v[1], v[4], v[7]] },
    { val: a[8], vec: [v[2], v[5], v[8]] },
  ];
  pairs.sort((p, q) => q.val - p.val);
  return {
    values: [pairs[0].val, pairs[1].val, pairs[2].val],
    vectors: [pairs[0].vec, pairs[1].vec, pairs[2].vec],
  };
}

/** Flip eigenvector sign so it aligns with the actual distribution of
 *  centered positions (spec §Sign disambiguation). */
function signNormalize(
  vec: [number, number, number],
  centered: ReadonlyArray<[number, number, number]>,
): [number, number, number] {
  let s = 0;
  for (const p of centered) s += dot3(p, vec);
  if (s < 0) return [-vec[0], -vec[1], -vec[2]];
  return vec;
}

function rotX(theta: number): number[] {
  const c = Math.cos(theta), s = Math.sin(theta);
  return [1, 0, 0, 0, c, -s, 0, s, c];
}

function rotY(theta: number): number[] {
  const c = Math.cos(theta), s = Math.sin(theta);
  return [c, 0, s, 0, 1, 0, -s, 0, c];
}

/**
 * Derive the canonical preview camera for the given 3D scene. Deterministic
 * for identical scene input.
 */
export function deriveCanonicalPreviewCamera(
  scene: CapsulePreviewScene3D,
): CapsulePreviewCamera2D {
  const [cx, cy, cz] = scene.bounds.center;
  const centered: [number, number, number][] = scene.atoms.map(
    (a) => [a.x - cx, a.y - cy, a.z - cz],
  );

  // Degenerate small-input guard: 0 or 1 atom → identity camera.
  if (centered.length <= 1) {
    return {
      scale: 1,
      tx: 0,
      ty: 0,
      rotation3x3: [1, 0, 0, 0, 1, 0, 0, 0, 1],
      classification: 'degenerate',
    };
  }

  // Two-atom case: axis along (p1 - p0); rotate it onto +X.
  if (centered.length === 2) {
    const d: [number, number, number] = [
      centered[1][0] - centered[0][0],
      centered[1][1] - centered[0][1],
      centered[1][2] - centered[0][2],
    ];
    const dn = normalize3(d);
    // Build a basis with X = dn, Y = any orthogonal axis, Z = X×Y.
    let yCand: [number, number, number] =
      Math.abs(dn[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
    // Project out the X component so Y is orthogonal.
    const ax = dot3(yCand, dn);
    yCand = [
      yCand[0] - ax * dn[0],
      yCand[1] - ax * dn[1],
      yCand[2] - ax * dn[2],
    ];
    const yn = normalize3(yCand);
    const zn = cross3(dn, yn);
    const basis = [
      dn[0], dn[1], dn[2],
      yn[0], yn[1], yn[2],
      zn[0], zn[1], zn[2],
    ];
    const tilt = mul3(rotX(FIXED_TILT_X), rotY(FIXED_TILT_Y));
    const r = mul3(tilt, basis);
    return {
      scale: 1,
      tx: 0,
      ty: 0,
      rotation3x3: r,
      classification: 'linear',
    };
  }

  // Covariance matrix (unnormalized — eigenvalue ratios are what matters).
  let cxx = 0, cyy = 0, czz = 0, cxy = 0, cxz = 0, cyz = 0;
  for (const p of centered) {
    cxx += p[0] * p[0];
    cyy += p[1] * p[1];
    czz += p[2] * p[2];
    cxy += p[0] * p[1];
    cxz += p[0] * p[2];
    cyz += p[1] * p[2];
  }
  const cov = [
    cxx, cxy, cxz,
    cxy, cyy, cyz,
    cxz, cyz, czz,
  ];

  const totalVariance = cxx + cyy + czz;
  if (totalVariance === 0 || !Number.isFinite(totalVariance)) {
    return {
      scale: 1,
      tx: 0,
      ty: 0,
      rotation3x3: [1, 0, 0, 0, 1, 0, 0, 0, 1],
      classification: 'degenerate',
    };
  }

  const { values, vectors } = eigenSym3(cov);
  const [l1, l2, l3] = values;
  const ratio31 = l1 > 0 ? l3 / l1 : 0;
  const ratio32 = l2 > 0 ? l3 / l2 : 0;
  const ratio21 = l1 > 0 ? l2 / l1 : 0;

  let classification: CapsulePreviewCamera2D['classification'];
  let ex: [number, number, number];
  let ey: [number, number, number];
  let ez: [number, number, number];

  if (ratio31 > SPHERICAL_RATIO) {
    classification = 'spherical';
    ex = [1, 0, 0];
    ey = [0, 1, 0];
    ez = [0, 0, 1];
  } else if (ratio21 < LINEAR_RATIO) {
    classification = 'linear';
    ex = signNormalize(vectors[0], centered);
    // Build Y by projecting world +Y orthogonal to ex.
    const ay = dot3([0, 1, 0], ex);
    const yCand: [number, number, number] = [
      -ay * ex[0],
      1 - ay * ex[1],
      -ay * ex[2],
    ];
    ey = normalize3(yCand);
    // If world +Y is nearly parallel to ex, pick +X instead.
    if (Math.hypot(ey[0], ey[1], ey[2]) < 1e-6) {
      const ax = dot3([1, 0, 0], ex);
      const xCand: [number, number, number] = [
        1 - ax * ex[0],
        -ax * ex[1],
        -ax * ex[2],
      ];
      ey = normalize3(xCand);
    }
    ez = cross3(ex, ey);
  } else if (ratio32 < PLANAR_RATIO) {
    classification = 'planar';
    ex = signNormalize(vectors[0], centered);
    ey = signNormalize(vectors[1], centered);
    ez = cross3(ex, ey);
  } else {
    classification = 'general';
    ex = signNormalize(vectors[0], centered);
    ey = signNormalize(vectors[1], centered);
    ez = cross3(ex, ey);
  }

  const basis = [
    ex[0], ex[1], ex[2],
    ey[0], ey[1], ey[2],
    ez[0], ez[1], ez[2],
  ];
  const tilt = mul3(rotX(FIXED_TILT_X), rotY(FIXED_TILT_Y));
  const r = mul3(tilt, basis);
  return {
    scale: 1,
    tx: 0,
    ty: 0,
    rotation3x3: r,
    classification,
  };
}
