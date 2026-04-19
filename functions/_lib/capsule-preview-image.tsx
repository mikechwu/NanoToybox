/**
 * V1 dynamic OG-poster composition (spec §6).
 *
 * Pure rendering layer: takes a {@link CapsulePreviewDescriptor} (already
 * sanitized by `src/share/capsule-preview.ts`) and returns an `ImageResponse`
 * from `@cloudflare/pages-plugin-vercel-og/api`.
 *
 * The Latin-only font ships at `functions/_lib/fonts/inter-regular.ttf`; the
 * sanitizer is the sole owner of non-Latin fallback so this layer never has to
 * inspect glyphs.
 */

import { ImageResponse } from '@cloudflare/pages-plugin-vercel-og/api';
import type { ReactElement } from 'react';
import type { CapsulePreviewDescriptor } from '../../src/share/capsule-preview';
import {
  buildFigureGraph,
  type FigureGraph,
} from '../../src/share/capsule-preview-figure';
import { INTER_REGULAR_TTF } from './fonts/inter-regular';

const W = 1200;
const H = 630;

export const POSTER_WIDTH = W;
export const POSTER_HEIGHT = H;

function FigureSvg({ graph }: { graph: FigureGraph }): ReactElement {
  // Render the geometry into a 600×500 inline SVG occupying the right pane.
  const VW = 600;
  const VH = 500;
  return (
    <svg
      width={VW}
      height={VH}
      viewBox={`0 0 ${VW} ${VH}`}
      xmlns="http://www.w3.org/2000/svg"
    >
      <defs>
        <radialGradient id="bg" cx="50%" cy="50%" r="60%">
          <stop offset="0%" stopColor={graph.accentColor} stopOpacity="0.18" />
          <stop offset="100%" stopColor={graph.accentColor} stopOpacity="0" />
        </radialGradient>
      </defs>
      <rect width={VW} height={VH} fill="url(#bg)" />
      {graph.links.map((l) => {
        const a = graph.nodes.find((n) => n.id === l.from);
        const b = graph.nodes.find((n) => n.id === l.to);
        if (!a || !b) return null;
        return (
          <line
            key={l.id}
            x1={a.x * VW}
            y1={a.y * VH}
            x2={b.x * VW}
            y2={b.y * VH}
            stroke="#9aa0a6"
            strokeWidth={2}
            strokeOpacity={0.45}
          />
        );
      })}
      {graph.nodes.map((n) => (
        <circle
          key={n.id}
          cx={n.x * VW}
          cy={n.y * VH}
          r={n.r * Math.min(VW, VH)}
          fill={graph.accentColor}
          stroke="#0f1115"
          strokeWidth={1.5}
        />
      ))}
    </svg>
  );
}

/**
 * Compose the dynamic poster as an {@link ImageResponse}.
 * Returns 1200×630 PNG; consumer (poster route) handles caching headers.
 */
export function renderCapsulePosterImage(
  descriptor: CapsulePreviewDescriptor,
): Response {
  const graph = buildFigureGraph(descriptor);
  // Theme is pinned to light at the poster route (spec §11). Defensive — if a
  // caller passes 'dark' here we still render the light variant.
  const bg = '#ffffff';
  const ink = '#0f1115';
  const muted = '#5b6471';

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
              background: descriptor.accentColor,
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
              // (src/share/capsule-preview.ts). overflow: hidden + flex
              // wrapping prevents any unexpected overflow at very large
              // glyph widths.
              display: 'flex',
              overflow: 'hidden',
            }}
          >
            {descriptor.title}
          </div>
          <div
            style={{
              marginTop: 22,
              fontSize: 26,
              color: muted,
              lineHeight: 1.3,
            }}
          >
            {descriptor.subtitle}
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
          <span>{descriptor.shareCode}</span>
        </div>
      </div>
      <div
        style={{
          width: 600,
          height: 500,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <FigureSvg graph={graph} />
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
