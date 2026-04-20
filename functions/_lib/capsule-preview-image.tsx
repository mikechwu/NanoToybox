/**
 * V2 dynamic OG-poster composition (spec §Poster composition).
 *
 * Pure rendering layer: takes a pre-baked {@link PreviewSceneV1} plus a
 * small metadata bundle (sanitized title, subtitle, share code) and returns
 * an `ImageResponse` from `@cloudflare/pages-plugin-vercel-og/api`.
 *
 * The Latin-only font ships at `functions/_lib/fonts/inter-regular.ttf`; the
 * sanitizer is the sole owner of non-Latin fallback so this layer never has
 * to inspect glyphs.
 *
 * Satori constraints observed throughout: `display: flex | none` only,
 * no `font-variant-numeric`, no `-webkit-box`. The SVG right-pane uses
 * attribute-style props so it survives Satori's SVG pass-through.
 */

import { ImageResponse } from '@cloudflare/pages-plugin-vercel-og/api';
import type { ReactElement } from 'react';
import type { PreviewSceneV1 } from '../../src/share/capsule-preview-scene-store';
import type { PosterRenderMeta } from '../api/capsules/[code]/preview/poster';
import { INTER_REGULAR_TTF } from './fonts/inter-regular';

const W = 1200;
const H = 630;

export const POSTER_WIDTH = W;
export const POSTER_HEIGHT = H;

// Right-pane SVG dimensions. Tuned so the scene has clear margin inside the
// poster's padded layout without ballooning the atom radii.
const PANE_W = 600;
const PANE_H = 500;

function SceneSvg({ scene }: { scene: PreviewSceneV1 }): ReactElement {
  // Scene atoms are stored in normalized 0..1 coordinates, so we multiply
  // by the pane dimensions at render time.
  const atoms = scene.atoms;
  const bonds = scene.bonds ?? [];
  const atomR = Math.max(8, Math.min(20, Math.min(PANE_W, PANE_H) * 0.04));
  return (
    <svg
      width={PANE_W}
      height={PANE_H}
      viewBox={`0 0 ${PANE_W} ${PANE_H}`}
      xmlns="http://www.w3.org/2000/svg"
    >
      <defs>
        <radialGradient id="bg" cx="50%" cy="50%" r="60%">
          <stop offset="0%" stopColor="#f59e0b" stopOpacity="0.14" />
          <stop offset="100%" stopColor="#f59e0b" stopOpacity="0" />
        </radialGradient>
      </defs>
      <rect width={PANE_W} height={PANE_H} fill="url(#bg)" />
      {bonds.map((b, i) => {
        const a = atoms[b.a];
        const c = atoms[b.b];
        if (!a || !c) return null;
        return (
          <line
            key={`b${i}`}
            x1={a.x * PANE_W}
            y1={a.y * PANE_H}
            x2={c.x * PANE_W}
            y2={c.y * PANE_H}
            stroke="#9aa0a6"
            strokeWidth={3}
            strokeOpacity={0.55}
          />
        );
      })}
      {atoms.map((a, i) => {
        // Guarded radius: atoms with stored r === 0 or NaN get the
        // pane-derived default instead of collapsing to a 0-radius circle
        // (which would render as nothing after the stroke clip). Avoids
        // `||` short-circuiting because `0` is a valid falsy-but-meaningless
        // case for radius.
        const scaled = a.r * Math.min(PANE_W, PANE_H);
        const r = Number.isFinite(scaled) && scaled > 0
          ? Math.max(6, scaled)
          : atomR;
        return (
          <circle
            key={`a${i}`}
            cx={a.x * PANE_W}
            cy={a.y * PANE_H}
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

/**
 * Compose the dynamic poster as an {@link ImageResponse}.
 * Returns 1200×630 PNG; consumer (poster route) handles caching headers.
 */
export function renderCapsulePosterImage(
  scene: PreviewSceneV1,
  meta: PosterRenderMeta,
): Response {
  const bg = '#ffffff';
  const ink = '#0f1115';
  const muted = '#5b6471';
  const brandAccent = '#f59e0b';

  const tree: ReactElement = (
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'row',
        background: bg,
        color: ink,
        fontFamily: 'Inter, system-ui, sans-serif',
        padding: '60px',
        boxSizing: 'border-box',
      }}
    >
      <div
        style={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          paddingRight: '40px',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center' }}>
          <div
            style={{
              width: 18,
              height: 18,
              borderRadius: 4,
              background: brandAccent,
              marginRight: 14,
            }}
          />
          <div style={{ fontSize: 28, fontWeight: 400, letterSpacing: -0.5 }}>
            Atom Dojo
          </div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          <div
            style={{
              fontSize: 64,
              fontWeight: 400,
              lineHeight: 1.05,
              letterSpacing: -1.2,
              color: ink,
              maxWidth: 520,
              // Satori only allows display: flex | none, so the 2-line clamp
              // is enforced upstream by the sanitizer's 60-char truncation
              // (src/share/capsule-preview.ts).
              display: 'flex',
              overflow: 'hidden',
            }}
          >
            {meta.sanitizedTitle}
          </div>
          <div
            style={{
              marginTop: 22,
              fontSize: 26,
              color: muted,
              lineHeight: 1.3,
            }}
          >
            {meta.subtitle}
          </div>
        </div>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            fontSize: 22,
            color: muted,
            letterSpacing: 1.5,
          }}
        >
          {/* Satori does not implement font-variant-numeric; rely on the
              already-uniform-width hex/upper alphanumerics of the share
              code instead of asking for tabular figures. */}
          <span>{meta.shareCode}</span>
        </div>
      </div>
      <div
        style={{
          width: PANE_W,
          height: PANE_H,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <SceneSvg scene={scene} />
      </div>
    </div>
  );

  return new ImageResponse(tree, {
    width: W,
    height: H,
    fonts: [
      {
        name: 'Inter',
        data: INTER_REGULAR_TTF,
        weight: 400,
        style: 'normal',
      },
    ],
  });
}
