/**
 * Shared "current account thumb" SVG body.
 *
 * Renders the 100×100 (viewBox) account-row thumb that ships today from
 * `account/main.tsx`'s `CapsulePreviewThumb`. Extracting the subtree
 * lets the audit workbench compare its experimental thumb figure
 * against the byte-identical baseline that users actually see.
 *
 * Pure: no hooks, no side effects. The `className` and rendered size
 * are parametric so the account row and the audit page can both use
 * their own mount styling without duplicating the SVG body.
 */

import type { ReactElement } from 'react';
import type { PreviewThumbV1 } from './capsule-preview-scene-store';
import {
  ATOM_HALO_WIDTH,
  resolveAtomsOnlyRadius,
  resolveBondStrokeWidth,
  resolveBondedAtomRadius,
} from './capsule-preview-thumb-render';

/** Default rendered size for the account row. */
export const CURRENT_THUMB_DEFAULT_SIZE = 40;

/**
 * Foreground ink color the thumb's background rect resolves
 * `currentColor` against when mounted outside the account theme.
 *
 * **Contract.** This value MIRRORS the `--color-text` token in the
 * light scope of `public/account-layout.css`. The SVG itself uses
 * `fill="currentColor"` so the account row picks up the CSS token
 * naturally; callers that mount the SVG outside the account DOM —
 * e.g. the preview-audit workbench — apply this literal as their
 * ambient `color` to stay visually faithful to production.
 *
 * The relationship is enforced by
 * `tests/unit/current-thumb-ink-sync.test.ts`, which parses the CSS
 * and fails if the two values diverge. This constant is not a
 * centralized single source of truth — it is a mirror with a CI-
 * enforced contract. Update both sides together, or let the test
 * catch you.
 *
 * Scope: light theme only. Audit runs in light mode; a dark variant
 * can be added if the workbench grows one.
 */
export const CURRENT_THUMB_DEFAULT_INK = '#444444';

export interface CurrentThumbSvgProps {
  thumb: PreviewThumbV1;
  /** Rendered DOM size (width = height). Defaults to 40 to match the
   *  `.acct__upload-thumb` grid track. */
  size?: number;
  /** Optional class name — the account route needs
   *  `acct__upload-thumb`; other callers can supply their own. */
  className?: string;
}

export function CurrentThumbSvg({
  thumb,
  size = CURRENT_THUMB_DEFAULT_SIZE,
  className,
}: CurrentThumbSvgProps): ReactElement {
  const n = thumb.atoms.length;
  const hasBonds = !!(thumb.bonds && thumb.bonds.length > 0);
  const densityRadius = hasBonds
    ? resolveBondedAtomRadius(n)
    : resolveAtomsOnlyRadius(n);
  const bondWidth = resolveBondStrokeWidth(n);
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 100 100"
      role="presentation"
      aria-hidden="true"
      focusable="false"
    >
      <rect
        x={0}
        y={0}
        width={100}
        height={100}
        rx={12}
        fill="currentColor"
        fillOpacity={0.06}
      />
      {hasBonds &&
        thumb.bonds!.map((b, i) => {
          const a = thumb.atoms[b.a];
          const c = thumb.atoms[b.b];
          if (!a || !c) return null;
          return (
            <line
              key={`l${i}`}
              x1={a.x * 100}
              y1={a.y * 100}
              x2={c.x * 100}
              y2={c.y * 100}
              stroke="rgba(55,65,80,0.90)"
              strokeWidth={bondWidth}
              strokeLinecap="round"
            />
          );
        })}
      {thumb.atoms.map((a, i) => {
        // In bonded mode pin to the density radius so atom glyphs don't
        // swallow bond strokes; in atoms-only mode take the larger of
        // stored vs. density so sparse scenes get chunkier dots.
        const scaled = Number.isFinite(a.r) ? a.r * 100 : 0;
        const r = hasBonds ? densityRadius : Math.max(densityRadius, scaled);
        return (
          <circle
            key={`c${i}`}
            cx={a.x * 100}
            cy={a.y * 100}
            r={r}
            fill={a.c}
            fillOpacity={0.95}
            stroke="rgba(255,255,255,0.85)"
            strokeWidth={ATOM_HALO_WIDTH}
          />
        );
      })}
    </svg>
  );
}
