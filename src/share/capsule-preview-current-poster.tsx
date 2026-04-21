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
import type { PreviewSceneV1, PreviewSceneAtomV1, PreviewSceneBondV1 } from './capsule-preview-scene-store';

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
const BOND_FILL = '#ffffff';
const BOND_BORDER = '#000000';

/** Atom base radius (viewBox units) at `s=1` depth before the 0.8×
 *  hero scaling. Defined in viewBox space so the atom size is
 *  independent of the outer SVG element dimensions. */
const HERO_BASE_ATOM_RADIUS = 3.8;
const HERO_ATOM_SCALE = 0.8;

/** Bond widths at hero scale, in viewBox units. The outer SVG
 *  scales these proportionally via the viewBox → device
 *  transform, so they stay visually chunky at 1200×630 render
 *  size. */
const HERO_BOND_FILL_WIDTH = 1.5;
const HERO_BOND_BORDER_WIDTH = HERO_BOND_FILL_WIDTH + 0.6;

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
  const useThumb = !!(scene.thumb?.atoms && scene.thumb.atoms.length > 0);
  const atomsSource: ReadonlyArray<PreviewSceneAtomV1> =
    useThumb ? scene.thumb!.atoms : scene.atoms;
  const bondsSource: ReadonlyArray<PreviewSceneBondV1> =
    useThumb ? (scene.thumb!.bonds ?? []) : (scene.bonds ?? []);

  // Per-atom radius in VIEWBOX units. Storage `r` is a dimensionless
  // scale factor (already encodes perspective `s(z)`) — multiply by
  // the hero base radius + 0.8× scale. Floor at 0.6 viewBox so the
  // farthest atom never falls below ~1 device pixel when the outer
  // SVG is rendered at 600-1200 px.
  const atomRadius = (a: PreviewSceneAtomV1): number => {
    const scale = Number.isFinite(a.r) && a.r > 0 ? a.r * 100 : HERO_BASE_ATOM_RADIUS;
    return Math.max(0.6, scale * HERO_ATOM_SCALE);
  };

  // Build depth-sorted paint list.
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

  // Compute atom bounding box (+ atom-radius extent) and pad. The
  // viewBox MUST cover every painted circle so the outer SVG's
  // aspect-preserving fit shows the whole molecule — no off-canvas
  // cropping regardless of the subject's aspect ratio.
  let minAx = Infinity, maxAx = -Infinity, minAy = Infinity, maxAy = -Infinity;
  for (const a of atomsSource) {
    const r = atomRadius(a);
    const cx = a.x * 100;
    const cy = a.y * 100;
    if (cx - r < minAx) minAx = cx - r;
    if (cy - r < minAy) minAy = cy - r;
    if (cx + r > maxAx) maxAx = cx + r;
    if (cy + r > maxAy) maxAy = cy + r;
  }
  if (!Number.isFinite(minAx)) {
    // Empty scene — fall back to a sane default viewBox.
    minAx = 0; minAy = 0; maxAx = 100; maxAy = 100;
  }
  const contentW = Math.max(1, maxAx - minAx);
  const contentH = Math.max(1, maxAy - minAy);
  // 6% padding on the larger axis so glyphs don't kiss the edges.
  const pad = Math.max(contentW, contentH) * 0.06;
  const viewMinX = minAx - pad;
  const viewMinY = minAy - pad;
  const viewW = contentW + 2 * pad;
  const viewH = contentH + 2 * pad;

  // Compute the SVG's physical dimensions so its aspect ratio
  // matches the viewBox exactly — no stretching. This is the guard
  // against renderers (Satori, older browsers) that ignore
  // `preserveAspectRatio` on outer SVG and raster to the element
  // bounds verbatim. Fit the content aspect inside
  // `outerMaxW × outerMaxH` by the same "meet" algorithm the SVG
  // spec defines, but executed up-front in TS so the element
  // attributes are authoritative.
  const viewAspect = viewW / viewH;
  const maxAspect = outerMaxW / outerMaxH;
  let svgW: number;
  let svgH: number;
  if (viewAspect > maxAspect) {
    // Content wider than the bound — fit width, shrink height.
    svgW = outerMaxW;
    svgH = outerMaxW / viewAspect;
  } else {
    // Content taller/squarer than the bound — fit height, shrink
    // width. A square C60 in a 1200×630 bound lands here: svgH=630,
    // svgW=630 → rendered as a square, NOT stretched to 1200×630.
    svgH = outerMaxH;
    svgW = outerMaxH * viewAspect;
  }

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
            return (
              <g key={`b${item.i}`}>
                <line
                  x1={x1} y1={y1} x2={x2} y2={y2}
                  stroke={BOND_BORDER}
                  strokeWidth={HERO_BOND_BORDER_WIDTH}
                  strokeLinecap="round"
                />
                <line
                  x1={x1} y1={y1} x2={x2} y2={y2}
                  stroke={BOND_FILL}
                  strokeWidth={HERO_BOND_FILL_WIDTH}
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
