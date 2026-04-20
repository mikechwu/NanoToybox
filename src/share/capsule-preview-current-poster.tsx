/**
 * Shared "current poster scene" SVG body.
 *
 * Renders the 600×500 poster pane that today ships inside the dynamic
 * OG ImageResponse. Historically this subtree lived inline in
 * `functions/_lib/capsule-preview-image.tsx`; the audit page had a
 * hand-copied reimplementation that drifted from production. Extracting
 * the subtree lets the poster route and the audit workbench render the
 * byte-identical baseline.
 *
 * Pure: no DOM, no hooks, no side effects. Satori-compatible.
 */

import type { ReactElement } from 'react';
import type { PreviewSceneV1 } from './capsule-preview-scene-store';

/** Design tokens for the current poster pane. Consumers must not tweak
 *  these — the whole point of the shared module is that poster + audit
 *  produce the same pixels. */
export const CURRENT_POSTER_PANE_WIDTH = 600;
export const CURRENT_POSTER_PANE_HEIGHT = 500;
/** Gradient id — exported so any caller that renders more than one
 *  poster pane on the same page can namespace it if needed. */
export const CURRENT_POSTER_GRADIENT_ID = 'cur-poster-bg';

export interface CurrentPosterSceneSvgProps {
  scene: PreviewSceneV1;
  /** Optional rendered dimensions; `viewBox` is pinned to the pane so
   *  the audit page can shrink the surface without reflowing. */
  width?: number;
  height?: number;
  /** Override gradient id when the same DOM mounts multiple panes. */
  gradientId?: string;
}

export function CurrentPosterSceneSvg({
  scene,
  width = CURRENT_POSTER_PANE_WIDTH,
  height = CURRENT_POSTER_PANE_HEIGHT,
  gradientId = CURRENT_POSTER_GRADIENT_ID,
}: CurrentPosterSceneSvgProps): ReactElement {
  const atoms = scene.atoms;
  const bonds = scene.bonds ?? [];
  const atomR = Math.max(
    8,
    Math.min(20, Math.min(CURRENT_POSTER_PANE_WIDTH, CURRENT_POSTER_PANE_HEIGHT) * 0.04),
  );
  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${CURRENT_POSTER_PANE_WIDTH} ${CURRENT_POSTER_PANE_HEIGHT}`}
      xmlns="http://www.w3.org/2000/svg"
    >
      <defs>
        <radialGradient id={gradientId} cx="50%" cy="50%" r="60%">
          <stop offset="0%" stopColor="#f59e0b" stopOpacity="0.14" />
          <stop offset="100%" stopColor="#f59e0b" stopOpacity="0" />
        </radialGradient>
      </defs>
      <rect
        width={CURRENT_POSTER_PANE_WIDTH}
        height={CURRENT_POSTER_PANE_HEIGHT}
        fill={`url(#${gradientId})`}
      />
      {bonds.map((b, i) => {
        const a = atoms[b.a];
        const c = atoms[b.b];
        if (!a || !c) return null;
        return (
          <line
            key={`b${i}`}
            x1={a.x * CURRENT_POSTER_PANE_WIDTH}
            y1={a.y * CURRENT_POSTER_PANE_HEIGHT}
            x2={c.x * CURRENT_POSTER_PANE_WIDTH}
            y2={c.y * CURRENT_POSTER_PANE_HEIGHT}
            stroke="#9aa0a6"
            strokeWidth={3}
            strokeOpacity={0.55}
          />
        );
      })}
      {atoms.map((a, i) => {
        // Guarded radius: atoms with r === 0 or NaN fall back to the
        // pane-derived default. Can't use `||` because 0 is a valid
        // falsy-but-meaningless radius.
        const scaled = a.r * Math.min(CURRENT_POSTER_PANE_WIDTH, CURRENT_POSTER_PANE_HEIGHT);
        const r = Number.isFinite(scaled) && scaled > 0 ? Math.max(6, scaled) : atomR;
        return (
          <circle
            key={`a${i}`}
            cx={a.x * CURRENT_POSTER_PANE_WIDTH}
            cy={a.y * CURRENT_POSTER_PANE_HEIGHT}
            r={r}
            fill={a.c}
            stroke="#0f1115"
            strokeWidth={1.5}
          />
        );
      })}
    </svg>
  );
}
