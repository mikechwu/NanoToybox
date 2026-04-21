/**
 * Experimental perspective sketch renderer.
 *
 * Companion to `capsule-preview-sketch.ts`, but:
 *   - Camera: PCA basis with the smallest eigenvector (e₃) as the depth
 *     axis; no fixed display tilt. Planar clouds read face-on, tubes
 *     read side-on, spheres render axis-aligned.
 *   - Projection: pinhole (Hartley & Zisserman, *Multiple View Geometry*,
 *     Ch. 6; same perspective divide used by OpenGL/WebGL). Atom size,
 *     screen position, and bond width all scale with 1/Z so atoms
 *     closer to the virtual camera render larger.
 *   - Presentation: dark-gray atom fill with a thin dark stroke; bonds
 *     rendered as a thick solid inner stroke surrounded by a thin
 *     darker outer stroke — the "thin border" treatment at ~3× the
 *     previous inner-rail width.
 *
 * Perspective math
 * ----------------
 * Given a camera-space point (x, y, z) with z_max = nearest atom,
 * z_min = farthest, span S = z_max − z_min, place the virtual camera
 * at z_cam = z_max + D where D = K·S (K = 1.5 by default). Then:
 *
 *     dist(z) = D + (z_max − z)
 *     s(z)    = D / dist(z)            ∈ (0, 1]
 *
 *     x_screen = x · s(z)
 *     y_screen = y · s(z)
 *     r_screen = r_base · s(z)
 *
 * At z = z_max the scale is 1; at z = z_min it is D/(D+S) = K/(K+1).
 * With K = 1.5 the farthest atoms render at 60% the size of the
 * closest — a natural depth cue without caricature. Equivalent to the
 * classical pinhole form `x_img = f · X / Z` with f = D and Z = dist(z).
 *
 * Pure module: no DOM, no React runtime dependencies. Returns plain
 * SVG strings (same shape as `renderPreviewSketchSvgString`).
 */

import type { CapsulePreviewScene3D } from './capsule-preview-frame';
import type { CapsulePreviewCamera2D } from './capsule-preview-camera';
import { deriveMinorAxisCamera } from './capsule-preview-camera';
import { deriveBondPairs } from './capsule-preview-project';

// ── Types ────────────────────────────────────────────────────────────

export interface PerspectivePreset {
  width: number;
  height: number;
  /** Atom fill color. */
  atomFill: string;
  /** Atom outline color. */
  atomStroke: string;
  /** Bond body fill — renders on top of the border. */
  bondInnerColor: string;
  /** Thin darker outer stroke that renders as the bond border. */
  bondBorderColor: string;
  /** Solid SVG background color. */
  background: string;
  /** Padding as a fraction of the shorter output axis. */
  padding: number;
  /**
   * Pinhole focal-length factor K: camera placed K·S behind the
   * nearest atom where S is the depth span. Larger K → flatter image.
   * K = 1.5 gives 60% size at the farthest atom.
   */
  cameraDistanceFactor: number;
  /**
   * Atom base radius as a fraction of the median projected
   * nearest-neighbor (NN) distance. Density-aware: the SAME value
   * produces visually consistent atom sizes across any canvas size
   * and any atom count. Default 0.30 (atom diameter ≈ 60% of
   * spacing — visually dense without overlap).
   */
  atomRadiusFraction: number;
  /**
   * Bond body width as a fraction of the median projected NN
   * distance. Default 0.17.
   */
  bondWidthFraction: number;
  /** Atom stroke width as a fraction of the atom base radius. Uniform
   *  across the scene (line weight). Default 0.07. Floored at 0.5 px. */
  atomStrokeRatio: number;
  /** Bond border width per side as a fraction of the bond base width.
   *  Uniform across the scene. Default 0.08. Floored at 0.5 px. */
  bondBorderRatio: number;
  /** Pixel floor for atom radius so dense thumbs don't collapse into
   *  sub-pixel dots. No ceiling — perspective grows nearest atoms
   *  freely. */
  atomRadiusMin: number;
}

/**
 * Discriminated union for the paint pipeline. Single flat type
 * instead of a base interface + two extenders — nothing outside this
 * module needs the `PerspectivePrimitive` parent, and the
 * discrimination via `kind` captures the z/paint-order contract
 * directly.
 */
export type PaintItem =
  | {
      kind: 'circle';
      z: number;
      paintOrder: 1;
      cx: number;
      cy: number;
      r: number;
      fill: string;
      stroke: string;
      strokeWidth: number;
    }
  | {
      kind: 'bond';
      z: number;
      paintOrder: 0;
      x1: number;
      y1: number;
      x2: number;
      y2: number;
      innerColor: string;
      innerWidth: number;
      borderColor: string;
      borderWidth: number;
    };

export interface PerspectiveRenderResult {
  svg: string;
  /** Per-render diagnostics for captions / tests. */
  stats: {
    atoms: number;
    bonds: number;
    /** Number of 3D bond pairs that could not be resolved to two
     *  projected atoms (should always be 0 on valid capsules; > 0
     *  indicates an index-drift regression upstream). */
    droppedBonds: number;
    minScale: number;
    maxScale: number;
    classification: CapsulePreviewCamera2D['classification'];
    cameraDistanceFactor: number;
    /** How the atom/bond size scale was derived. Valuable for
     *  reviewers: `bond3d` is the normal path, `nn3d` means the
     *  bond policy returned no pairs, `canvas-fallback` means the
     *  scene has fewer than two atoms (or all coincident). */
    scaleSource: 'bond3d' | 'nn3d' | 'canvas-fallback';
    /** True when the camera-space depth span collapsed below the
     *  numerical floor — perspective effectively degenerates to
     *  orthographic. Callers should surface this so reviewers
     *  aren't misled by a literal `s∈[1.00, 1.00]` caption. */
    degenerateDepth: boolean;
  };
}

// ── Presets ──────────────────────────────────────────────────────────

/**
 * Shared presentation ratios. All three presets use the same
 * density-aware fractions so the poster, thumb, and audit-large
 * figure are visually consistent — the only things that differ
 * per-preset are canvas dimensions, padding, and the legibility
 * floor for atom radius.
 *
 * Ratios chosen to reproduce the poster look (d_nn ≈ 70 px, atom
 * radius ≈ 21 px, bond width ≈ 12 px → 0.30 and 0.17 respectively).
 */
const SHARED_PRESENTATION = {
  atomFill: '#4a4a4a',
  atomStroke: '#000000',
  bondInnerColor: '#ffffff',
  bondBorderColor: '#000000',
  background: '#ffffff',
  cameraDistanceFactor: 1.5,
  atomRadiusFraction: 0.18,
  bondWidthFraction: 0.10,
  atomStrokeRatio: 0.07,
  bondBorderRatio: 0.08,
} as const;

/**
 * Atom 3D-shading parameters.
 *
 * SVG radial gradient with the focal point shifted toward the upper-
 * left simulates a light source above-left of each atom — the standard
 * "shaded sphere" look you see in chemistry textbooks. The gradient
 * uses `objectBoundingBox` units (default) so one `<defs>` block
 * services every circle regardless of its perspective-scaled radius.
 *
 * Geometry: cx/cy centered, r = 50% of the bounding box,
 *   fx/fy offset to (30%, 30%) — validated per MDN SVG + standard
 *   ball-shading tutorials.
 *
 * Stops:
 *   0%   highlight   lightened gray
 *   55%  midtone     anchors the base atom color so the gradient does
 *                    not shift the figure's overall brightness
 *   100% rim shadow  subtle darkening at silhouette for depth
 */
const ATOM_3D_GRADIENT = {
  cx: '50%',
  cy: '50%',
  r: '50%',
  fx: '30%',
  fy: '30%',
  stopHighlight: { offset: '0%', color: '#b0b0b0' },
  stopMidtone: { offset: '55%', color: '#4a4a4a' },
  stopShadow: { offset: '100%', color: '#1c1c1c' },
} as const;

/** Build a collision-safe unique gradient ID. A module-level counter
 *  would reset on HMR reload while the DOM still holds the previous
 *  `<defs>` → the same id then resolves to the stale sibling panel's
 *  gradient (`url(#…)` picks the first match in document order).
 *  A random suffix sidesteps that race entirely. */
function makeGradientId(): string {
  const g: { crypto?: { randomUUID?: () => string } } =
    typeof globalThis !== 'undefined' ? (globalThis as never) : {};
  const randomPart =
    g.crypto && typeof g.crypto.randomUUID === 'function'
      ? g.crypto.randomUUID().slice(0, 8)
      : Math.random().toString(36).slice(2, 10);
  return `pa-atom-3d-${randomPart}`;
}

/** Audit workbench — the design-authority canvas. */
export const PERSPECTIVE_LARGE_PRESET: PerspectivePreset = {
  ...SHARED_PRESENTATION,
  width: 800,
  height: 800,
  padding: 0.06,
  // Floor chosen so a single-atom fixture still renders a legible dot
  // without tripping the perspective-grow ceiling. Scales roughly
  // with canvas size so thumbs keep their floor tiny.
  atomRadiusMin: 6,
};

/** Poster figure pane — 600×500 matches the production OG-poster pane. */
export const PERSPECTIVE_POSTER_PRESET: PerspectivePreset = {
  ...SHARED_PRESENTATION,
  width: 600,
  height: 500,
  padding: 0.05,
  atomRadiusMin: 4,
};

/** Account-thumb cell — 100×100 viewBox scales to 40 physical px. */
export const PERSPECTIVE_THUMB_PRESET: PerspectivePreset = {
  ...SHARED_PRESENTATION,
  width: 100,
  height: 100,
  padding: 0.05,
  atomRadiusMin: 1,
};

// ── Math helpers ─────────────────────────────────────────────────────

function applyRotation(
  r: CapsulePreviewCamera2D['rotation3x3'],
  p: readonly [number, number, number],
): [number, number, number] {
  return [
    r[0] * p[0] + r[1] * p[1] + r[2] * p[2],
    r[3] * p[0] + r[4] * p[1] + r[5] * p[2],
    r[6] * p[0] + r[7] * p[1] + r[8] * p[2],
  ];
}

/** Strip the fixed display tilt from a canonical camera so the
 *  projection is orthographic along PCA e₁/e₂/e₃ with no angular
 *  offset. The canonical camera bakes a `rotX·rotY` tilt into its
 *  3×3; undoing it is equivalent to rebuilding the PCA basis without
 *  the tilt factor.
 *
 *  Classification asymmetry: the canonical `degenerate` branch
 *  returns identity WITHOUT applying the tilt (see
 *  capsule-preview-camera.ts — the early-exit degenerate path). For
 *  every other classification the canonical form is `R = tilt ·
 *  basis`, so `tilt⁻¹ · R = basis`. For `degenerate` the input is
 *  already un-tilted; left-multiplying by `tilt⁻¹` would inject a
 *  spurious rotation. Short-circuit that case.
 */
// `untiltCamera` + `deriveMinorAxisCamera` live in
// `capsule-preview-camera.ts`. This module imports the latter at
// the top; no re-export needed (verified no consumer depends on
// the sketch-perspective path).

/**
 * Median 3D bond length from a pre-computed bond list. This is the
 * molecule's true physical length scale in world units (Å). Used as
 * the invariant the atom radius and bond width scale off of, so the
 * `atom_radius / bond_length` ratio stays locked regardless of view
 * direction, perspective, or canvas size.
 *
 * For bondless or degenerate inputs the caller falls back to the 3D
 * nearest-neighbor heuristic below.
 */
function medianBondLength3D(
  scene: CapsulePreviewScene3D,
  bonds: ReadonlyArray<{ a: number; b: number }>,
): number {
  if (bonds.length === 0) return 0;
  const lengths: number[] = [];
  for (const { a, b } of bonds) {
    const pa = scene.atoms[a];
    const pb = scene.atoms[b];
    if (!pa || !pb) continue;
    const d = Math.hypot(pa.x - pb.x, pa.y - pb.y, pa.z - pb.z);
    if (Number.isFinite(d) && d > 0) lengths.push(d);
  }
  if (lengths.length === 0) return 0;
  lengths.sort((a, b) => a - b);
  return lengths[Math.floor(lengths.length / 2)];
}

/**
 * Median 3D nearest-neighbor distance over the scene's atoms. Fallback
 * scale when the bond cutoff returned nothing. O(n²), fine for our
 * preview caps.
 */
function medianNearestNeighbor3D(
  atoms: ReadonlyArray<{ x: number; y: number; z: number }>,
): number {
  const n = atoms.length;
  if (n < 2) return 0;
  const nnDists: number[] = [];
  for (let i = 0; i < n; i++) {
    let minD = Infinity;
    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      const d = Math.hypot(
        atoms[i].x - atoms[j].x,
        atoms[i].y - atoms[j].y,
        atoms[i].z - atoms[j].z,
      );
      if (d > 0 && d < minD) minD = d;
    }
    if (Number.isFinite(minD)) nnDists.push(minD);
  }
  if (nnDists.length === 0) return 0;
  nnDists.sort((a, b) => a - b);
  return nnDists[Math.floor(nnDists.length / 2)];
}

// ── Render pipeline ──────────────────────────────────────────────────

interface ProjectedAtom {
  atomId: number;
  /** Pixel-space after perspective + fit. */
  x: number;
  y: number;
  /** Perspective-scaled radius. */
  r: number;
  /** Camera-space depth (larger = closer). For sort. */
  z: number;
  /** Perspective scale used at this atom, s(z) ∈ (0, 1]. */
  scale: number;
}

/**
 * Project + fit + paint. Returns ready-to-embed SVG text plus a small
 * stats bundle for captions / tests.
 */
export function renderPerspectiveSketch(
  scene: CapsulePreviewScene3D,
  preset: PerspectivePreset,
  opts: { cutoff?: number; minDist?: number } = {},
): PerspectiveRenderResult {
  const cam = deriveMinorAxisCamera(scene);
  const [ccx, ccy, ccz] = scene.bounds.center;

  // 1) Rotate atoms into camera space.
  const rotated: Array<{ atomId: number; x: number; y: number; z: number }> = [];
  for (const atom of scene.atoms) {
    const [x, y, z] = applyRotation(cam.rotation3x3, [
      atom.x - ccx,
      atom.y - ccy,
      atom.z - ccz,
    ]);
    rotated.push({ atomId: atom.atomId, x, y, z });
  }
  if (rotated.length === 0) {
    return {
      svg: `<svg xmlns="http://www.w3.org/2000/svg" width="${preset.width}" height="${preset.height}" viewBox="0 0 ${preset.width} ${preset.height}"><rect width="${preset.width}" height="${preset.height}" fill="${preset.background}"/></svg>`,
      stats: {
        atoms: 0,
        bonds: 0,
        droppedBonds: 0,
        minScale: 1,
        maxScale: 1,
        classification: cam.classification,
        cameraDistanceFactor: preset.cameraDistanceFactor,
        scaleSource: 'canvas-fallback',
        degenerateDepth: true,
      },
    };
  }

  // 2) Camera depth range → pinhole focal length D = K · span.
  // Detect degenerate depth (planar molecule viewed face-on, single
  // atom, all coincident) so the caller can surface it — otherwise a
  // `s∈[1.00, 1.00]` caption is indistinguishable from a successful
  // shallow-perspective render.
  let zMin = Infinity, zMax = -Infinity;
  for (const a of rotated) {
    if (a.z < zMin) zMin = a.z;
    if (a.z > zMax) zMax = a.z;
  }
  const rawSpan = zMax - zMin;
  const degenerateDepth = !(rawSpan > 1e-9);
  const span = Math.max(1e-9, rawSpan);
  const D = preset.cameraDistanceFactor * span;

  // Perspective scale for camera-space depth z. s(z_max) = 1 (closest);
  // s(z_min) = K / (K+1). Classical pinhole divide.
  const perspectiveScale = (z: number): number => {
    const dist = D + (zMax - z); // strictly positive
    return D / dist;
  };

  // 3) Apply perspective in camera space — pre-fit x/y and radius.
  const perspAtoms = rotated.map((a) => {
    const s = perspectiveScale(a.z);
    return {
      atomId: a.atomId,
      x: a.x * s,
      y: a.y * s,
      z: a.z,
      scale: s,
      // Base radius at scale 1; we'll apply the scale and floor below
      // after we know the fit-to-bounds scale factor.
    };
  });

  // 4) Find 2D bounds post-perspective and fit into the padded target.
  let bxMin = Infinity, bxMax = -Infinity, byMin = Infinity, byMax = -Infinity;
  for (const a of perspAtoms) {
    if (a.x < bxMin) bxMin = a.x;
    if (a.y < byMin) byMin = a.y;
    if (a.x > bxMax) bxMax = a.x;
    if (a.y > byMax) byMax = a.y;
  }
  const spanX = Math.max(1e-9, bxMax - bxMin);
  const spanY = Math.max(1e-9, byMax - byMin);
  const availW = preset.width * (1 - 2 * preset.padding);
  const availH = preset.height * (1 - 2 * preset.padding);
  const fit = Math.min(availW / spanX, availH / spanY);
  const midX = (bxMin + bxMax) / 2;
  const midY = (byMin + byMax) / 2;

  // 5) Derive bonds from the ORIGINAL 3D scene (uses scene3D atom
  // indices). Computed up-front so the atom/bond size scale can be
  // locked to the physical bond length — independent of canvas,
  // molecule orientation, or packing. The same index-drift-safe
  // pattern as `deriveBondPairsForProjectedScene` below.
  const cutoff = opts.cutoff ?? 1.85;
  const minDist = opts.minDist ?? 0.5;
  const rawBonds = deriveBondPairs(scene, cutoff, minDist);

  // 6) LOCKED SCALE. The `atom_radius / bond_length` ratio is the
  // invariant we want across every molecule — a C60 render and a
  // graphene render should have atoms of identical size relative to
  // their bonds, because C–C bonds are ≈1.4 Å in both.
  //
  // Previous versions derived scale from the projected 2D median NN
  // distance, which is orientation- and perspective-dependent: same
  // molecule viewed edge-on vs face-on yielded different atom sizes.
  // Using the physical 3D bond length as the anchor removes that
  // drift; `fit` converts world Å → pixels and the fraction closes
  // the ratio.
  //
  // Fallback ladder for structures whose bond policy returns nothing
  // (sparse clusters, isolated atoms): median 3D NN distance, then
  // canvas-proportional last resort.
  const shorterAxis = Math.min(preset.width, preset.height);
  let scaleSource: PerspectiveRenderResult['stats']['scaleSource'];
  let bondLen3D = medianBondLength3D(scene, rawBonds);
  if (bondLen3D > 0) {
    scaleSource = 'bond3d';
  } else {
    bondLen3D = medianNearestNeighbor3D(scene.atoms);
    if (bondLen3D > 0) {
      scaleSource = 'nn3d';
    } else {
      // Canvas-fallback: `shorterAxis * 0.3 / fit` cancels when re-
      // multiplied by `fit` below, yielding `shorterAxis * 0.3` on
      // screen — a stable visible size for single-atom / coincident
      // fixtures regardless of what `fit` resolves to.
      bondLen3D = (shorterAxis * 0.3) / fit;
      scaleSource = 'canvas-fallback';
    }
  }
  const bondLenScreenAt1 = bondLen3D * fit;

  const atomBase = Math.max(
    preset.atomRadiusMin,
    bondLenScreenAt1 * preset.atomRadiusFraction,
  );
  const bondBase = Math.max(0.5, bondLenScreenAt1 * preset.bondWidthFraction);
  const atomStrokeWidth = Math.max(0.5, atomBase * preset.atomStrokeRatio);
  const bondBorderWidth = Math.max(0.5, bondBase * preset.bondBorderRatio);

  // 7) Compute screen-space atom positions and perspective-scaled
  // radii. Stroke width is uniform across the scene (molecular-viz
  // convention — consistent line weight reads better than per-atom
  // variance).
  const projected: ProjectedAtom[] = perspAtoms.map((a) => {
    const r = Math.max(preset.atomRadiusMin, atomBase * a.scale);
    return {
      atomId: a.atomId,
      x: preset.width / 2 + (a.x - midX) * fit,
      y: preset.height / 2 + (a.y - midY) * fit,
      r,
      z: a.z,
      scale: a.scale,
    };
  });

  const atomIdToIndex = new Map<number, number>();
  projected.forEach((a, i) => atomIdToIndex.set(a.atomId, i));

  /**
   * Primitives are z-sorted TOGETHER (bonds + atoms) so painter's
   * algorithm is globally honest: a far atom painted into the same
   * layer as a near bond will not end up on top of it.
   *
   * Z assignment:
   *   - Atom: z = atom.z.
   *   - Bond: z = min(z_a, z_b) = the FARTHEST endpoint. This makes
   *     the bond draw right after its far atom (so the far atom caps
   *     the far end) but before its near atom (so the near atom caps
   *     the near end).
   *
   * Tie-break: when a bond and its own endpoint atom share the same
   * z (the far endpoint), the bond must draw FIRST so the atom disc
   * then overpaints the bond end — standard molecular convention.
   * Encoded via a paint-order field (bond = 0, atom = 1) consulted
   * as a secondary sort key.
   */
  const items: PaintItem[] = [];
  let droppedBonds = 0;

  for (const pair of rawBonds) {
    const srcA = scene.atoms[pair.a];
    const srcB = scene.atoms[pair.b];
    if (!srcA || !srcB) {
      droppedBonds += 1;
      continue;
    }
    const ia = atomIdToIndex.get(srcA.atomId);
    const ib = atomIdToIndex.get(srcB.atomId);
    if (ia == null || ib == null || ia === ib) {
      droppedBonds += 1;
      continue;
    }
    const A = projected[ia];
    const B = projected[ib];
    const midScale = (A.scale + B.scale) / 2;
    // Inner body shrinks with perspective; border is a uniform per-
    // side line weight (no perspective) so bonds keep a crisp edge
    // regardless of depth. The 0.5 px floor keeps bonds legible at
    // tiny presets / deep perspective — without it, `fmt()` rounds
    // sub-0.5 px widths to `stroke-width="0"` and bonds disappear.
    const innerW = Math.max(0.5, bondBase * midScale);
    const borderW = innerW + bondBorderWidth * 2;
    items.push({
      kind: 'bond',
      paintOrder: 0,
      x1: A.x,
      y1: A.y,
      x2: B.x,
      y2: B.y,
      innerColor: preset.bondInnerColor,
      innerWidth: innerW,
      borderColor: preset.bondBorderColor,
      borderWidth: borderW,
      z: Math.min(A.z, B.z),
    });
  }
  if (droppedBonds > 0) {
    // eslint-disable-next-line no-console
    console.warn(
      `[capsule-preview-sketch-perspective] dropped ${droppedBonds} bond pair(s) during projected-index translation — check atomId uniqueness`,
    );
  }
  // Per-render gradient ID so multiple figures on the same page do
  // not collide on their `url(#…)` references.
  const gradientId = makeGradientId();

  for (const a of projected) {
    items.push({
      kind: 'circle',
      paintOrder: 1,
      cx: a.x,
      cy: a.y,
      r: a.r,
      fill: `url(#${gradientId})`,
      stroke: preset.atomStroke,
      strokeWidth: atomStrokeWidth,
      z: a.z,
    });
  }
  items.sort(
    (p, q) => (p.z - q.z) || (p.paintOrder - q.paintOrder),
  );

  // Emit SVG text. Paint order = sort order. `<defs>` block holds
  // the shared atom gradient; `objectBoundingBox` gradient units
  // (the default) auto-scale the gradient to each circle's radius,
  // so one definition serves atoms of all perspective-scaled sizes.
  const parts: string[] = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${preset.width}" height="${preset.height}" viewBox="0 0 ${preset.width} ${preset.height}">`,
  );
  parts.push(
    `<defs>` +
      `<radialGradient id="${gradientId}" cx="${ATOM_3D_GRADIENT.cx}" cy="${ATOM_3D_GRADIENT.cy}" r="${ATOM_3D_GRADIENT.r}" fx="${ATOM_3D_GRADIENT.fx}" fy="${ATOM_3D_GRADIENT.fy}">` +
      `<stop offset="${ATOM_3D_GRADIENT.stopHighlight.offset}" stop-color="${ATOM_3D_GRADIENT.stopHighlight.color}"/>` +
      `<stop offset="${ATOM_3D_GRADIENT.stopMidtone.offset}" stop-color="${ATOM_3D_GRADIENT.stopMidtone.color}"/>` +
      `<stop offset="${ATOM_3D_GRADIENT.stopShadow.offset}" stop-color="${ATOM_3D_GRADIENT.stopShadow.color}"/>` +
      `</radialGradient>` +
      `</defs>`,
  );
  parts.push(
    `<rect x="0" y="0" width="${preset.width}" height="${preset.height}" fill="${preset.background}"/>`,
  );
  let bondCount = 0;
  for (const item of items) {
    if (item.kind === 'bond') {
      bondCount += 1;
      // Outer stroke first (thin dark border), inner body on top.
      parts.push(
        `<line x1="${fmt(item.x1)}" y1="${fmt(item.y1)}" x2="${fmt(item.x2)}" y2="${fmt(item.y2)}" stroke="${item.borderColor}" stroke-width="${fmt(item.borderWidth)}" stroke-linecap="round"/>`,
      );
      parts.push(
        `<line x1="${fmt(item.x1)}" y1="${fmt(item.y1)}" x2="${fmt(item.x2)}" y2="${fmt(item.y2)}" stroke="${item.innerColor}" stroke-width="${fmt(item.innerWidth)}" stroke-linecap="round"/>`,
      );
    } else {
      parts.push(
        `<circle cx="${fmt(item.cx)}" cy="${fmt(item.cy)}" r="${fmt(item.r)}" fill="${item.fill}" stroke="${item.stroke}" stroke-width="${fmt(item.strokeWidth)}"/>`,
      );
    }
  }
  parts.push('</svg>');

  let minScale = Infinity, maxScale = -Infinity;
  for (const a of projected) {
    if (a.scale < minScale) minScale = a.scale;
    if (a.scale > maxScale) maxScale = a.scale;
  }
  if (!Number.isFinite(minScale)) minScale = 1;
  if (!Number.isFinite(maxScale)) maxScale = 1;

  return {
    svg: parts.join(''),
    stats: {
      atoms: projected.length,
      bonds: bondCount,
      droppedBonds,
      minScale,
      maxScale,
      classification: cam.classification,
      cameraDistanceFactor: preset.cameraDistanceFactor,
      scaleSource,
      degenerateDepth,
    },
  };
}

function fmt(n: number): string {
  // Throw on non-finite instead of silently coercing to '0' — a NaN
  // arriving here is a bug in the projection pipeline (e.g. 0/0 from
  // a degenerate perspective divide), and silently emitting '0'
  // would pile atoms at the origin without any error surface.
  // Throwing lets the SketchFigure ErrorBoundary catch it and render
  // a visible .pa-error instead of a blank panel.
  if (!Number.isFinite(n)) {
    throw new Error(`capsule-preview-sketch-perspective: non-finite value in fmt(): ${n}`);
  }
  return Number(n.toFixed(3)).toString();
}
