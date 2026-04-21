/**
 * V2 dynamic OG-poster composition — watermark-and-molecule design.
 *
 * ## Design direction (rev 14 redesign)
 *
 * Prior revisions split the 1200×630 into two regions: a small
 * brand mark top-left + the molecule centered-right. That preserved
 * the wordmark's legibility but shrank the molecule and created
 * dead space. The new design goes the opposite way:
 *
 *   - **"Atom Dojo" sits AS the background** — one large, light-
 *     gray wordmark filling most of the poster width, set in a
 *     generous sans-serif weight. It reads as a watermark/carpet:
 *     brand presence without visual competition with the figure.
 *   - **Molecule paints OVER the watermark** — fills the entire
 *     1200×630 canvas; viewBox auto-sizes to the atom bounding
 *     box so wide structures get horizontal room and compact ones
 *     center cleanly. No cropping.
 *   - **Lab-matched background** — `#f2f2f0` (the Lab light theme
 *     `--color-bg`) so the poster surface reads as the same
 *     workspace users click through to.
 *
 * The molecule is the focal element; "Atom Dojo" is the quiet
 * ambient label. Nothing else competes for attention — no title,
 * no subtitle, no share-code footer.
 *
 * Satori constraints observed: `display: flex | none` only; no
 * `font-variant-numeric`; no `-webkit-box`. The SVG uses attribute-
 * style props for Satori's SVG pass-through.
 */

import { ImageResponse } from '@cloudflare/pages-plugin-vercel-og/api';
import type { ReactElement } from 'react';
import type { PreviewSceneV1 } from '../../src/share/capsule-preview-scene-store';
import type { PosterRenderMeta } from '../api/capsules/[code]/preview/poster';
import { INTER_REGULAR_TTF } from './fonts/inter-regular';
import { CurrentPosterSceneSvg } from '../../src/share/capsule-preview-current-poster';

const W = 1200;
const H = 630;

export const POSTER_WIDTH = W;
export const POSTER_HEIGHT = H;

/**
 * Compose the dynamic poster as an {@link ImageResponse}.
 * Returns 1200×630 PNG; consumer (poster route) handles caching.
 *
 * `meta` is received for call-site compatibility with the poster
 * route but the new design intentionally surfaces none of it — the
 * visual identity is "watermark + hero molecule".
 */
export function renderCapsulePosterImage(
  scene: PreviewSceneV1,
  meta: PosterRenderMeta,
): Response {
  // Match Lab `--color-bg` light-theme so the poster reads as the
  // same workspace surface users click through to.
  const bg = '#f2f2f0';
  // Very light gray for the watermark. Close enough to the bg that
  // it reads as texture, not a second focal element.
  const watermarkInk = '#e3e1dc';

  void meta;

  const tree: ReactElement = (
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        background: bg,
        fontFamily: 'Inter, system-ui, sans-serif',
        position: 'relative',
      }}
    >
      {/* Watermark — large, centered, behind the molecule. One
          word per line so the letterforms stay chunky and legible
          even at this low-contrast tone. `lineHeight: 0.9` tightens
          the stack; `letterSpacing: -8` gives the confident-display
          feel modern product posters use. */}
      <div
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          color: watermarkInk,
          fontSize: 280,
          fontWeight: 400,
          // em-units for letterSpacing — Satori handles absolute
          // pixel negative values inconsistently across font
          // loaders (reported in vercel/og). `-0.03em` at fontSize
          // 280 ≈ -8.4 px, the intended visual.
          letterSpacing: '-0.03em',
          lineHeight: 0.9,
        }}
      >
        <span style={{ display: 'flex' }}>Atom</span>
        <span style={{ display: 'flex' }}>Dojo</span>
      </div>

      {/* Molecule — fills the entire 1200×630 canvas. The SVG's
          dynamic viewBox (computed from the actual atom bounding
          box) + default `preserveAspectRatio="xMidYMid meet"` fits
          any aspect ratio without cropping. */}
      <div
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <CurrentPosterSceneSvg scene={scene} maxWidth={W} maxHeight={H} />
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
