/**
 * Concrete contrast verification for the Watch Lab-entry funnel
 * (plan §9.1.1).
 *
 * The plan records a contrast table with `_TBD_` sentinels intended to
 * be filled in during implementation. Rather than storing those values
 * as magic numbers that can drift when tokens change, this test IS the
 * source of truth: it re-derives the resolved color for every relevant
 * surface from `lab/js/themes.ts` and asserts the WCAG contrast ratio
 * meets the target for every pair in §9.1.1.
 *
 * Any future token tweak that silently regresses contrast fails CI here
 * before it reaches the visual layer.
 *
 * WCAG 2.1 reference (1.4.3, 1.4.11):
 *   relative luminance L = 0.2126·R + 0.7152·G + 0.0722·B   (linearized sRGB)
 *   contrast ratio = (L_light + 0.05) / (L_dark + 0.05)
 *
 * Rows:
 *   1. Primary anchor ink on toolbar background               ≥ 4.5:1
 *   2. Caret button ink on toolbar background                 ≥ 4.5:1
 *   3. Caret background (open state) vs. toolbar              ≥ 3:1
 *   4. Hint body ink on hint bubble surface                   ≥ 4.5:1
 *   5. Hint left-edge accent band vs. bubble surface          ≥ 3:1
 *   6. Focus ring outline vs. surface                         ≥ 3:1
 *   7. Provenance pill ink on pill surface                    ≥ 4.5:1
 *
 * Row 8 (forced-colors `Highlight` vs `Canvas`) is OS-owned and not
 * computed here; the existing `forced-colors: active` CSS branch
 * consumes the system palette.
 */
import { describe, it, expect } from 'vitest';
import { THEMES } from '../../lab/js/themes';

/** An RGB color, each channel in [0, 255]. */
type RGB = { r: number; g: number; b: number };
/** RGBA — alpha in [0, 1]. */
type RGBA = RGB & { a: number };

function parseHex(hex: string): RGB {
  const s = hex.replace(/^#/, '');
  const full = s.length === 3
    ? s.split('').map((c) => c + c).join('')
    : s;
  const n = parseInt(full, 16);
  return { r: (n >> 16) & 0xff, g: (n >> 8) & 0xff, b: n & 0xff };
}

function parseRgba(css: string): RGBA {
  const m = css.match(/rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)/i);
  if (!m) throw new Error(`Unparseable rgba(): ${css}`);
  return {
    r: Number(m[1]),
    g: Number(m[2]),
    b: Number(m[3]),
    a: m[4] !== undefined ? Number(m[4]) : 1,
  };
}

/** Parse either #hex or rgba()/rgb() into RGBA. */
function parseColor(css: string): RGBA {
  const trimmed = css.trim();
  if (trimmed.startsWith('#')) return { ...parseHex(trimmed), a: 1 };
  return parseRgba(trimmed);
}

/** Alpha-composite a foreground over a (solid) background. */
function composite(fg: RGBA, bgSolid: RGB): RGB {
  const a = Math.max(0, Math.min(1, fg.a));
  return {
    r: fg.r * a + bgSolid.r * (1 - a),
    g: fg.g * a + bgSolid.g * (1 - a),
    b: fg.b * a + bgSolid.b * (1 - a),
  };
}

/** Linearize a single sRGB channel (0-255) to relative luminance space. */
function srgbToLinear(c255: number): number {
  const c = c255 / 255;
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function relativeLuminance(c: RGB): number {
  return (
    0.2126 * srgbToLinear(c.r) +
    0.7152 * srgbToLinear(c.g) +
    0.0722 * srgbToLinear(c.b)
  );
}

function contrastRatio(a: RGB, b: RGB): number {
  const L1 = relativeLuminance(a);
  const L2 = relativeLuminance(b);
  const [lighter, darker] = L1 > L2 ? [L1, L2] : [L2, L1];
  return (lighter + 0.05) / (darker + 0.05);
}

/** Round to 2 decimals for table reporting without lying about the measurement. */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Resolve a possibly-translucent foreground to its effective RGB when
 *  painted over a solid background. Handles hex (opaque), rgba (alpha),
 *  and rgb (opaque). */
function resolveOver(fgCss: string, bgSolid: RGB): RGB {
  const fg = parseColor(fgCss);
  if (fg.a >= 1) return { r: fg.r, g: fg.g, b: fg.b };
  return composite(fg, bgSolid);
}

/** Collect every §9.1.1 row's computed ratio so we can log a single
 *  table per run — helpful for a human eyeballing the plan update. */
interface MeasuredRow {
  pair: string;
  target: number;
  light: number;
  dark: number;
  wcag: string;
}
const measured: MeasuredRow[] = [];

function measurePair(opts: {
  pair: string;
  target: number; // minimum acceptable contrast ratio
  wcag: string;
  /** Per-theme (light + dark) inputs. The foreground and background
   *  may each be composited over a solid base (typically the page bg). */
  perTheme: (themeName: 'light' | 'dark') => { fg: string; bg: string; bgBase?: string };
}): MeasuredRow {
  const compute = (themeName: 'light' | 'dark'): number => {
    const { fg, bg, bgBase } = opts.perTheme(themeName);
    const base = bgBase !== undefined ? parseColor(bgBase) : null;
    const baseSolid = base
      ? (base.a >= 1 ? { r: base.r, g: base.g, b: base.b } : null)
      : null;
    if (base && !baseSolid) throw new Error('bgBase must be opaque');
    const bgSolid = bgBase
      ? resolveOver(bg, baseSolid!)
      : (() => { const p = parseColor(bg); if (p.a < 1) throw new Error(`bg must be opaque when no bgBase: ${bg}`); return { r: p.r, g: p.g, b: p.b }; })();
    const fgSolid = resolveOver(fg, bgSolid);
    return contrastRatio(fgSolid, bgSolid);
  };
  const row: MeasuredRow = {
    pair: opts.pair,
    target: opts.target,
    light: round2(compute('light')),
    dark: round2(compute('dark')),
    wcag: opts.wcag,
  };
  measured.push(row);
  return row;
}

describe('Lab-entry + hint + pill contrast (plan §9.1.1)', () => {
  // The toolbar / right-cluster surface in Watch is `--color-surface`,
  // which is an rgba composited over `--page-bg`. Both `.watch-lab-entry`
  // (split-button wrapper) and `.watch-lab-hint` (hint bubble) use
  // `--color-surface` as their own background, so the "toolbar
  // background" in §9.1.1 is that resolved surface.
  const t = THEMES;

  // Row 1 + 2: primary anchor ink AND caret button ink both use
  // `--color-text`; same surface (the split-button's own rgba surface
  // composited over the page bg). Same contrast.
  it('primary anchor ink on toolbar background ≥ 4.5:1 (light + dark)', () => {
    const row = measurePair({
      pair: 'Primary anchor ink on toolbar background',
      target: 4.5,
      wcag: '1.4.3 (AA)',
      perTheme: (name) => ({
        fg: t[name].uiText,
        bg: t[name].uiSurface,
        bgBase: t[name].uiPageBg,
      }),
    });
    expect(row.light).toBeGreaterThanOrEqual(row.target);
    expect(row.dark).toBeGreaterThanOrEqual(row.target);
  });

  it('caret button ink on toolbar background ≥ 4.5:1 (same surface + ink as primary)', () => {
    const row = measurePair({
      pair: 'Caret button ink on toolbar background',
      target: 4.5,
      wcag: '1.4.3 (AA)',
      perTheme: (name) => ({
        fg: t[name].uiText,
        bg: t[name].uiSurface,
        bgBase: t[name].uiPageBg,
      }),
    });
    expect(row.light).toBeGreaterThanOrEqual(row.target);
    expect(row.dark).toBeGreaterThanOrEqual(row.target);
  });

  it('caret open-state background vs. toolbar background ≥ 3:1 (non-text accent)', () => {
    // Open-state caret uses `--color-accent` (opaque). Using
    // `--color-accent-soft` drops to ~1.2:1 (fails 1.4.11), so the
    // CSS switched to the opaque accent. The toolbar surface is
    // `--color-surface` composited over the page bg.
    const row = measurePair({
      pair: 'Caret open-state background vs. toolbar background',
      target: 3,
      wcag: '1.4.11 (non-text)',
      perTheme: (name) => ({
        fg: t[name].uiAccent,
        bg: t[name].uiSurface,
        bgBase: t[name].uiPageBg,
      }),
    });
    expect(row.light).toBeGreaterThanOrEqual(row.target);
    expect(row.dark).toBeGreaterThanOrEqual(row.target);
  });

  it('hint body ink on hint bubble surface ≥ 4.5:1', () => {
    // Hint bubble uses `--color-surface` over pageBg (same rgba).
    // Ink is `--color-text`.
    const row = measurePair({
      pair: 'Hint body ink on hint bubble surface',
      target: 4.5,
      wcag: '1.4.3 (AA)',
      perTheme: (name) => ({
        fg: t[name].uiText,
        bg: t[name].uiSurface,
        bgBase: t[name].uiPageBg,
      }),
    });
    expect(row.light).toBeGreaterThanOrEqual(row.target);
    expect(row.dark).toBeGreaterThanOrEqual(row.target);
  });

  it('hint left-edge accent band vs. bubble surface ≥ 3:1 (non-text)', () => {
    // Band is `--color-accent` (opaque hex). Bubble surface is
    // `--color-surface` over pageBg.
    const row = measurePair({
      pair: 'Hint left-edge accent band vs. bubble surface',
      target: 3,
      wcag: '1.4.11',
      perTheme: (name) => ({
        fg: t[name].uiAccent,
        bg: t[name].uiSurface,
        bgBase: t[name].uiPageBg,
      }),
    });
    expect(row.light).toBeGreaterThanOrEqual(row.target);
    expect(row.dark).toBeGreaterThanOrEqual(row.target);
  });

  it('focus ring outline (--color-accent) vs. the surface behind it ≥ 3:1 (worst case = toolbar surface)', () => {
    // Focus ring on split-button is `--color-accent`. Worst-case
    // background is the same toolbar surface the primary/caret sit on.
    const row = measurePair({
      pair: 'Focus ring outline vs. surface',
      target: 3,
      wcag: '1.4.11 / 2.4.7',
      perTheme: (name) => ({
        fg: t[name].uiAccent,
        bg: t[name].uiSurface,
        bgBase: t[name].uiPageBg,
      }),
    });
    expect(row.light).toBeGreaterThanOrEqual(row.target);
    expect(row.dark).toBeGreaterThanOrEqual(row.target);
  });

  it('provenance pill ink on pill surface ≥ 4.5:1', () => {
    // Pill ink is `--color-text` (primary); pill surface is
    // `--panel-bg` composited over pageBg. Muted ink drops to ~3.9:1
    // and fails 1.4.3; primary ink clears 4.5:1 on both themes.
    const row = measurePair({
      pair: 'Provenance pill ink on pill surface',
      target: 4.5,
      wcag: '1.4.3 (AA)',
      perTheme: (name) => ({
        fg: t[name].uiText,
        bg: t[name].uiPanelBg,
        bgBase: t[name].uiPageBg,
      }),
    });
    expect(row.light).toBeGreaterThanOrEqual(row.target);
    expect(row.dark).toBeGreaterThanOrEqual(row.target);
  });

  it('reports the full §9.1.1 measured table so the plan can be kept in sync', () => {
    // Not an assertion; emitting the values lets a human reconcile
    // `.reports/2026-04-16-watch-lab-entry-and-hint-plan.md` §9.1.1
    // after any theme-token change.
    const rows = measured.map(
      (r) => `${r.pair.padEnd(58)} target≥${r.target}  light=${r.light.toFixed(2)}  dark=${r.dark.toFixed(2)}  (${r.wcag})`,
    );
    // eslint-disable-next-line no-console
    console.log('\n§9.1.1 contrast measurements:\n' + rows.join('\n'));
    expect(measured.length).toBeGreaterThan(0);
  });
});
