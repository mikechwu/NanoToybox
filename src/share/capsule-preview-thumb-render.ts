/**
 * Shared thumbnail render constants — single source of truth for the
 * renderer in `account/main.tsx:CapsulePreviewThumb` and the visibility
 * filter + refit in `capsule-preview-scene-store.ts:derivePreviewThumbV1`.
 *
 * Why this module exists:
 *   The derivation's bond-visibility filter reasons in viewBox units
 *   (`visible = length − 2 × atomRadius`) so it must know the exact
 *   radius the renderer will apply. Keeping two independent copies of
 *   that number is a maintenance trap — changing either silently
 *   breaks the other. Importing this module at both sites makes the
 *   coupling explicit and enforces a single point of change.
 *
 * All units are the 100-unit viewBox used by the 40×40 thumbnail SVG.
 * Pure constants; no runtime logic; tree-shakes in the frontend bundle.
 */

/** Bonded-mode atom radius for n > 6 (dense bonded thumbs). Chosen so
 *  the 2 × radius occlusion leaves room for a ≥ 3-viewBox visible bond
 *  segment when bond length exceeds the visibility floor. */
export const BONDED_ATOM_RADIUS = 2.8;

/** Bonded-mode atom radius for sparser thumbs (n ≤ 6). Slightly chunkier
 *  since there are fewer dots competing with the bond strokes. */
export const BONDED_ATOM_RADIUS_LOW_N = 3.5;

/** Upper bound on the atoms-only density-aware radius floor (≤3 → 8). */
export const ATOMS_ONLY_MAX_RADIUS = 8;

/** Bonded-mode bond stroke width (n > 6). 2.5 viewBox ≈ 1 physical px on
 *  a 40×40 thumb — the visibility floor for a line on that surface. */
export const BOND_STROKE_WIDTH = 2.5;

/** Bonded-mode bond stroke width (n ≤ 6). Slightly thicker for sparser
 *  bonded scenes where each stroke carries more relative information. */
export const BOND_STROKE_WIDTH_SPARSE = 3;

/** Atom-side halo stroke width in viewBox units. Subtle light stroke so
 *  adjacent dark atoms read as separate glyphs at 40×40. */
export const ATOM_HALO_WIDTH = 0.6;

/** Resolve the bonded-mode atom radius for a given sampled-atom count.
 *  Exported so the scene-store's visibility filter uses the same
 *  resolution rule as the renderer. */
export function resolveBondedAtomRadius(n: number): number {
  return n <= 6 ? BONDED_ATOM_RADIUS_LOW_N : BONDED_ATOM_RADIUS;
}

/** Resolve the bonded-mode bond stroke width for a given sampled-atom
 *  count. Kept next to the radius resolver so the renderer can pull
 *  both values from one place. */
export function resolveBondStrokeWidth(n: number): number {
  return n <= 6 ? BOND_STROKE_WIDTH_SPARSE : BOND_STROKE_WIDTH;
}

/** Resolve the atoms-only density radius floor. Mirrored in the renderer.
 *  Monotone-decreasing in n: sparse thumbs get chunky dots, dense thumbs
 *  get smaller dots so the cluster isn't a single blob. */
export function resolveAtomsOnlyRadius(n: number): number {
  if (n <= 3) return ATOMS_ONLY_MAX_RADIUS;
  if (n <= 6) return 6.5;
  if (n <= 12) return 5;
  return 4;
}

/** Primary (strict) visibility threshold for a bond in the rendered
 *  thumb: the exposed line segment after subtracting endpoint atom
 *  radii must be at least this many viewBox units, or the bond is
 *  effectively hidden. At 40×40 physical, 1 viewBox unit = 0.4 px, so
 *  3 viewBox ≈ 1.2 px — the minimum for the eye to register a line.
 *
 *  Colocated with the radius constants so a future change to
 *  `BOND_STROKE_WIDTH` or atom radii can be reconciled against the
 *  visibility math in one place. Consumed by the derivation's
 *  visibility filter in `capsule-preview-scene-store.ts`. */
export const MIN_VISIBLE_BOND_VIEWBOX = 3;

/** Relaxed visibility threshold used as a fallback on dense scenes when
 *  the strict threshold yields too few surviving bonds. 2.0 viewBox ≈
 *  0.8 physical px at 40×40 — close to the perceptibility bound but
 *  still readable as a stroke. */
export const RELAXED_VISIBLE_BOND_VIEWBOX = 2.0;

/** Compute the glyph-aware render margin (normalized 0..1) for the
 *  bonded thumb mode, given the EXPECTED sampled-atom count. Using the
 *  actual-resolved radius (not the larger static constant) lets the
 *  refit scale the center-cloud more aggressively when typical n=12
 *  thumbs only need 2.8-viewBox atoms, freeing viewBox room for bond
 *  strokes. */
export function bondedThumbRenderMargin(sampledAtomCount: number): number {
  const atomR = resolveBondedAtomRadius(sampledAtomCount);
  // Atom halo extends half-width beyond the radius. Bond stroke adds
  // half-width perpendicular to the line — included here so the refit
  // reserves room for a bond endpoint sitting at the span extreme.
  const halo = ATOM_HALO_WIDTH / 2;
  const bondHalf = resolveBondStrokeWidth(sampledAtomCount) / 2;
  return (atomR + halo + bondHalf) / 100;
}

/** Compute the glyph-aware render margin (normalized 0..1) for the
 *  atoms-only mode, given the sampled-atom count. */
export function atomsOnlyThumbRenderMargin(sampledAtomCount: number): number {
  const atomR = resolveAtomsOnlyRadius(sampledAtomCount);
  const halo = ATOM_HALO_WIDTH / 2;
  return (atomR + halo) / 100;
}
