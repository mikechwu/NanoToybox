/**
 * Shared "current poster scene" SVG body.
 *
 * Renders the hero molecule pane that ships inside the dynamic OG
 * `ImageResponse`. Historically this subtree lived inline in
 * `functions/_lib/capsule-preview-image.tsx`; extracting it lets the
 * poster route and the audit workbench render byte-identical output.
 *
 * ## Design direction
 *
 * - **EXPERIMENTAL visual grammar** — shaded-sphere atoms with
 *   radial gradient fill, black-outlined white bonds. Matches the
 *   account-row thumb so the poster and the list preview read as
 *   the same "brand object".
 *
 * - **Reads `preview_scene_v1.thumb`** — the perspective bake
 *   (uncapped, publish-time pinhole at K=1.5). The poster pane is
 *   600 × 600 so all bonds visible at the hero scale survive from
 *   the bake (the bake no longer drops short bonds for thumb
 *   legibility; see `publish-core.ts` rev 14).
 *
 * - **Dynamic viewBox** — the SVG's viewBox is computed from the
 *   actual atom bounding box (with padding), NOT hard-coded to
 *   [0..100, 0..100]. Previously a wide planar subject like BNR
 *   (atom x range [-0.89, 1.89] after the aspect-preserving fill-
 *   shorter refit) clipped heavily against a fixed 100×100
 *   viewBox, even though the poster canvas had plenty of unused
 *   space. The dynamic viewBox resizes to include every atom;
 *   SVG's default `preserveAspectRatio="xMidYMid meet"` then fits
 *   the content into the outer element size, preserving aspect
 *   and centering. Wide molecules get horizontal room; compact
 *   ones fill vertically. No visual cropping.
 *
 * - **Depth-sorted paint order** — atoms and bonds interleave by
 *   depth rank, matching the audit-page `renderPerspectiveSketch`.
 *   Bonds anchor to their FAR endpoint's rank (with a −0.5
 *   offset) so atoms nearer than the bond's far endpoint correctly
 *   paint over the bond at 2D crossings.
 *
 * Satori constraints observed: no advanced CSS, attribute-style
 * SVG props. Pure; no DOM, no hooks.
 */

import type { ReactElement } from 'react';
import {
  CURRENT_THUMB_REV,
  type PreviewSceneV1,
  type PreviewSceneAtomV1,
  type PreviewSceneBondV1,
} from './capsule-preview-scene-store';
import {
  K_ATOM,
  K_BOND_FILL,
  K_BOND_BORDER_DELTA,
  BOND_CYL_EDGE,
  BOND_CYL_BODY,
  BOND_CYL_HIGHLIGHT,
  BOND_CYL_EDGE_MULT,
  BOND_CYL_BODY_MULT,
  BOND_CYL_HIGHLIGHT_MULT,
  medianBondLengthVb,
  medianNearestNeighborVb,
  medianStoredR,
  perspectiveMultiplier,
} from './capsule-preview-bond-scale';

/** Default output dimensions. The SVG element itself takes these
 *  unless a caller overrides `width` / `height` to fit a larger
 *  canvas (e.g. the 1200×630 poster card). */
export const CURRENT_POSTER_PANE_WIDTH = 600;
export const CURRENT_POSTER_PANE_HEIGHT = 600;
export const CURRENT_POSTER_GRADIENT_ID = 'cur-poster-bg';
export const CURRENT_POSTER_ATOM_GRADIENT_ID = 'cur-poster-atom';

/** EXPERIMENTAL shaded-sphere palette — matches the account thumb. */
const ATOM_HIGHLIGHT = '#b0b0b0';
const ATOM_FILL_MID = '#4a4a4a';
const ATOM_SHADOW = '#1c1c1c';
const ATOM_STROKE = '#000000';

/** Safety bounds — kept tiny/huge per user spec ("min 1e-5, max
 *  very large"). They exist only to neutralize pathological inputs
 *  (NaN positions, zero-extent content) that would otherwise
 *  produce NaN or Infinity attribute values on the rendered SVG.
 *  Sizing math + palette + helpers come from
 *  `./capsule-preview-bond-scale` — single source of truth shared
 *  with `./capsule-preview-current-thumb`. */
const MIN_ATOM_RADIUS_VB = 1e-5;
const MAX_ATOM_RADIUS_VB = 1e6;

export interface CurrentPosterSceneSvgProps {
  scene: PreviewSceneV1;
  /** Maximum width the SVG is allowed to occupy in the outer
   *  canvas. The component computes an actual `width` attribute
   *  that matches the content's aspect ratio (≤ this max), so the
   *  rasterizer never stretches content to fill a mismatched outer
   *  box (Satori was doing this with the previous
   *  width/height-passthrough API — a square C60 in a 99×99
   *  viewBox was stretched to the 1200×630 element, squashed
   *  horizontally into a fat ellipse). Defaults to the legacy
   *  600 px for any caller that still passes `width`/`height`
   *  directly. */
  maxWidth?: number;
  /** Maximum height the SVG is allowed to occupy in the outer
   *  canvas. Pair with {@link maxWidth}. */
  maxHeight?: number;
  /** Legacy direct-size props — kept for back-compat with the audit
   *  page fixture callers. When only one is supplied the component
   *  treats it as both max bounds. */
  width?: number;
  height?: number;
  gradientId?: string;
  atomGradientId?: string;
}

type PaintItem =
  | { kind: 'atom'; rank: number; atom: PreviewSceneAtomV1; i: number; r: number }
  | { kind: 'bond'; rank: number; bond: PreviewSceneBondV1; i: number };

export function CurrentPosterSceneSvg({
  scene,
  maxWidth,
  maxHeight,
  width,
  height,
  gradientId = CURRENT_POSTER_GRADIENT_ID,
  atomGradientId = CURRENT_POSTER_ATOM_GRADIENT_ID,
}: CurrentPosterSceneSvgProps): ReactElement {
  // Resolve the outer bounding box. `maxWidth`/`maxHeight` are the
  // new API; `width`/`height` are the legacy direct-size props.
  // Defensive floors — a caller that passes 0, a negative number,
  // or a non-finite value would otherwise produce a zero-/NaN-
  // dimension SVG that Satori silently rasterizes as a blank tile.
  const rawMaxW = maxWidth ?? width ?? CURRENT_POSTER_PANE_WIDTH;
  const rawMaxH = maxHeight ?? height ?? CURRENT_POSTER_PANE_HEIGHT;
  const outerMaxW = Number.isFinite(rawMaxW) && rawMaxW > 0
    ? rawMaxW
    : CURRENT_POSTER_PANE_WIDTH;
  const outerMaxH = Number.isFinite(rawMaxH) && rawMaxH > 0
    ? rawMaxH
    : CURRENT_POSTER_PANE_HEIGHT;
  // Single-sourced atoms + bonds pick. Bond endpoints (a, b) are
  // INDICES into the accompanying atoms array; if atoms come from
  // thumb but bonds come from scene, those indices reference the
  // 32-atom downsampled poster scene while atomsSource is the full
  // thumb — nonsense bonds get drawn (or silently dropped when the
  // poster index happens to exceed the thumb atom length). Lock
  // both to the same source. (Audit finding #1, rev 16.)
  // Trust the stored thumb only when it's AT the current rev AND
  // carries bonds. A stale or bondless thumb would otherwise
  // produce a blank poster in bonds-only render mode (a legacy row
  // might have atoms but no bond list because the old bake's
  // visibility filter dropped everything for dense 3D clusters).
  // In those cases fall through to the 32-atom `scene.atoms` +
  // `scene.bonds` poster scene — same fallback the profile thumb's
  // `derivePreviewThumbV1` uses on stale rows, so the two surfaces
  // stay in sync until the backfill catches up.
  const thumbIsFresh = !!(
    scene.thumb
    && scene.thumb.rev >= CURRENT_THUMB_REV
    && scene.thumb.atoms.length > 0
    && scene.thumb.bonds
    && scene.thumb.bonds.length > 0
  );
  const atomsSource: ReadonlyArray<PreviewSceneAtomV1> =
    thumbIsFresh ? scene.thumb!.atoms : scene.atoms;
  const bondsSource: ReadonlyArray<PreviewSceneBondV1> =
    thumbIsFresh ? scene.thumb!.bonds! : (scene.bonds ?? []);

  // ── Phase 1: atom-position bounds (no radius yet) ──
  let minAx = Infinity, maxAx = -Infinity, minAy = Infinity, maxAy = -Infinity;
  for (const a of atomsSource) {
    const cx = a.x * 100;
    const cy = a.y * 100;
    if (cx < minAx) minAx = cx;
    if (cy < minAy) minAy = cy;
    if (cx > maxAx) maxAx = cx;
    if (cy > maxAy) maxAy = cy;
  }
  if (!Number.isFinite(minAx)) {
    // Empty scene — fall back to a sane default viewBox.
    minAx = 0; minAy = 0; maxAx = 100; maxAy = 100;
  }
  const contentW = Math.max(1, maxAx - minAx);
  const contentH = Math.max(1, maxAy - minAy);

  // ── Phase 2: base atom radius from projected bond length ──
  // The projected bond length in viewBox units is the inferred
  // "physical scale" of the scene — short for dense clusters (more
  // atoms in same viewBox), long for sparse. Atoms and bond widths
  // both scale proportionally: `k · bondVb`.
  const bondVb = medianBondLengthVb(atomsSource, bondsSource)
    || medianNearestNeighborVb(atomsSource);
  const candidateAtomBase = K_ATOM * bondVb;

  // ── Phase 3: viewBox bounds (content + radius + pad) ──
  // Pad the content box by the atom radius so circles aren't
  // clipped at the viewBox edge, plus a 6% visual breathing room.
  const radiusPad = candidateAtomBase * 1.1;
  const visualPad = Math.max(contentW, contentH) * 0.06;
  const pad = Math.max(radiusPad, visualPad);
  const viewMinX = minAx - pad;
  const viewMinY = minAy - pad;
  const viewW = contentW + 2 * pad;
  const viewH = contentH + 2 * pad;

  // ── Phase 4: SVG physical dims (guards Satori stretching) ──
  const viewAspect = viewW / viewH;
  const maxAspect = outerMaxW / outerMaxH;
  let svgW: number;
  let svgH: number;
  if (viewAspect > maxAspect) {
    svgW = outerMaxW;
    svgH = outerMaxW / viewAspect;
  } else {
    svgH = outerMaxH;
    svgW = outerMaxH * viewAspect;
  }

  // ── Phase 5: safety-clamped atom base ──
  // Only tiny/huge guards against pathological inputs (NaN
  // positions, zero-extent content). No density-aware floor, no
  // pixel-aware floor — per the spec, only cluster height drives
  // size, and the math already yields well-scaled glyphs.
  const atomBase = Math.min(
    MAX_ATOM_RADIUS_VB,
    Math.max(MIN_ATOM_RADIUS_VB, candidateAtomBase),
  );

  // ── Phase 6: per-atom perspective cue (relative only) ──
  // Stored `a.r` carries the publish-time `s(z)` perspective
  // scaling. `perspectiveMultiplier` turns it into a ±15% relative
  // multiplier around the median — depth cue preserved, absolute
  // size still controlled by `atomBase`.
  const rMedian = medianStoredR(atomsSource);
  const atomRadius = (a: PreviewSceneAtomV1): number =>
    atomBase * perspectiveMultiplier(a.r, rMedian);

  // Bond cylinder width — the widest stroke (edge layer) uses this
  // directly; the body + highlight layers are fixed fractions of
  // it. Proportional to projected bond length so the atom:bond
  // visual weight stays constant across subjects.
  const bondBorderWidth = (K_BOND_FILL + K_BOND_BORDER_DELTA) * bondVb;

  // Build depth-sorted paint list. (Rank formula unchanged.)
  const items: PaintItem[] = [];
  atomsSource.forEach((atom, i) => {
    items.push({ kind: 'atom', rank: i, atom, i, r: atomRadius(atom) });
  });
  bondsSource.forEach((bond, i) => {
    const a = atomsSource[bond.a];
    const b = atomsSource[bond.b];
    if (!a || !b) return;
    // Far-endpoint rank, -0.5 tiebreaker — atoms nearer than the
    // far endpoint correctly paint over the bond.
    items.push({ kind: 'bond', rank: Math.min(bond.a, bond.b) - 0.5, bond, i });
  });
  // Secondary tie-break on insertion index (snapshot determinism
  // across JS engines even though ES2019+ mandates stable sort).
  items.sort((p, q) => (p.rank - q.rank) || (p.i - q.i));

  return (
    <svg
      width={svgW}
      height={svgH}
      viewBox={`${viewMinX} ${viewMinY} ${viewW} ${viewH}`}
      preserveAspectRatio="xMidYMid meet"
      xmlns="http://www.w3.org/2000/svg"
    >
      <defs>
        {/* Transparent backdrop so the outer poster canvas bg
            shows through. The old amber vignette is removed. */}
        <radialGradient id={gradientId} cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="#ffffff" stopOpacity="0" />
          <stop offset="100%" stopColor="#ffffff" stopOpacity="0" />
        </radialGradient>
        <radialGradient
          id={atomGradientId}
          cx="50%"
          cy="50%"
          r="50%"
          fx="30%"
          fy="30%"
        >
          <stop offset="0%" stopColor={ATOM_HIGHLIGHT} />
          <stop offset="55%" stopColor={ATOM_FILL_MID} />
          <stop offset="100%" stopColor={ATOM_SHADOW} />
        </radialGradient>
      </defs>
      <rect
        x={viewMinX}
        y={viewMinY}
        width={viewW}
        height={viewH}
        fill={`url(#${gradientId})`}
      />
      {items.map((item) => {
        switch (item.kind) {
          case 'atom': {
            const cx = item.atom.x * 100;
            const cy = item.atom.y * 100;
            const strokeW = Math.max(0.15, item.r * 0.07);
            return (
              <circle
                key={`a${item.i}`}
                cx={cx}
                cy={cy}
                r={item.r}
                fill={`url(#${atomGradientId})`}
                stroke={ATOM_STROKE}
                strokeWidth={strokeW}
              />
            );
          }
          case 'bond': {
            const a = atomsSource[item.bond.a];
            const b = atomsSource[item.bond.b];
            const x1 = a.x * 100;
            const y1 = a.y * 100;
            const x2 = b.x * 100;
            const y2 = b.y * 100;
            // Three-stroke cylinder illusion: edge (shadow) →
            // body (ambient) → highlight (specular), all in light
            // gray. The widest stroke defines the cylinder
            // silhouette; the narrow highlight suggests the lit
            // strip across its top. Mirrors the atom's radial-
            // gradient shading approach — atom = sphere gradient,
            // bond = cylinder stroke stack.
            return (
              <g key={`b${item.i}`}>
                <line
                  x1={x1} y1={y1} x2={x2} y2={y2}
                  stroke={BOND_CYL_EDGE}
                  strokeWidth={bondBorderWidth * BOND_CYL_EDGE_MULT}
                  strokeLinecap="round"
                />
                <line
                  x1={x1} y1={y1} x2={x2} y2={y2}
                  stroke={BOND_CYL_BODY}
                  strokeWidth={bondBorderWidth * BOND_CYL_BODY_MULT}
                  strokeLinecap="round"
                />
                <line
                  x1={x1} y1={y1} x2={x2} y2={y2}
                  stroke={BOND_CYL_HIGHLIGHT}
                  strokeWidth={bondBorderWidth * BOND_CYL_HIGHLIGHT_MULT}
                  strokeLinecap="round"
                />
              </g>
            );
          }
          default: {
            const _exhaustive: never = item;
            return _exhaustive;
          }
        }
      })}
    </svg>
  );
}
