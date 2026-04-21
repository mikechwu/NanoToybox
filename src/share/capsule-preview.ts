/**
 * Shared capsule-preview utilities (spec §3).
 *
 * V2 scope: the title sanitizer (sole owner of the non-Latin fallback
 * boundary — see BUNDLED_FONT_SUPPORTED_RANGES), the TEMPLATE_VERSION
 * cache-key constant, and the FNV-1a32 hash helpers used by the scene-
 * store and the dynamic-poster ETag.
 *
 * V1 descriptor/figure types (`CapsulePreviewDescriptor`, `CapsulePreviewMode`,
 * `buildCapsulePreviewDescriptor`, seed/variant helpers) retired in V2 —
 * see `src/share/capsule-preview-frame.ts` + `capsule-preview-project.ts`
 * for the frame-projection pipeline that replaced them.
 *
 * Pure module: no React, no JSX, no Cloudflare APIs. Safe to import from
 * Pages Functions, Workers, account/main.tsx, and unit tests.
 */

import { titleHitsDenylist } from './capsule-preview-denylist';

/** Cache-key + ETag version; bumps every time the rendered poster output
 *  meaningfully changes.
 *
 *  History:
 *    2 — V2 launch (frame-projected scenes, D135).
 *    3 — 2026-04-21 (follow-up 3). Poster renderer retargeted from
 *        the perspective thumb bake back to the `scene.atoms` /
 *        `scene.bonds` path (see `CurrentPosterSceneSvg` and
 *        `SCENE_ATOM_CAP = 5000`). Dense cages and multi-component
 *        scenes that had bonds visibility-filtered at thumb scale
 *        now render with full structural wiring. Square projection
 *        target fixed the "1.2× taller than wide" aspect warp.
 *    4 — 2026-04-21 (follow-up 4). Poster scene bake switches from
 *        orthographic to pinhole perspective (`CURRENT_SCENE_REV = 2`).
 *        The OG poster now carries the same depth cues as the
 *        account-row thumb; `perspectiveMultiplier` in
 *        `CurrentPosterSceneSvg` stops being a no-op. Forces every
 *        cached social unfurl to refresh. */
export const TEMPLATE_VERSION = 4 as const;

/** Title fallback used everywhere — must match brand canonical name. */
export const CAPSULE_TITLE_FALLBACK = 'Atom Dojo Capsule';

/**
 * Code-point ranges supported by the bundled font.
 * If ANY code point of a sanitized title falls outside these ranges, the
 * sanitizer returns the fallback. The poster route assumes its input is
 * safe to glyph-shape with the bundled Latin font and does NOT re-inspect.
 *
 * Widened slightly from the pure-ASCII spec baseline so common Latin
 * punctuation (en/em dash, hyphens, low lines) and the joiner pair
 * [0x200C, 0x200D] also pass. The bundled Latin font covers all of these.
 */
export const BUNDLED_FONT_SUPPORTED_RANGES: ReadonlyArray<[number, number]> = [
  [0x0020, 0x007e], // Basic Latin (printable ASCII)
  [0x00a0, 0x00ff], // Latin-1 Supplement
  [0x0100, 0x017f], // Latin Extended-A
  [0x0180, 0x024f], // Latin Extended-B
  [0x200c, 0x200d], // ZWNJ / ZWJ (sanitizer may emit ZWJ; keep allowed)
  [0x2010, 0x2027], // General punctuation: hyphens, dashes, quotes, ellipsis, …
];

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
 * bundled font cannot render.
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
  // 9. Required non-Latin fallback — the single ownership boundary
  if (!allCodePointsSupported(s)) return CAPSULE_TITLE_FALLBACK;
  // 10. Final safety
  if (!s) return CAPSULE_TITLE_FALLBACK;
  return s;
}

// ── Deterministic hashing (FNV-1a 32-bit on UTF-16 code units) ────────────

/** Single source of truth for FNV-1a 32-bit hashing across the share/
 *  module boundary. Exported so scene-store + cache-key helpers cannot
 *  drift. */
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
