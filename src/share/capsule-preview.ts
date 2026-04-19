/**
 * Shared capsule-preview descriptor + title sanitizer (spec §1, §3).
 *
 * Owns the deterministic, presentation-ready preview descriptor used by both
 * the account uploads thumbnail and the OG poster route, the title sanitizer
 * (the sole owner of non-Latin fallback in V1 — see BUNDLED_FONT_SUPPORTED_RANGES),
 * and the TEMPLATE_VERSION cache-key constant.
 *
 * Pure module: no React, no JSX, no Cloudflare APIs. Safe to import from
 * Pages Functions, Workers, account/main.tsx, and unit tests.
 */

import { titleHitsDenylist } from './capsule-preview-denylist';

/** Bumped manually when the static-figure design changes; busts dynamic-poster cache only. */
export const TEMPLATE_VERSION = 1 as const;

/** Title fallback used everywhere — must match brand canonical name. */
export const CAPSULE_TITLE_FALLBACK = 'Atom Dojo Capsule';

/**
 * Code-point ranges supported by the V1 bundled font.
 * If ANY code point of a sanitized title falls outside these ranges, the
 * sanitizer returns the fallback. The poster route assumes its input is
 * safe to glyph-shape with the bundled Latin font and does NOT re-inspect.
 *
 * Deviation from spec §3 (intentional, documented): the spec lists only
 * curly quotes and ellipsis from the U+2010 block. We widened to
 * [0x2010, 0x2027] so common Latin punctuation (en/em dash, hyphens, low
 * lines) and the joiner pair [0x200C, 0x200D] also pass. The bundled
 * Latin font covers all of these, so this avoids a UX regression where
 * titles like "café — naïve façade" or "Crystallographer's lab" would
 * otherwise hit the fallback. If a future font swap drops these glyphs,
 * narrow the range and the existing tests will catch it.
 */
export const BUNDLED_FONT_SUPPORTED_RANGES: ReadonlyArray<[number, number]> = [
  [0x0020, 0x007e], // Basic Latin (printable ASCII)
  [0x00a0, 0x00ff], // Latin-1 Supplement
  [0x0100, 0x017f], // Latin Extended-A
  [0x0180, 0x024f], // Latin Extended-B
  [0x200c, 0x200d], // ZWNJ / ZWJ (sanitizer may emit ZWJ; keep allowed)
  [0x2010, 0x2027], // General punctuation: hyphens, dashes, quotes, ellipsis, …
];

const KNOWN_MOLECULAR_KINDS: ReadonlySet<string> = new Set([
  'md',
  'md-capsule',
  'structure',
  'full',
  'capsule',
]);

const FIGURE_VARIANTS: ReadonlyArray<string> = [
  'lattice-hex',
  'lattice-cubic',
  'cluster-orbital',
  'chain-helix',
  'ring-fused',
];

const ACCENT_PALETTE: ReadonlyArray<string> = [
  '#f59e0b', // amber
  '#22d3ee', // cyan
  '#a78bfa', // violet
  '#f472b6', // pink
  '#34d399', // emerald
  '#fb7185', // rose
];

export type CapsulePreviewMode = 'static-figure' | 'stored-poster';

export interface CapsulePreviewInput {
  shareCode: string;
  title: string | null;
  kind: string;
  atomCount: number;
  frameCount: number;
  sizeBytes?: number | null;
  createdAt?: string | null;
}

export interface CapsulePreviewDescriptor {
  mode: CapsulePreviewMode;
  /** Always sanitizer output — safe to render as glyphs. */
  title: string;
  subtitle: string;
  shareCode: string;
  /** Presentation-only; never part of the identity seed. */
  themeVariant: 'light' | 'dark';
  accentColor: string;
  figureVariant: string;
  density: 'low' | 'medium' | 'high';
}

export interface BuildPreviewOptions {
  mode?: CapsulePreviewMode;
  themeVariant?: 'light' | 'dark';
}

// ── Title sanitizer ────────────────────────────────────────────────────────

const CONTROL_RE = /[\u0000-\u001f\u007f]/g;
const BIDI_RE = /[\u202a-\u202e\u2066-\u2069]/g;
const ZWJ_RUN_RE = /\u200d{2,}/g;

function isInBundledRanges(codePoint: number): boolean {
  for (const [lo, hi] of BUNDLED_FONT_SUPPORTED_RANGES) {
    if (codePoint >= lo && codePoint <= hi) return true;
  }
  return false;
}

function allCodePointsSupported(s: string): boolean {
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    if (cp == null || !isInBundledRanges(cp)) return false;
  }
  return true;
}

function sliceCodePoints(s: string, max: number): string {
  // Slice by code points, not UTF-16 units, so we don't bisect a surrogate pair.
  let count = 0;
  let out = '';
  for (const ch of s) {
    if (count >= max) break;
    out += ch;
    count += 1;
  }
  return out;
}

function countCodePoints(s: string): number {
  let n = 0;
  for (const _ of s) n += 1;
  return n;
}

/**
 * Sanitize a user-controlled capsule title for safe rendering into a poster
 * image and alt text. See spec §3 for the algorithm.
 *
 * Always returns a non-empty string; falls back to {@link CAPSULE_TITLE_FALLBACK}
 * for any title that is missing, hostile, denylisted, or contains glyphs the
 * bundled V1 font cannot render.
 */
export function sanitizeCapsuleTitle(raw: string | null | undefined): string {
  if (raw == null) return CAPSULE_TITLE_FALLBACK;
  let s = String(raw);
  // 0. Defensive upstream cap. The eventual NFC truncation is 60 code
  //    points (step 8), but some steps below walk every code point of
  //    the input; clip to a generous 4 KB so a schema anomaly (e.g. a
  //    multi-MB title row) cannot stall the route.
  if (s.length > 4096) s = s.slice(0, 4096);
  // 1. Empty / whitespace-only → fallback
  if (!s.trim()) return CAPSULE_TITLE_FALLBACK;
  // 2. NFC normalize
  s = s.normalize('NFC');
  // 3. Strip control chars
  s = s.replace(CONTROL_RE, '');
  // 4. Strip bidi overrides
  s = s.replace(BIDI_RE, '');
  // 5. Collapse ZWJ runs (≥2) to a single joiner
  s = s.replace(ZWJ_RUN_RE, '\u200d');
  // 6. Collapse internal whitespace
  s = s.replace(/\s+/g, ' ').trim();
  if (!s) return CAPSULE_TITLE_FALLBACK;
  // 7. Denylist substring check (NFC-normalized, case-insensitive in helper)
  if (titleHitsDenylist(s)) return CAPSULE_TITLE_FALLBACK;
  // 8. Hard-truncate to 60 NFC code points with trailing U+2026 ellipsis
  if (countCodePoints(s) > 60) {
    s = sliceCodePoints(s, 59) + '\u2026';
  }
  // 9. Required non-Latin fallback — the single ownership boundary for V1
  if (!allCodePointsSupported(s)) return CAPSULE_TITLE_FALLBACK;
  // 10. Final safety
  if (!s) return CAPSULE_TITLE_FALLBACK;
  return s;
}

// ── Deterministic hashing (FNV-1a 32-bit on UTF-16 code units) ────────────

/** Single source of truth for FNV-1a 32-bit hashing across the share/
 *  module boundary. Exported so the figure module and the cache-key
 *  helpers cannot drift. */
export function fnv1a32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Deterministic 8-char lowercase hex hash — used for cache-key versioning. */
export function fnv1a32Hex(s: string): string {
  return fnv1a32(s).toString(16).padStart(8, '0');
}

/** Deterministic 32-bit hash of the share code, namespaced so the same
 *  share code can't collide with hashes of arbitrary other strings. */
function shareCodeSeed(shareCode: string): number {
  return fnv1a32(`atomdojo|capsule|${shareCode}`);
}

function pickFigureVariant(seed: number, kind: string): string {
  if (!KNOWN_MOLECULAR_KINDS.has(kind)) return 'neutral-brand';
  return FIGURE_VARIANTS[seed % FIGURE_VARIANTS.length];
}

function pickAccentColor(seed: number): string {
  return ACCENT_PALETTE[(seed >>> 8) % ACCENT_PALETTE.length];
}

function densityBucket(atomCount: number): 'low' | 'medium' | 'high' {
  if (atomCount <= 32) return 'low';
  if (atomCount <= 256) return 'medium';
  return 'high';
}

function formatSubtitle(input: CapsulePreviewInput): string {
  const parts: string[] = [];
  if (Number.isFinite(input.atomCount) && input.atomCount > 0) {
    parts.push(`${input.atomCount} atoms`);
  }
  if (Number.isFinite(input.frameCount) && input.frameCount > 0) {
    parts.push(`${input.frameCount} frames`);
  }
  if (parts.length === 0) {
    return 'Interactive molecular dynamics scene';
  }
  return parts.join(' · ');
}

/**
 * Build a deterministic preview descriptor.
 *
 * Identity is a pure function of `shareCode` + `kind`. Title, theme, dates and
 * sizes affect ONLY presentation fields (`title`, `subtitle`, `themeVariant`),
 * never `figureVariant` / `accentColor` / `density` / geometry. See spec §1.
 */
export function buildCapsulePreviewDescriptor(
  input: CapsulePreviewInput,
  options: BuildPreviewOptions = {},
): CapsulePreviewDescriptor {
  const seed = shareCodeSeed(input.shareCode);
  const figureVariant = pickFigureVariant(seed, input.kind);
  const accentColor = figureVariant === 'neutral-brand'
    ? '#f59e0b'
    : pickAccentColor(seed);
  return {
    mode: options.mode ?? 'static-figure',
    title: sanitizeCapsuleTitle(input.title),
    subtitle: formatSubtitle(input),
    shareCode: input.shareCode,
    themeVariant: options.themeVariant ?? 'light',
    accentColor,
    figureVariant,
    density: densityBucket(input.atomCount ?? 0),
  };
}
