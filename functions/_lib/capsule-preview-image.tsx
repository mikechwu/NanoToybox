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
import {
  CURRENT_POSTER_PANE_WIDTH,
  CURRENT_POSTER_PANE_HEIGHT,
  CurrentPosterSceneSvg,
} from '../../src/share/capsule-preview-current-poster';

const W = 1200;
const H = 630;

export const POSTER_WIDTH = W;
export const POSTER_HEIGHT = H;

// Right-pane SVG dimensions. Tuned so the scene has clear margin inside the
// poster's padded layout without ballooning the atom radii. Sourced from
// the shared `capsule-preview-current-poster` module so the audit
// workbench renders against the exact same baseline.
const PANE_W = CURRENT_POSTER_PANE_WIDTH;
const PANE_H = CURRENT_POSTER_PANE_HEIGHT;

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
        <CurrentPosterSceneSvg scene={scene} />
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
