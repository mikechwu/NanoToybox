/**
 * 3D → 2D projection + fit-to-bounds for the V2 capsule preview (spec
 * §capsule-preview-project).
 *
 * Consumes a {@link CapsulePreviewScene3D} (and optional camera override)
 * and emits a {@link CapsulePreviewRenderScene} ready to lay out into an
 * SVG panel or Satori `ImageResponse`.
 *
 * Also derives the bond-pair list from the scene's atom positions + a
 * bond-policy cutoff, so the scene-store can persist bonds alongside the
 * projected atoms for the OG poster pane (spec §Bonds policy).
 *
 * Pure; server-side safe; no DOM.
 */

import type { CapsulePreviewScene3D } from './capsule-preview-frame';
import {
  deriveCanonicalPreviewCamera,
  deriveMinorAxisCamera,
  type CapsulePreviewCamera2D,
} from './capsule-preview-camera';

export interface CapsulePreviewAtom2D {
  atomId: number;
  /** Pixel-space coordinate inside `bounds.width × bounds.height`. */
  x: number;
  y: number;
  /** Pixel-space radius. */
  r: number;
  colorHex: string;
  /** Post-projection depth. Larger = closer to the viewer. */
  depth: number;
}

export interface CapsulePreviewRenderScene {
  atoms: CapsulePreviewAtom2D[];
  bounds: { width: number; height: number };
  /** Classification used when deriving the camera — purely for logs. */
  classification: CapsulePreviewCamera2D['classification'];
}

export interface ProjectSceneOptions {
  targetWidth?: number;
  targetHeight?: number;
  /** Fit atoms to `1 - 2*padding` of the smaller axis (spec §4 framing). */
  padding?: number;
  /** Minimum pixel radius — prevents atoms vanishing at small thumbs. */
  minRadius?: number;
  /** Maximum pixel radius — prevents giant atoms in sparse scenes. */
  maxRadius?: number;
  camera?: CapsulePreviewCamera2D;
}

const DEFAULT_OPTIONS: Required<Omit<ProjectSceneOptions, 'camera'>> = {
  targetWidth: 600,
  targetHeight: 500,
  padding: 0.1,     // → atoms fit 80% of the smaller axis
  minRadius: 3,
  maxRadius: 40,
};

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

/** Project a 3D scene into pixel-space render atoms. */
export function projectPreviewScene(
  scene: CapsulePreviewScene3D,
  opts: ProjectSceneOptions = {},
): CapsulePreviewRenderScene {
  const {
    targetWidth,
    targetHeight,
    padding,
    minRadius,
    maxRadius,
  } = { ...DEFAULT_OPTIONS, ...opts };
  const camera = opts.camera ?? deriveCanonicalPreviewCamera(scene);
  const [cx, cy, cz] = scene.bounds.center;

  // Rotate all atoms into the canonical basis.
  const rotated: Array<{
    atomId: number;
    x: number;
    y: number;
    z: number;
    colorHex: string;
  }> = [];
  for (const atom of scene.atoms) {
    const p: [number, number, number] = [atom.x - cx, atom.y - cy, atom.z - cz];
    const r = applyRotation(camera.rotation3x3, p);
    rotated.push({
      atomId: atom.atomId,
      x: r[0],
      y: r[1],
      z: r[2],
      colorHex: atom.colorHex,
    });
  }

  // Find the 2D bounds after rotation and fit into the target area.
  let minX = Infinity, maxX = -Infinity;
  let minY = Infinity, maxY = -Infinity;
  for (const a of rotated) {
    if (a.x < minX) minX = a.x;
    if (a.y < minY) minY = a.y;
    if (a.x > maxX) maxX = a.x;
    if (a.y > maxY) maxY = a.y;
  }
  const spanX = Math.max(1e-9, maxX - minX);
  const spanY = Math.max(1e-9, maxY - minY);
  const availW = targetWidth * (1 - 2 * padding);
  const availH = targetHeight * (1 - 2 * padding);
  const scale = Math.min(availW / spanX, availH / spanY);
  const midX = (minX + maxX) / 2;
  const midY = (minY + maxY) / 2;

  // Base atom radius is a small fraction of the scale × mean-neighbor-like
  // heuristic: we normalize to the fit scale so atoms shrink proportionally
  // in dense scenes. Clamped by min/max to stay legible across sizes.
  const baseR = Math.min(
    maxRadius,
    Math.max(minRadius, Math.min(availW, availH) * 0.035),
  );

  const atoms: CapsulePreviewAtom2D[] = rotated.map((a) => ({
    atomId: a.atomId,
    x: targetWidth / 2 + (a.x - midX) * scale,
    y: targetHeight / 2 + (a.y - midY) * scale,
    r: baseR,
    colorHex: a.colorHex,
    depth: a.z,
  }));

  // Sort by depth so nearer atoms draw last (spec §projection sorting).
  atoms.sort((p, q) => p.depth - q.depth);

  return {
    atoms,
    bounds: { width: targetWidth, height: targetHeight },
    classification: camera.classification,
  };
}

/** Default pinhole focal-length factor — camera placed `K·S` behind
 *  the nearest atom where S is the depth span. K ≈ 3.17 places the
 *  farthest atom at ~76% the size of the closest (0.6× the strength
 *  of the previous K=1.5 which gave a 60% far/near ratio). Milder
 *  depth cue than classical pinhole; chosen because the user
 *  reported the stronger perspective made dense fixtures (CNT,
 *  graphene) read as distorted.
 *
 *  Math: to halve the effect, K' solves
 *  `(1 - K'/(K'+1)) = 0.6 · (1 - K/(K+1))` → K' = (K+1)/0.6 − 1.
 *  For K=1.5, K' ≈ 3.166. */
export const PERSPECTIVE_K_DEFAULT = 3.17;

/**
 * Project a 3D scene through pinhole perspective (classical
 * `x_screen = x_cam · s(z)`, `r_screen = r_base · s(z)` with
 * `s(z) = D / (D + z_max − z)`, `D = K·S`). Output shape matches
 * {@link projectPreviewScene} so downstream helpers (bond-pair
 * translation, thumb baker) can consume either projection style
 * without branching.
 *
 * **Why separate from the orthographic `projectPreviewScene`:**
 * the orthographic projection is load-bearing for the 1200×630 OG
 * poster — every atom renders at one uniform radius there so the
 * poster pane reads as a "structural diagram". The account-row
 * thumb wants depth cues at 96 px where it helps the eye separate
 * near/far atoms. This helper lets the two surfaces pick the math
 * they want from the same 3D scene without the poster inheriting
 * thumb-specific perspective.
 *
 * Math — mirrors `renderPerspectiveSketch` in
 * `capsule-preview-sketch-perspective.ts`:
 *
 *   1. Rotate atoms into camera space with the canonical PCA basis.
 *   2. Compute `z_max` (nearest), `z_min` (farthest), `S = z_max − z_min`.
 *   3. `D = K · S`; for every atom `s(z) = D / (D + z_max − z)`.
 *   4. Pre-fit screen coords `x′ = x · s(z)`, `y′ = y · s(z)`.
 *   5. Compute 2D bounds of pre-fit coords and fit-to-bounds into
 *      the padded target (same formula as `projectPreviewScene`).
 *   6. Per-atom radius: `r = base_r · s(z)`. Near atoms larger, far
 *      atoms smaller — depth cue is encoded in the stored r.
 *
 * Degenerate-depth handling: when the rotated z-span collapses to
 * zero (planar subject viewed face-on), `s(z) ≡ 1` uniformly and
 * the output is identical to the orthographic path. No divide-by-
 * zero risk; no caller branching needed.
 */
export function projectPreviewScenePerspective(
  scene: CapsulePreviewScene3D,
  opts: ProjectSceneOptions & {
    cameraDistanceFactor?: number;
    /** Override the base atom radius (at `s=1`, the near-face
     *  depth). Default is the same density-aware formula the
     *  orthographic path uses (`availDim · 0.035`). Callers who
     *  want chunkier atoms (e.g. the account thumb at 96 px)
     *  double this; callers who want the poster-style thinness
     *  leave it alone. Passed-in value is in PIXEL units,
     *  measured before normalization to storage. */
    baseAtomRadius?: number;
  } = {},
): CapsulePreviewRenderScene {
  const {
    targetWidth,
    targetHeight,
    padding,
    minRadius,
    maxRadius,
  } = { ...DEFAULT_OPTIONS, ...opts };
  const K = opts.cameraDistanceFactor ?? PERSPECTIVE_K_DEFAULT;
  // MUST match the camera that `renderPerspectiveSketch` uses on
  // the audit page — otherwise per-atom depths diverge, the
  // baked-thumb perspective stops agreeing with the live
  // experimental preview, and the "byte-equivalent to the audit-
  // page math" contract is broken. Both surfaces now import
  // `deriveMinorAxisCamera` from `capsule-preview-camera.ts`
  // (canonical PCA basis WITHOUT the 5°/10° cosmetic tilt the
  // orthographic path applies).
  const camera = opts.camera ?? deriveMinorAxisCamera(scene);
  const [cx, cy, cz] = scene.bounds.center;

  // 1) Rotate into camera space.
  const rotated: Array<{
    atomId: number;
    x: number;
    y: number;
    z: number;
    colorHex: string;
  }> = [];
  for (const atom of scene.atoms) {
    const p: [number, number, number] = [atom.x - cx, atom.y - cy, atom.z - cz];
    const r = applyRotation(camera.rotation3x3, p);
    rotated.push({ atomId: atom.atomId, x: r[0], y: r[1], z: r[2], colorHex: atom.colorHex });
  }

  // 2) Depth bounds + focal distance.
  let zMin = Infinity, zMax = -Infinity;
  for (const a of rotated) {
    if (a.z < zMin) zMin = a.z;
    if (a.z > zMax) zMax = a.z;
  }
  const zSpan = Math.max(1e-9, zMax - zMin);
  const D = K * zSpan;
  const perspScale = (z: number): number => D / (D + (zMax - z));

  // 3) Apply perspective pre-fit.
  interface Persp { atomId: number; x: number; y: number; z: number; colorHex: string; s: number }
  const persp: Persp[] = rotated.map((a) => {
    const s = perspScale(a.z);
    return { ...a, x: a.x * s, y: a.y * s, s };
  });

  // 4) Fit post-perspective 2D bounds into the padded target.
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const a of persp) {
    if (a.x < minX) minX = a.x;
    if (a.y < minY) minY = a.y;
    if (a.x > maxX) maxX = a.x;
    if (a.y > maxY) maxY = a.y;
  }
  // Degenerate-span guard. The `Math.max(1e-9, ...)` floor that
  // used to live here was a division-by-zero guard, not a
  // degeneracy guard — at `spanX = 0, span=1e-9`, `fit = availW /
  // 1e-9 ≈ 5e11`. Every atom then lands at ±Infinity, quietly
  // propagating NaN into the stored thumb (audit finding: SFH #3).
  // If either 2D span is below a real-world-meaningful threshold
  // (atoms truly coincident in the projected plane), throw an
  // explicit error so the publish-core catch can log and fall back.
  const rawSpanX = maxX - minX;
  const rawSpanY = maxY - minY;
  const DEGENERATE_2D_SPAN_THRESHOLD = 1e-6;
  if (rawSpanX < DEGENERATE_2D_SPAN_THRESHOLD && rawSpanY < DEGENERATE_2D_SPAN_THRESHOLD) {
    throw new Error(
      `projectPreviewScenePerspective: degenerate 2D projection — spanX=${rawSpanX}, spanY=${rawSpanY}`,
    );
  }
  const spanX = Math.max(DEGENERATE_2D_SPAN_THRESHOLD, rawSpanX);
  const spanY = Math.max(DEGENERATE_2D_SPAN_THRESHOLD, rawSpanY);
  const availW = targetWidth * (1 - 2 * padding);
  const availH = targetHeight * (1 - 2 * padding);
  const fit = Math.min(availW / spanX, availH / spanY);
  const midX = (minX + maxX) / 2;
  const midY = (minY + maxY) / 2;

  // 5) Base atom radius — same formula as projectPreviewScene,
  // unless the caller override is set. The per-atom scale `s`
  // then modulates it so near atoms render larger than far atoms.
  const baseR = opts.baseAtomRadius ?? Math.min(
    maxRadius,
    Math.max(minRadius, Math.min(availW, availH) * 0.035),
  );

  const atoms: CapsulePreviewAtom2D[] = persp.map((a) => ({
    atomId: a.atomId,
    x: targetWidth / 2 + (a.x - midX) * fit,
    y: targetHeight / 2 + (a.y - midY) * fit,
    r: baseR * a.s,  // ← per-atom perspective-scaled radius
    colorHex: a.colorHex,
    depth: a.z,
  }));

  // Sort by depth so nearer atoms draw last (same convention as the
  // orthographic path).
  atoms.sort((p, q) => p.depth - q.depth);

  return {
    atoms,
    bounds: { width: targetWidth, height: targetHeight },
    classification: camera.classification,
  };
}

/**
 * Derive bond-pair indices from a projected render scene using a simple
 * distance cutoff. Used at publish time so the poster pane can render
 * bonds without re-evaluating the bond policy per request.
 *
 * The cutoff is in the scene's original (world) units — we reuse the
 * 3D distances from the unrotated scene because rotation preserves
 * distance but our render atoms carry pixel-space `x`/`y` after scaling.
 *
 * Caller is responsible for any bond-cap trimming; this function returns
 * every pair under the cutoff, deterministically ordered.
 */
export function deriveBondPairs(
  scene: CapsulePreviewScene3D,
  cutoff: number,
  minDist: number,
): Array<{ a: number; b: number }> {
  if (!Number.isFinite(cutoff) || cutoff <= 0) return [];
  const out: Array<{ a: number; b: number; d: number }> = [];
  const atoms = scene.atoms;
  const cutSq = cutoff * cutoff;
  const minSq = Math.max(0, minDist) * Math.max(0, minDist);
  for (let i = 0; i < atoms.length; i++) {
    const pa = atoms[i];
    for (let j = i + 1; j < atoms.length; j++) {
      const pb = atoms[j];
      const dx = pa.x - pb.x;
      const dy = pa.y - pb.y;
      const dz = pa.z - pb.z;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 <= cutSq && d2 >= minSq) out.push({ a: i, b: j, d: d2 });
    }
  }
  // Sort by distance so trimming at the cap keeps the shortest bonds.
  out.sort((p, q) => p.d - q.d);
  return out.map(({ a, b }) => ({ a, b }));
}

/**
 * Translate raw bond pairs (indexed into `scene3D.atoms`) into
 * projected-atom-index space, with each kept bond annotated by its
 * midpoint depth.
 *
 * **Why this helper exists.** `projectPreviewScene` sorts its output
 * atoms by depth (near last). `deriveBondPairs` returns `{a, b}`
 * indices into the PRE-SORT `scene3D.atoms` array. Callers that pass
 * those indices straight into the projected scene draw ghost edges
 * between atoms whose depth sort reshuffled them. The consistent
 * reconciliation is an `atomId → projectedIndex` map — implemented
 * here once so the audit + production render paths don't each
 * re-invent it (or skip it). Depth policy: midpoint of the two
 * endpoints' post-projection `depth`; documented so downstream back-
 * to-front draw order is stable.
 *
 * Endpoints that didn't survive sampling (e.g. `publish-core`'s
 * silhouette pre-sample) are silently dropped — not an error.
 *
 * Pure; no side effects.
 */
export function deriveBondPairsForProjectedScene(
  scene3D: CapsulePreviewScene3D,
  projected: CapsulePreviewRenderScene,
  cutoff: number,
  minDist: number,
  opts?: { precomputedRawPairs?: ReadonlyArray<{ a: number; b: number }> },
): Array<{ a: number; b: number; depth: number }> {
  const rawPairs = opts?.precomputedRawPairs
    ? opts.precomputedRawPairs.slice()
    : deriveBondPairs(scene3D, cutoff, minDist);
  if (rawPairs.length === 0) return [];
  // scene3D.atoms indices are the basis of rawPairs; map each pre-sort
  // atomId to its post-sort index in `projected.atoms`.
  const atomIdToProjectedIndex = new Map<number, number>();
  for (let i = 0; i < projected.atoms.length; i++) {
    atomIdToProjectedIndex.set(projected.atoms[i].atomId, i);
  }
  const out: Array<{ a: number; b: number; depth: number }> = [];
  for (const pair of rawPairs) {
    const srcA = scene3D.atoms[pair.a];
    const srcB = scene3D.atoms[pair.b];
    if (!srcA || !srcB) continue;
    const ia = atomIdToProjectedIndex.get(srcA.atomId);
    const ib = atomIdToProjectedIndex.get(srcB.atomId);
    if (ia == null || ib == null) continue;
    if (ia === ib) continue;
    const depth = (projected.atoms[ia].depth + projected.atoms[ib].depth) / 2;
    out.push({ a: ia, b: ib, depth });
  }
  return out;
}
