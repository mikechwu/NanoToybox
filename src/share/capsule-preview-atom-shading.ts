/**
 * Per-atom shading palette derivation for the capsule-preview
 * renderers (poster + account thumb).
 *
 * The bonded-group color selection saved per atom in
 * `preview_scene_v1.atoms[].c` is already the user's intended albedo
 * (see `src/appearance/bonded-group-color-assignments.ts` +
 * `publish-core.ts#normalizeHex`). This module turns one hex color
 * into the 4-value palette a shaded-sphere SVG renderer needs:
 *
 *   - `mid`       — the lit albedo (gradient midpoint).
 *   - `highlight` — lighter tone for the gradient's lit pole.
 *   - `shadow`    — darker tone for the gradient's dark pole.
 *   - `stroke`    — silhouette color. Keyed off `shadow`, NOT pure
 *                   black, so a green atom gets a bright-green rim
 *                   instead of a dark-green outline — matches the
 *                   "lit sphere" look lab renders in 3D (atom material
 *                   is MeshStandardMaterial, lighting defines the rim,
 *                   there's no hard outline).
 *
 * ## HSL lift (mirrors lab)
 *
 * Lab's `_applyAtomColorOverrides` at `lab/js/renderer.ts:1026` lifts
 * the user-picked hex before using it as the instance albedo:
 *
 *   ```
 *   hsl.s = max(hsl.s, CONFIG.atomColorOverride.minSaturation)  // 0.7
 *   hsl.l = max(hsl.l, CONFIG.atomColorOverride.minLightness)   // 0.55
 *   ```
 *
 * So a moderately-dark or washed-out user pick still renders as a
 * vivid, readable atom. We mirror those floors here — duplicated
 * rather than imported so `src/share/` stays free of `lab/` imports
 * (the shared module is consumed by Pages Functions too).
 *
 * ## Fallback
 *
 * Malformed input (missing, not a hex string, not `#rrggbb` / `#rgb`)
 * returns the legacy grey palette — same four tones the renderers
 * used before per-atom color was honored, so atoms that somehow lack
 * a color attribute still render the shaded-sphere look users expect.
 *
 * Pure module; no React, no DOM.
 */

/** Must match `lab/js/config.ts:41` — `CONFIG.atomColorOverride.minSaturation`. */
export const LAB_MIN_SATURATION = 0.7;
/** Must match `lab/js/config.ts:41` — `CONFIG.atomColorOverride.minLightness`. */
export const LAB_MIN_LIGHTNESS = 0.55;

/** Lift amount applied on top of the (already lab-floored) lightness
 *  for the gradient's lit pole. Clamped to 0.95 so the highlight
 *  never blows out to pure white. */
const HIGHLIGHT_L_DELTA = 0.20;
/** Drop amount applied beneath the lifted lightness for the gradient's
 *  dark pole. Clamped to 0.18 so dense-colored atoms still resolve a
 *  rim on dark backgrounds. */
const SHADOW_L_DELTA = 0.25;
const HIGHLIGHT_L_MAX = 0.95;
const SHADOW_L_MIN = 0.18;

/** Palette handed to the renderer. Strings are `#rrggbb`. */
export interface AtomShadingPalette {
  readonly mid: string;
  readonly highlight: string;
  readonly shadow: string;
  readonly stroke: string;
}

/** Legacy grey palette — what both renderers used before per-atom
 *  color. Returned as the malformed-input fallback, so unbonded /
 *  uncolored atoms still render as a shaded-sphere gradient. */
export const GREY_FALLBACK_PALETTE: AtomShadingPalette = {
  mid: '#4a4a4a',
  highlight: '#b0b0b0',
  shadow: '#1c1c1c',
  stroke: '#000000',
};

/** Parse a `#rrggbb` or `#rgb` string to 0..1 RGB triplet. Returns
 *  null on any malformed input — caller uses the grey fallback. */
function parseHex(hex: string): { r: number; g: number; b: number } | null {
  if (typeof hex !== 'string') return null;
  const s = hex.trim().toLowerCase();
  let r = 0, g = 0, b = 0;
  if (/^#[0-9a-f]{6}$/.test(s)) {
    r = parseInt(s.slice(1, 3), 16);
    g = parseInt(s.slice(3, 5), 16);
    b = parseInt(s.slice(5, 7), 16);
  } else if (/^#[0-9a-f]{3}$/.test(s)) {
    r = parseInt(s[1] + s[1], 16);
    g = parseInt(s[2] + s[2], 16);
    b = parseInt(s[3] + s[3], 16);
  } else {
    return null;
  }
  return { r: r / 255, g: g / 255, b: b / 255 };
}

/** RGB (0..1) → HSL (h in 0..1, s/l in 0..1). Standard formula; shared
 *  with Three.js's `Color.getHSL` so lift math stays consistent with
 *  lab. */
function rgbToHsl(r: number, g: number, b: number): { h: number; s: number; l: number } {
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

/** HSL → RGB (0..1). Inverse of `rgbToHsl`. */
function hslToRgb(h: number, s: number, l: number): { r: number; g: number; b: number } {
  if (s === 0) return { r: l, g: l, b: l };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const hueToRgb = (t: number): number => {
    let v = t;
    if (v < 0) v += 1;
    if (v > 1) v -= 1;
    if (v < 1 / 6) return p + (q - p) * 6 * v;
    if (v < 1 / 2) return q;
    if (v < 2 / 3) return p + (q - p) * (2 / 3 - v) * 6;
    return p;
  };
  return {
    r: hueToRgb(h + 1 / 3),
    g: hueToRgb(h),
    b: hueToRgb(h - 1 / 3),
  };
}

function to2Hex(v: number): string {
  const n = Math.max(0, Math.min(255, Math.round(v * 255)));
  return n.toString(16).padStart(2, '0');
}

function hslHex(h: number, s: number, l: number): string {
  const { r, g, b } = hslToRgb(h, s, l);
  return `#${to2Hex(r)}${to2Hex(g)}${to2Hex(b)}`;
}

/** Warn-once set for bad hex inputs. Keyed on the raw string so the
 *  first time a novel malformed value reaches this module we surface
 *  it in the worker/browser console. A publish-pipeline regression
 *  that corrupts `a.c` for many atoms would otherwise render as a
 *  uniformly grey molecule with zero observable signal — silent
 *  degradation, per the audit finding. Dedup keeps the log quiet
 *  under normal "a few legacy rows have empty c" operation. */
const WARNED_BAD_HEX = new Set<string>();
function warnBadHexOnce(hex: unknown): void {
  const key = typeof hex === 'string' ? hex : `<${typeof hex}>`;
  if (WARNED_BAD_HEX.has(key)) return;
  WARNED_BAD_HEX.add(key);
  console.warn(
    `[atom-shading] hex-parse-failed: falling back to grey palette — input=${JSON.stringify(key)}`,
  );
}

/** Derive the 4-tone shading palette for one atom color. */
export function deriveAtomShadingPalette(hex: string): AtomShadingPalette {
  const rgb = parseHex(hex);
  if (!rgb) {
    warnBadHexOnce(hex);
    return GREY_FALLBACK_PALETTE;
  }
  const hsl = rgbToHsl(rgb.r, rgb.g, rgb.b);
  // Grey-scale input (pure black/white/grey, s === 0) lifts to a
  // vivid tone only if lab would too — but for s === 0 the lift is a
  // no-op on saturation (multiplying by hue is meaningless when there
  // isn't one). Mirror that here: only floor saturation when the input
  // has any chroma at all, otherwise pass through as a monochrome
  // palette. Guards against the fallback grey palette suddenly looking
  // different from pre-refactor output on uncolored atoms.
  const hasChroma = hsl.s > 0;
  const s = hasChroma ? Math.max(hsl.s, LAB_MIN_SATURATION) : 0;
  const lMid = Math.max(hsl.l, LAB_MIN_LIGHTNESS);
  const lHighlight = Math.min(HIGHLIGHT_L_MAX, lMid + HIGHLIGHT_L_DELTA);
  const lShadow = Math.max(SHADOW_L_MIN, lMid - SHADOW_L_DELTA);
  const shadow = hslHex(hsl.h, s, lShadow);
  return {
    mid: hslHex(hsl.h, s, lMid),
    highlight: hslHex(hsl.h, s, lHighlight),
    shadow,
    // Silhouette uses the shadow tone, not pure black — colored atoms
    // get a bright-keyed rim matching lab's lit-sphere look.
    stroke: shadow,
  };
}

/** Build a stable, URL-safe `<radialGradient>` id keyed on the atom
 *  color. Repeat colors share one gradient def per scene, so DOM
 *  cost is O(unique colors) not O(atoms).
 *
 *  Inputs that aren't a well-formed `#rrggbb` / `#rgb` (including the
 *  empty string and coincidentally-hex-char strings like `"garbage"`)
 *  collapse onto the `FALLBACK_GRADIENT_SUFFIX`, so the renderer can
 *  emit exactly one grey `<radialGradient>` def for every malformed
 *  atom. The parse gate here mirrors `deriveAtomShadingPalette`'s so
 *  the id and palette always agree on which atoms are "fallback". */
export function gradientIdForHex(prefix: string, hex: string): string {
  if (typeof hex !== 'string') return `${prefix}-${FALLBACK_GRADIENT_SUFFIX}`;
  const s = hex.trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(s)) return `${prefix}-${s.slice(1)}`;
  if (/^#[0-9a-f]{3}$/.test(s)) return `${prefix}-${s.slice(1)}`;
  return `${prefix}-${FALLBACK_GRADIENT_SUFFIX}`;
}

/** Sentinel suffix used in the gradient id when the atom's color is
 *  missing / malformed — resolves to the grey fallback gradient. */
export const FALLBACK_GRADIENT_SUFFIX = 'fallback';
