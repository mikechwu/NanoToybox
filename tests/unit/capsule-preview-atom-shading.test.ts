/**
 * Lock the HSL-lift rule + fallback behavior for the per-atom
 * shading palette used by both capsule-preview renderers.
 *
 * The live renderers (`CurrentPosterSceneSvg`, `CurrentThumbSvg`) ask
 * `deriveAtomShadingPalette` for a 4-tone palette per atom. This file
 * is the focused unit gate — full-SVG snapshots live in
 * `current-thumb-render.test.tsx`.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  deriveAtomShadingPalette,
  gradientIdForHex,
  GREY_FALLBACK_PALETTE,
  LAB_MIN_SATURATION,
  LAB_MIN_LIGHTNESS,
  FALLBACK_GRADIENT_SUFFIX,
} from '../../src/share/capsule-preview-atom-shading';

/** Hex → HSL for assertions — duplicates the renderer's formula so
 *  this test file doesn't depend on the helper's internals. */
function hexToHsl(hex: string): { h: number; s: number; l: number } {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return { h: h / 6, s, l };
}

describe('deriveAtomShadingPalette', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    // `warn-once` dedup is module-scoped — reset test output
    // between tests by silencing the spy. We assert on the
    // spy directly in the observability test below.
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('falls back to the grey palette on malformed input', () => {
    expect(deriveAtomShadingPalette('')).toEqual(GREY_FALLBACK_PALETTE);
    expect(deriveAtomShadingPalette('not-a-hex')).toEqual(GREY_FALLBACK_PALETTE);
    expect(deriveAtomShadingPalette('#ff')).toEqual(GREY_FALLBACK_PALETTE);
    // `null`/`undefined` survive `typeof !== 'string'` guard — cast
    // so the test reaches the helper with the exact malformed shape.
    expect(deriveAtomShadingPalette(null as unknown as string)).toEqual(GREY_FALLBACK_PALETTE);
  });

  it('emits a warn-once signal when a bad hex falls back to grey', () => {
    // Observability: a publish-pipeline regression that corrupts
    // stored `c` values would otherwise render as uniformly grey
    // atoms with zero operational signal. First contact with a
    // novel bad value must produce a console.warn so Sentry / log
    // scrape can catch the drift.
    const novelBad = `bogus-${Math.random().toString(36).slice(2)}`;
    deriveAtomShadingPalette(novelBad);
    expect(warnSpy).toHaveBeenCalled();
    const [msg] = warnSpy.mock.calls[0];
    expect(String(msg)).toContain('hex-parse-failed');
    expect(String(msg)).toContain(novelBad);
    // Second call with the SAME bad value must be deduped —
    // dense corruption shouldn't flood the log.
    warnSpy.mockClear();
    deriveAtomShadingPalette(novelBad);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('expands #rgb shorthand to #rrggbb before deriving', () => {
    const short = deriveAtomShadingPalette('#f55');
    const long = deriveAtomShadingPalette('#ff5555');
    expect(short).toEqual(long);
  });

  it('floors saturation + lightness on chroma inputs (matches lab)', () => {
    // A muted user pick — HSL (r=102, g=66, b=66) → low sat/lightness —
    // should lift to the lab floors before becoming the mid albedo.
    const pal = deriveAtomShadingPalette('#664242');
    const midHsl = hexToHsl(pal.mid);
    expect(midHsl.s).toBeGreaterThanOrEqual(LAB_MIN_SATURATION - 1e-6);
    expect(midHsl.l).toBeGreaterThanOrEqual(LAB_MIN_LIGHTNESS - 1e-6);
  });

  it('keeps highlight lighter than mid, shadow darker than mid', () => {
    const pal = deriveAtomShadingPalette('#33dd66'); // bonded-groups green preset
    const hi = hexToHsl(pal.highlight).l;
    const mid = hexToHsl(pal.mid).l;
    const sh = hexToHsl(pal.shadow).l;
    expect(hi).toBeGreaterThan(mid);
    expect(sh).toBeLessThan(mid);
  });

  it('keys stroke off shadow (not pure black) so colored atoms have colored rims', () => {
    const pal = deriveAtomShadingPalette('#33dd66');
    expect(pal.stroke).toBe(pal.shadow);
    // The rim is still a green — saturation preserved, not greyscale.
    expect(hexToHsl(pal.stroke).s).toBeGreaterThan(0.5);
  });

  it('passes monochrome inputs through as greyscale (no hue invention)', () => {
    const pal = deriveAtomShadingPalette('#808080');
    // Saturation must stay at 0 — lifting `S` on achromatic input
    // would invent a hue artifact. The brightness floor still
    // applies (so a near-black grey still lifts to a visible tone).
    expect(hexToHsl(pal.mid).s).toBeCloseTo(0, 5);
    expect(hexToHsl(pal.highlight).s).toBeCloseTo(0, 5);
    expect(hexToHsl(pal.shadow).s).toBeCloseTo(0, 5);
  });

  it('produces URL-safe, deterministic gradient ids', () => {
    expect(gradientIdForHex('atoms', '#ff5555')).toBe('atoms-ff5555');
    // `#rgb` → lowercase 3-char suffix (id stays short, renderer
    // emits one gradient per unique hex).
    expect(gradientIdForHex('atoms', '#F55')).toBe('atoms-f55');
    // Malformed suffix folds onto the fallback sentinel so the
    // renderer can share one grey `<radialGradient>` for any
    // unparsable atom.
    expect(gradientIdForHex('atoms', 'garbage')).toBe(`atoms-${FALLBACK_GRADIENT_SUFFIX}`);
  });
});
