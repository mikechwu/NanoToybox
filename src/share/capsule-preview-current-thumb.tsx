/**
 * Shared "current account thumb" SVG body — pinhole-perspective
 * shaded-sphere renderer.
 *
 * Renders the account-row thumb. Extracting the subtree lets the
 * audit workbench compare its experimental thumb figure against the
 * byte-identical baseline that users actually see.
 *
 * ## Visual grammar
 *
 *   - **Atoms:** individual `<circle>` elements filled from a shared
 *     radial gradient (highlight / midtone / rim-shadow) so each
 *     atom reads as a shaded sphere. Black outline. Mirrors the
 *     audit-page EXPERIMENTAL preset's atom styling (see
 *     `capsule-preview-sketch-perspective.ts#SHARED_PRESENTATION`
 *     and `ATOM_3D_GRADIENT`).
 *   - **Bonds:** each bond is TWO stacked `<line>` elements — a
 *     wider black border underneath, a narrower white fill on top.
 *
 * ## Depth-correct paint order (critical)
 *
 *   The previous implementation emitted all bonds, then all atoms.
 *   That painted EVERY atom over EVERY bond — a far atom whose 2D
 *   position overlapped a bond belonging to nearer atoms would
 *   wrongly cover that bond. The audit-page `renderPerspectiveSketch`
 *   avoids this by collecting atoms AND bonds into one paint list,
 *   sorting by depth, and emitting in sorted order. This module
 *   mirrors that approach:
 *
 *     1. Build a unified `items[]` containing atom records (one per
 *        atom) and bond records (one per bond, with its two stacked
 *        line segments).
 *     2. Each item carries a depth-rank: atom rank = its index in
 *        `thumb.atoms` (already stored far-to-near), bond rank =
 *        the midpoint of its two endpoint indices.
 *     3. Sort ascending. Emit in order.
 *
 *   Ties: atom ranks are integers, bond ranks are half-integers. A
 *   bond between atom 2 and atom 3 gets rank 2.5 — paints AFTER
 *   atom 2 and BEFORE atom 3, which is the physically-correct
 *   painter's order.
 *
 *   Per-atom stored `r` encodes perspective (`r = base_r · s(z)`),
 *   so sorting by `thumb.atoms` index is equivalent to sorting by
 *   z — atoms are baked far-to-near.
 *
 * ## Per-atom radius (perspective-bake aware)
 *
 *   Stored `r` carries the perspective scaling. The renderer honors
 *   it in both bonded and atoms-only modes. `densityRadius` is a
 *   floor (`densityRadius · PERSPECTIVE_RADIUS_FLOOR_FACTOR`) so a
 *   far-side atom never degenerates below the visibility threshold.
 *
 * `data-atom-count` / `data-bond-count` / `data-atom-radius` on the
 * root SVG expose pipeline state to tests. Atom circles carry
 * `data-role="atom"`; bond lines carry `data-role="bond-border"` /
 * `"bond-fill"`.
 *
 * Pure: no hooks, no side effects.
 */

import type { ReactElement } from 'react';
import type { PreviewThumbV1, PreviewSceneAtomV1, PreviewSceneBondV1 } from './capsule-preview-scene-store';
import {
  resolveAtomsOnlyRadius,
  resolveBondedAtomRadius,
  PERSPECTIVE_RADIUS_FLOOR_FACTOR,
} from './capsule-preview-thumb-render';
import { ACCOUNT_THUMB_SIZE } from './capsule-preview-thumb-size';
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

/** Default rendered size for the account row. */
export const CURRENT_THUMB_DEFAULT_SIZE = ACCOUNT_THUMB_SIZE;

/** Foreground ink the thumb's background rect resolves `currentColor`
 *  against when mounted outside the account theme. Mirrors
 *  `--color-text` in `public/account-layout.css` (light scope). */
export const CURRENT_THUMB_DEFAULT_INK = '#444444';

/** Quantization scale for effective atom radius. 1/100 viewBox grid. */
export const ATOM_RADIUS_SCALE = 100;

function quantizeRadius(r: number): number {
  if (!Number.isFinite(r)) return 0;
  return Math.round(r * ATOM_RADIUS_SCALE) / ATOM_RADIUS_SCALE;
}

/** Style preset for the thumb. Mirrors the audit-page EXPERIMENTAL
 *  preset (`SHARED_PRESENTATION` / `ATOM_3D_GRADIENT` in
 *  `capsule-preview-sketch-perspective.ts`). */
export interface CurrentThumbStylePreset {
  readonly atomFillMid: string;
  readonly atomHighlight: string;
  readonly atomShadow: string;
  readonly atomStroke: string;
  readonly atomStrokeRatio: number;
  readonly bondBorderDelta: number;
  readonly bondFillStroke: string;
  readonly bondBorderStroke: string;
}

export const THUMB_STYLE_MINIMAL: CurrentThumbStylePreset = {
  atomFillMid: '#4a4a4a',
  atomHighlight: '#b0b0b0',
  atomShadow: '#1c1c1c',
  atomStroke: '#000000',
  atomStrokeRatio: 0.07,
  bondBorderDelta: 0.8,
  bondFillStroke: '#ffffff',
  bondBorderStroke: '#000000',
};

export const THUMB_STYLE_HALOED: CurrentThumbStylePreset = {
  ...THUMB_STYLE_MINIMAL,
  atomStroke: 'rgba(255,255,255,0.92)',
  atomStrokeRatio: 0.07,
};

/** Legacy alias. */
export const CURRENT_THUMB_STYLE = THUMB_STYLE_MINIMAL;

export interface CurrentThumbSvgProps {
  thumb: PreviewThumbV1;
  size?: number;
  className?: string;
  style?: CurrentThumbStylePreset;
  gradientId?: string;
}

/** Resolve the per-atom rendered radius under the shared
 *  bond-length-proportional rule.
 *
 *  Absolute size is `atomBaseVb = K_ATOM · bondLengthVb`. Stored
 *  `a.r` is used ONLY as a ±15% relative multiplier (perspective
 *  cue: near atoms slightly larger, far atoms slightly smaller).
 *  It is NOT treated as an absolute radius — doing so used to
 *  render large clusters like C720 with 4× oversized atoms on
 *  the thumb, because publish-time `a.r` comes from a fixed
 *  `baseRadius = 22 / 500 · s(z)` that doesn't shrink as the
 *  cluster's real extent grows.
 *
 *  `atomBaseVb === 0` only when the scene has no bond signal AND
 *  fewer than 2 atoms — in that degenerate case we fall back to
 *  the density-aware `densityRadius` so atoms-only thumbs still
 *  render something visible and the derivation visibility-filter
 *  math stays pinned to a concrete radius. */
function effectiveAtomRadius(
  atom: PreviewSceneAtomV1,
  atomBaseVb: number,
  rMedian: number,
  densityRadius: number,
): number {
  if (atomBaseVb > 0) {
    return quantizeRadius(atomBaseVb * perspectiveMultiplier(atom.r, rMedian));
  }
  return quantizeRadius(densityRadius);
}

/** Build a collision-safe gradient ID. A module-level counter
 *  resets on HMR reload while the DOM still holds the previous
 *  `<defs>` — same id resolves to the stale sibling's gradient
 *  (`url(#…)` picks the first match in document order). A random
 *  suffix sidesteps that race entirely. Mirrors the pattern used
 *  by `capsule-preview-sketch-perspective.ts#makeGradientId()`. */
function nextGradientId(): string {
  const g: { crypto?: { randomUUID?: () => string } } =
    typeof globalThis !== 'undefined' ? (globalThis as never) : {};
  const randomPart =
    g.crypto && typeof g.crypto.randomUUID === 'function'
      ? g.crypto.randomUUID().slice(0, 8)
      : Math.random().toString(36).slice(2, 10);
  return `acct-thumb-atom-grad-${randomPart}`;
}

/** Paint-order item — either an atom or a bond. Ranked by depth so
 *  atoms and bonds interleave correctly. See the file-level JSDoc
 *  "Depth-correct paint order" section. */
type PaintItem =
  | { kind: 'atom'; rank: number; atom: PreviewSceneAtomV1; r: number; i: number }
  | { kind: 'bond'; rank: number; bond: PreviewSceneBondV1; i: number };

export function CurrentThumbSvg({
  thumb,
  size = CURRENT_THUMB_DEFAULT_SIZE,
  className,
  style = THUMB_STYLE_MINIMAL,
  gradientId,
}: CurrentThumbSvgProps): ReactElement {
  const n = thumb.atoms.length;
  const bondsArr = thumb.bonds ?? [];
  const hasBonds = bondsArr.length > 0;
  // Shared physical-scale sizing rule — every absolute width/radius
  // is a fixed fraction of the projected bond length (the scene's
  // physical-scale proxy). Constants + helpers come from
  // `capsule-preview-bond-scale` so thumb and poster render at
  // identical scale without drift.
  const bondLengthVb = hasBonds
    ? medianBondLengthVb(thumb.atoms, bondsArr)
    : medianNearestNeighborVb(thumb.atoms);
  // Density radius retained only for the atoms-only degenerate
  // fallback (`effectiveAtomRadius` when bondLengthVb = 0 and the
  // derivation-filter coupling via `PERSPECTIVE_RADIUS_FLOOR_FACTOR`
  // elsewhere in the module). Primary signal is `K_ATOM · bondVb`.
  const densityRadius = hasBonds
    ? resolveBondedAtomRadius(n)
    : resolveAtomsOnlyRadius(n);
  const atomBaseVb = K_ATOM * bondLengthVb;
  const rMedian = medianStoredR(thumb.atoms);
  const bondBorderWidth = (K_BOND_FILL + K_BOND_BORDER_DELTA) * bondLengthVb;
  const validBondCount = bondsArr.filter((b) => thumb.atoms[b.a] && thumb.atoms[b.b]).length;
  const gradId = gradientId ?? nextGradientId();

  // Build the depth-sorted paint list. Mirrors the audit-page
  // `renderPerspectiveSketch` rank scheme verbatim so the two
  // surfaces produce identical paint order:
  //
  //   - Atom rank = index in `thumb.atoms` (stored far-to-near).
  //   - Bond rank = min(bond.a, bond.b) − 0.5. The FAR endpoint's
  //     rank is `min(a, b)` because atoms are sorted depth-
  //     ascending. The `− 0.5` offset puts the bond just BEFORE
  //     its far endpoint atom in the sort, so the atom paints on
  //     top of the bond's tail (correct 3D occlusion).
  //
  // The midpoint rank the previous revision used let atoms nearer
  // than the bond's midpoint paint BEFORE the bond, then the bond
  // painted over them — the "bond blocks atom" artifact the user
  // saw on dense scenes. Anchoring to the far endpoint means every
  // atom nearer than the far endpoint paints AFTER the bond (wins
  // occlusion), and every atom farther than the far endpoint
  // paints BEFORE the bond (loses occlusion). Both cases match
  // real 3D geometry.
  const items: PaintItem[] = [];
  thumb.atoms.forEach((atom, i) => {
    items.push({
      kind: 'atom',
      rank: i,
      atom,
      r: effectiveAtomRadius(atom, atomBaseVb, rMedian, densityRadius),
      i,
    });
  });
  bondsArr.forEach((bond, i) => {
    const a = thumb.atoms[bond.a];
    const b = thumb.atoms[bond.b];
    if (!a || !b) return;
    items.push({
      kind: 'bond',
      rank: Math.min(bond.a, bond.b) - 0.5,
      bond,
      i,
    });
  });
  // Secondary tie-break on insertion index — guards against engines
  // without a stable sort (ES2019+ spec mandates stable; older
  // Safari / stale wrangler runtimes aren't in scope here, but the
  // extra key costs nothing and locks snapshot-test determinism).
  items.sort((p, q) => (p.rank - q.rank) || (p.i - q.i));

  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 100 100"
      style={{ overflow: 'hidden' }}
      role="presentation"
      aria-hidden="true"
      focusable="false"
      data-atom-count={n}
      data-bond-count={validBondCount}
      data-atom-radius={quantizeRadius(densityRadius)}
    >
      <defs>
        <radialGradient
          id={gradId}
          cx="50%"
          cy="50%"
          r="50%"
          fx="30%"
          fy="30%"
        >
          <stop offset="0%" stopColor={style.atomHighlight} />
          <stop offset="55%" stopColor={style.atomFillMid} />
          <stop offset="100%" stopColor={style.atomShadow} />
        </radialGradient>
      </defs>
      <rect
        x={0}
        y={0}
        width={100}
        height={100}
        rx={12}
        fill="currentColor"
        fillOpacity={0.06}
      />
      {items.map((item) => {
        switch (item.kind) {
          case 'atom': {
            const strokeW = Math.max(0.25, item.r * style.atomStrokeRatio);
            return (
              <circle
                key={`a-${item.i}`}
                data-role="atom"
                data-atom-r={item.r}
                cx={item.atom.x * 100}
                cy={item.atom.y * 100}
                r={item.r}
                fill={`url(#${gradId})`}
                stroke={style.atomStroke}
                strokeWidth={strokeW}
              />
            );
          }
          case 'bond': {
            const a = thumb.atoms[item.bond.a];
            const b = thumb.atoms[item.bond.b];
            const x1 = a.x * 100, y1 = a.y * 100;
            const x2 = b.x * 100, y2 = b.y * 100;
            // Three-stroke cylinder — edge (shadow) → body
            // (ambient) → highlight (spec). Mirrors poster's
            // bond rendering exactly so the two surfaces stay
            // visually consistent. Style preset's bond colors are
            // overridden here with the cylinder palette.
            return (
              <g key={`b-${item.i}`} data-role="bond-pair">
                <line
                  data-role="bond-edge"
                  x1={x1} y1={y1} x2={x2} y2={y2}
                  stroke={BOND_CYL_EDGE}
                  strokeWidth={bondBorderWidth * BOND_CYL_EDGE_MULT}
                  strokeLinecap="round"
                />
                <line
                  data-role="bond-body"
                  x1={x1} y1={y1} x2={x2} y2={y2}
                  stroke={BOND_CYL_BODY}
                  strokeWidth={bondBorderWidth * BOND_CYL_BODY_MULT}
                  strokeLinecap="round"
                />
                <line
                  data-role="bond-highlight"
                  x1={x1} y1={y1} x2={x2} y2={y2}
                  stroke={BOND_CYL_HIGHLIGHT}
                  strokeWidth={bondBorderWidth * BOND_CYL_HIGHLIGHT_MULT}
                  strokeLinecap="round"
                />
              </g>
            );
          }
          default: {
            // Exhaustiveness guard — adding a future PaintItem
            // variant without a render branch here becomes a
            // compile error.
            const _exhaustive: never = item;
            return _exhaustive;
          }
        }
      })}
    </svg>
  );
}
