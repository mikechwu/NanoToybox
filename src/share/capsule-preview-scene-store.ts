/**
 * Scene-store serializer + parser + hash helpers for the V2 capsule preview
 * pipeline (spec §S1).
 *
 * Owns the compact JSON representation of a projected preview scene that
 * lives in the `capsule_share.preview_scene_v1` D1 column. This module is
 * the single place responsible for turning a {@link CapsulePreviewRenderScene}
 * into storage-ready JSON and back, and for computing the FNV-1a content
 * hash that binds dynamic-poster ETags to the actual projected geometry.
 *
 * Pure module: no React, no DOM, no Cloudflare APIs. Safe to import from
 * Pages Functions, publish-core, account API, and unit tests.
 */

import { fnv1a32Hex } from './capsule-preview';
import type { CapsulePreviewRenderScene } from './capsule-preview-project';
import {
  resolveBondedAtomRadius,
  PERSPECTIVE_RADIUS_FLOOR_FACTOR,
  atomsOnlyThumbRenderMargin,
  bondedThumbRenderMargin,
  MIN_VISIBLE_BOND_VIEWBOX,
  RELAXED_VISIBLE_BOND_VIEWBOX,
} from './capsule-preview-thumb-render';
import { sampleEvenly, sampleForBondedThumb } from './capsule-preview-sampling';

export const PREVIEW_SCENE_SCHEMA_VERSION = 1 as const;

/** Storage atom shape — normalized 0..1 coordinates + radius + hex color. */
export interface PreviewSceneAtomV1 {
  x: number;
  y: number;
  r: number;
  c: string;
}

/** Storage bond shape — indices into the serialized `atoms` array. */
export interface PreviewSceneBondV1 {
  a: number;
  b: number;
}

/**
 * Pre-baked account-row thumbnail payload embedded in storage. Computed
 * at publish time from the **selected preview-subject atoms**
 * (cluster-filtered when the dominance guard passes, otherwise the
 * full frame — see D138 and `capsule-preview-cluster-select.ts`), NOT
 * from the downsampled 32-atom poster scene. This preserves fidelity
 * of dense structures like C60 that would otherwise lose recognizable
 * topology to the 60 → 32 → 12 double-downsampling cascade.
 *
 * Atoms + bonds are stored ALREADY refitted to the 40×40 thumb cell in
 * 0..1 normalized space, so the account API emits them verbatim. `rev`
 * bumps when the thumb-generation algorithm changes so backfill scripts
 * know which rows to force-rebake.
 */
export interface PreviewStoredThumbV1 {
  /** Bumps when `projectFullCapsuleToStoredThumb` output changes
   *  meaningfully — sampler, margin math, visibility filter, etc.
   *  Rows with `rev < CURRENT_THUMB_REV` are re-baked by the
   *  `scripts/backfill-*.{mjs,ts}` scripts. */
  rev: number;
  atoms: PreviewSceneAtomV1[];
  bonds?: PreviewSceneBondV1[];
}

/** Current thumb-pipeline revision. Bump any time the thumb
 *  algorithm's observable output changes — including upstream
 *  scene-shape changes that reach the thumb.
 *
 *  Rev history:
 *    2 — pre-D138 pipeline (unrelated to cluster selection).
 *    3 — D138 cluster-selection landing (thumb source becomes the
 *        selected subject, not the full frame).
 *    4 — D138 follow-up: path-batched renderer + cycle-preserving
 *        bond picker + caps raised 12/6 → 24/24.
 *    5 — D138 follow-up 2: account thumb pivots from 40 px to
 *        96 px; caps raised 24/24 → 48/48; flat-black ship preset
 *        with two-pass bonds is the account-row default.
 *    6 — D138 follow-up 3: `refitThumbAtoms` switches to
 *        independent per-axis fill (was aspect-preserving). Fixes
 *        the "no bonds" regression on planar / dominance-failed
 *        capsules (BNR-class) where aspect preservation left one
 *        axis so squished that all bonds fell under the visibility
 *        threshold (`len < 2 × atomRadius`).
 *    7 — D138 follow-up 4: thumb atom/bond caps raised to 5000
 *        (effectively unbounded for any realistic capsule). The cap
 *        stops being a design parameter — every capsule now renders
 *        as many atoms/bonds as it actually has.
 *    8 — D138 follow-up 5: refit policy switched from independent-
 *        axis fill (which distorted aspect) to aspect-preserving
 *        fill-shorter with overflow-crop. Atoms stay circular, bond
 *        angles stay truthful, planar subjects (BNR-class) show a
 *        faithful cross-section. Degenerate / extreme-aspect
 *        subjects (aspect > 5 or one axis near-zero) fall back to
 *        aspect-preserve fit-all.
 *    9 — D138 follow-up 6 (Path A, first cut): publish-time thumb
 *        bake uses pinhole perspective (K = 1.5). First rev used
 *        the TILTED canonical camera by mistake — per-atom depths
 *        diverged from the audit page's preview. Superseded by 10.
 *   10 — D138 follow-up 6 (Path A, audit fix): thumb bake uses the
 *        same UNTILTED camera (`deriveMinorAxisCamera`) the
 *        audit-page experimental renderer uses, so the baked
 *        thumb's per-atom perspective matches the live preview.
 *        The shared `PERSPECTIVE_RADIUS_FLOOR_FACTOR` keeps the
 *        renderer and visibility filter lockstep.
 *   11 — D138 follow-up 7: atom base radius doubled (~14 → 28 px
 *        at publish time; 2× chunkier glyphs on the 96 px thumb);
 *        renderer switches atoms from batched path to individual
 *        `<circle>` with a shared radial gradient (shaded-sphere
 *        look matching the audit-page EXPERIMENTAL preset); bond
 *        colors promoted to pure black/white; aspect policy gains
 *        a `MIN_CROP_ASPECT = 1.5` regime so mildly-anisotropic
 *        subjects (C60 at ~1.2:1) render as round shapes instead
 *        of getting cropped by fill-shorter.
 *   12 — D138 follow-up 8: (1) perspective projection target is
 *        now SQUARE (500×500) with isotropic `/500` normalization
 *        downstream — the previous 600×500 target + anisotropic
 *        `/600, /500` warp made spheres render as 1.2:1 talls.
 *        (2) base atom radius scaled from 28 → 22 (0.8×) so dense
 *        subjects don't pile black outlines on top of each other.
 *   13 — D138 follow-up 9: renderer paints atoms AND bonds in a
 *        single depth-sorted paint list (mirrors the audit-page
 *        `renderPerspectiveSketch`). Previously the two-pass
 *        "all bonds then all atoms" schedule let every atom
 *        occlude every bond regardless of 3D depth.
 *   14 — D138 follow-up 10: bond paint rank = far endpoint;
 *        uncapped bond retention on bake; poster bond widths 1.8×;
 *        Lab-matched background.
 *   15 — D138 follow-up 11: (1) `PERSPECTIVE_K_DEFAULT` raised
 *        from 1.5 to 3.17 — reduces the perspective depth cue to
 *        0.6× of the previous magnitude (far/near ratio moves
 *        from 0.6 to ~0.76). Dense fixtures (CNT, graphene) no
 *        longer read as "distorted". Per-atom stored `r` changes,
 *        hence a rev bump.
 *        (2) Poster SVG computes its own width/height from the
 *        content aspect to guard against renderers (Satori) that
 *        ignore `preserveAspectRatio` on outer SVG and stretch
 *        content to the element box — previously a square C60 got
 *        rasterized as a fat 1200×630 ellipse.
 *
 *  Rows with `rev < CURRENT_THUMB_REV` are re-baked by the backfill
 *  scripts. */
export const CURRENT_THUMB_REV = 15;

/**
 * Internal storage shape for the `preview_scene_v1` column. Bonds are
 * optional — absent when the publish-time pre-bake skipped bond computation.
 *
 * **This is NOT a public API shape.** The account endpoint projects this
 * down to {@link PreviewThumbV1} before returning it on the wire; bonds and
 * the hash field are stripped server-side (§Account Integration §3).
 */
export interface PreviewSceneV1 {
  v: typeof PREVIEW_SCENE_SCHEMA_VERSION;
  atoms: PreviewSceneAtomV1[];
  bonds?: PreviewSceneBondV1[];
  /** 8-hex-char FNV-1a32 of the canonical atom serialization. */
  hash: string;
  /** Pre-baked thumb payload derived from the selected-subject atoms
   *  (cluster-filtered per D138 when the dominance guard passes,
   *  otherwise the full frame) at publish time. Absent on rows
   *  published before the thumb-pipeline rollout; `derivePreviewThumbV1`
   *  falls back to live sampling from `atoms` in that case. */
  thumb?: PreviewStoredThumbV1;
}

/** Public account-API row payload. Carries a small bond subset for dense
 *  scenes (see §Bonds policy follow-up — the atoms-only rule was reopened
 *  after day-1 production feedback showed dense-carbon thumbs collapsed
 *  into indistinct dot clouds without connectivity cues). */
export interface PreviewThumbV1 {
  v: typeof PREVIEW_SCENE_SCHEMA_VERSION;
  atoms: PreviewSceneAtomV1[];
  /** Bond-index pairs into `atoms[]`. Absent (not empty) when the source
   *  scene has no bonds or the thumb is too sparse to benefit from them. */
  bonds?: PreviewSceneBondV1[];
}

/** Hard cap on atoms in the stored scene cell (spec §S1 constraints). */
export const SCENE_ATOM_CAP = 32;
/** Hard cap on stored bonds (spec §S1 constraints). */
export const SCENE_BOND_CAP = 64;
/** Atom cap on the thumb payload. History:
 *   12 (D138) — legacy ≤20 DOM budget under per-<circle> rendering
 *   → 24 (D138 follow-up, path-batched renderer)
 *   → 48 (D138 follow-up 2, 96 px account thumb)
 *   → 5000 (D138 follow-up 4, effectively-unbounded exploration).
 *
 *  Under the path-batched renderer DOM cost is O(unique render
 *  groups) not O(atoms), so the cap is not a DOM concern. At 5000
 *  no realistic capsule comes close — the limit stops being a
 *  "feature" and becomes defense-in-depth against a pathological
 *  payload. Real-world pressure is now only (a) stored-JSON size
 *  and (b) visual density on the 96 × 96 cell; both scale with the
 *  capsule's actual atom count, not this ceiling.
 *
 *  **Note on upstream `SCENE_ATOM_CAP` (32):** the read-path thumb
 *  fallback samples from the stored scene, which is still 32-capped.
 *  For newly-published rows the thumb is baked at publish time from
 *  the FULL selected-subject atoms (pre-scene-cap), so this 5000
 *  ceiling is effective on the write path even when the stored
 *  scene stays at 32. A separately-scoped "full-fidelity preview
 *  source" that also raises the stored-scene cap is deferred. */
export const ROW_ATOM_CAP_WITH_BONDS = 5000;
/** Atom cap when the thumb payload is atoms-only (sparse scenes that
 *  don't benefit from bonds, or capsules whose stored scene omits bonds). */
export const ROW_ATOM_CAP_ATOMS_ONLY = 18;
/** Legacy alias — retained so external callers that named the cap get the
 *  bonds-free budget (the historically safer setting). */
export const ROW_ATOM_CAP = ROW_ATOM_CAP_ATOMS_ONLY;
/** Bond cap on the thumb payload. Kept in lockstep with the atom
 *  cap above; at 5000 no realistic capsule hits it. History:
 *  6 → 24 → 48 → 5000. */
export const ROW_BOND_CAP = 5000;

/** Keep 4 decimal places on x/y, 3 on r. Truncates without rounding to
 *  preserve a deterministic byte-exact storage representation across
 *  implementations. 1 pixel at 1200×630 ≈ 0.0008, so 4 dp is lossless
 *  for the 1200-wide OG pane. */
function fixedString(n: number, decimals: number): string {
  if (!Number.isFinite(n)) return '0';
  const f = Math.pow(10, decimals);
  // toFixed rounds half-away-from-zero deterministically, which is good
  // enough for the preview geometry and matches what a server-side +
  // browser-side caller would produce.
  return (Math.round(n * f) / f).toFixed(decimals);
}

/** Normalize a hex color string to exactly `#RRGGBB` lowercase. Falls
 *  through to a neutral grey when the input is missing or malformed — the
 *  renderer consumes this verbatim, so we'd rather degrade to a visible
 *  default than emit `undefined` into the JSON cell. Exported so
 *  publish-core reuses the same implementation (no drift between what
 *  the publish-time thumb pre-bake emits and what the read path expects). */
export function normalizeHex(hex: string): string {
  if (typeof hex !== 'string') return '#9aa0a6';
  const s = hex.trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(s)) return s;
  if (/^#[0-9a-f]{3}$/.test(s)) {
    return `#${s[1]}${s[1]}${s[2]}${s[2]}${s[3]}${s[3]}`;
  }
  return '#9aa0a6';
}

/**
 * Canonical atom serialization used for hashing. Only the atoms contribute
 * — bonds are intentionally excluded so a future bond-policy recompute
 * does not invalidate edge caches keyed on the projected atom geometry.
 */
function canonicalAtomString(atoms: ReadonlyArray<PreviewSceneAtomV1>): string {
  const parts: string[] = [];
  for (const a of atoms) {
    parts.push(a.x.toString());
    parts.push(a.y.toString());
    parts.push(a.r.toString());
    parts.push(a.c);
  }
  return parts.join('|');
}

/** 8-hex-char FNV-1a32 over the canonical atom serialization. */
export function sceneHash(atoms: ReadonlyArray<PreviewSceneAtomV1>): string {
  return fnv1a32Hex(canonicalAtomString(atoms));
}

/**
 * Build a {@link PreviewSceneV1} from a render scene + optional bond pairs.
 * The caller is responsible for any upstream downsampling — this module
 * enforces storage caps as a defence-in-depth measure so a mis-scaled
 * render scene cannot inflate the D1 row unboundedly.
 */
export function buildPreviewSceneV1(
  scene: CapsulePreviewRenderScene,
  bonds?: ReadonlyArray<PreviewSceneBondV1>,
): PreviewSceneV1 {
  const srcAtoms = scene.atoms.slice(0, SCENE_ATOM_CAP);
  const width = scene.bounds.width;
  const height = scene.bounds.height;
  const norm = Math.min(width, height) || 1;
  // Normalize projector output (pixel space) back into 0..1 for storage.
  // The projector lays atoms out inside `bounds.width × bounds.height`;
  // storage uses a uniform 0..1 range so downstream renderers can scale
  // to their own canvas without carrying pixel dimensions around.
  const atoms: PreviewSceneAtomV1[] = srcAtoms.map((a) => ({
    x: Number(fixedString(a.x / width, 4)),
    y: Number(fixedString(a.y / height, 4)),
    r: Number(fixedString(a.r / norm, 3)),
    c: normalizeHex(a.colorHex),
  }));
  const hash = sceneHash(atoms);
  const scene_out: PreviewSceneV1 = {
    v: PREVIEW_SCENE_SCHEMA_VERSION,
    atoms,
    hash,
  };
  if (bonds && bonds.length > 0) {
    const keptBonds: PreviewSceneBondV1[] = [];
    const cap = Math.min(bonds.length, SCENE_BOND_CAP);
    for (let i = 0; i < cap; i++) {
      const b = bonds[i];
      // Storage-only invariant: bond indices must point at surviving atoms.
      // Any bond with an out-of-range endpoint gets dropped rather than
      // failing the whole publish — atoms-only is a valid fallback.
      if (
        Number.isInteger(b.a) && Number.isInteger(b.b) &&
        b.a >= 0 && b.a < atoms.length && b.b >= 0 && b.b < atoms.length &&
        b.a !== b.b
      ) {
        keptBonds.push({ a: b.a, b: b.b });
      }
    }
    if (keptBonds.length > 0) scene_out.bonds = keptBonds;
  }
  return scene_out;
}

/** Serialize a {@link PreviewSceneV1} to compact JSON for D1 storage. */
export function serializePreviewSceneV1(scene: PreviewSceneV1): string {
  return JSON.stringify(scene);
}

/**
 * Attach a pre-baked thumb payload to a poster-scene structure. Called
 * by the publish-time pipeline after the thumb has been computed from
 * the selected-subject atoms (cluster-filtered per D138 when the
 * dominance guard passes, otherwise the full frame — not from this
 * poster scene). Returns a new scene object; the hash and atoms are
 * untouched.
 */
export function attachStoredThumb(
  scene: PreviewSceneV1,
  thumb: PreviewStoredThumbV1,
): PreviewSceneV1 {
  return { ...scene, thumb };
}

/**
 * Parse a D1-stored scene JSON string. Returns null for any malformed or
 * absent input — the caller decides whether to fall back to lazy backfill,
 * a placeholder, or `previewThumb: null`.
 */
export function parsePreviewSceneV1(raw: string | null | undefined): PreviewSceneV1 | null {
  if (raw == null || raw === '') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const obj = parsed as Record<string, unknown>;
  if (obj.v !== PREVIEW_SCENE_SCHEMA_VERSION) return null;
  if (!Array.isArray(obj.atoms)) return null;
  const atoms: PreviewSceneAtomV1[] = [];
  for (const a of obj.atoms) {
    if (!a || typeof a !== 'object') return null;
    const rec = a as Record<string, unknown>;
    // `typeof 'number'` accepts NaN / ±Infinity. Reject them here
    // — a downstream renderer that multiplies NaN positions by
    // the pane dimensions emits `<circle cx="NaN">` which browsers
    // silently drop (invisible atoms with no log). Matches the
    // stricter guard `parseStoredThumb` already runs on embedded
    // thumb atoms. Audit finding: SFH #2.
    if (
      typeof rec.x !== 'number' || !Number.isFinite(rec.x) ||
      typeof rec.y !== 'number' || !Number.isFinite(rec.y) ||
      typeof rec.r !== 'number' || !Number.isFinite(rec.r) ||
      typeof rec.c !== 'string'
    ) return null;
    atoms.push({ x: rec.x, y: rec.y, r: rec.r, c: rec.c });
  }
  let bonds: PreviewSceneBondV1[] | undefined;
  if (Array.isArray(obj.bonds)) {
    bonds = [];
    for (const b of obj.bonds) {
      if (!b || typeof b !== 'object') return null;
      const rec = b as Record<string, unknown>;
      if (
        typeof rec.a !== 'number' || !Number.isInteger(rec.a) ||
        typeof rec.b !== 'number' || !Number.isInteger(rec.b)
      ) return null;
      bonds.push({ a: rec.a, b: rec.b });
    }
  }
  const hash = typeof obj.hash === 'string' ? obj.hash : sceneHash(atoms);
  const out: PreviewSceneV1 = { v: PREVIEW_SCENE_SCHEMA_VERSION, atoms, hash };
  if (bonds && bonds.length > 0) out.bonds = bonds;
  // Optional pre-baked thumb payload (publish-time, from full atoms).
  // A malformed thumb is dropped (scene still returns) — a visible warn
  // signals the bad row so ops can size a corrupt batch during rollouts.
  if (obj.thumb != null) {
    const thumbResult = parseStoredThumb(obj.thumb);
    if (thumbResult.ok === true) {
      out.thumb = thumbResult.thumb;
    } else if (thumbResult.ok === false) {
      console.warn(`[scene-store] thumb-malformed: ${thumbResult.reason}`);
    }
  }
  return out;
}

/** Decode + validate a `PreviewStoredThumbV1` from the stored JSON. Returns
 *  an explicit ok/reason pair so the caller can distinguish "no thumb
 *  stored" (caller's own absence check) from "thumb was present but
 *  malformed" (we drop + warn). */
function parseStoredThumb(
  raw: unknown,
): { ok: true; thumb: PreviewStoredThumbV1 } | { ok: false; reason: string } {
  if (!raw || typeof raw !== 'object') return { ok: false, reason: 'not-an-object' };
  const thumbObj = raw as Record<string, unknown>;
  // Require `rev` to be a strictly-positive integer — guards against NaN/
  // Infinity (both are `typeof 'number'`) and against fractional/negative
  // values that would silently misbehave in rev-comparisons.
  if (
    typeof thumbObj.rev !== 'number' ||
    !Number.isInteger(thumbObj.rev) ||
    thumbObj.rev <= 0
  ) {
    return { ok: false, reason: `invalid-rev:${String(thumbObj.rev)}` };
  }
  if (!Array.isArray(thumbObj.atoms)) return { ok: false, reason: 'no-atoms' };
  const tAtoms: PreviewSceneAtomV1[] = [];
  for (const a of thumbObj.atoms) {
    if (!a || typeof a !== 'object') return { ok: false, reason: 'atom-not-an-object' };
    const rec = a as Record<string, unknown>;
    // `typeof 'number'` accepts NaN / ±Infinity; require `Number.isFinite`
    // so the renderer doesn't emit `<circle cx="NaN">` (browsers silently
    // drop such circles, producing invisible thumbs with no log).
    if (
      typeof rec.x !== 'number' || !Number.isFinite(rec.x) ||
      typeof rec.y !== 'number' || !Number.isFinite(rec.y) ||
      typeof rec.r !== 'number' || !Number.isFinite(rec.r) ||
      typeof rec.c !== 'string'
    ) {
      return { ok: false, reason: 'atom-nonfinite-or-malformed' };
    }
    tAtoms.push({ x: rec.x, y: rec.y, r: rec.r, c: rec.c });
  }
  const thumbOut: PreviewStoredThumbV1 = { rev: thumbObj.rev, atoms: tAtoms };
  if (Array.isArray(thumbObj.bonds)) {
    const tBonds: PreviewSceneBondV1[] = [];
    for (const b of thumbObj.bonds) {
      if (!b || typeof b !== 'object') return { ok: false, reason: 'bond-not-an-object' };
      const rec = b as Record<string, unknown>;
      if (
        typeof rec.a !== 'number' || !Number.isInteger(rec.a) ||
        typeof rec.b !== 'number' || !Number.isInteger(rec.b)
      ) return { ok: false, reason: 'bond-nonint-indices' };
      tBonds.push({ a: rec.a, b: rec.b });
    }
    if (tBonds.length > 0) thumbOut.bonds = tBonds;
  }
  return { ok: true, thumb: thumbOut };
}

/**
 * Sampler signature consumed by {@link derivePreviewThumbV1}.
 *
 * **Contract** (load-bearing for bond-index translation):
 *   1. Returned atoms MUST be the same references that appeared in the
 *      input array — no clones, no coordinate normalization. The
 *      downstream `idxMap` step in `derivePreviewThumbV1` uses reference
 *      identity to reconcile storage indices with sampled positions so
 *      `PreviewThumbV1.bonds` endpoints stay valid. A sampler that clones
 *      its inputs will silently produce a thumb with no bonds.
 *   2. Returned atoms MUST appear in their original storage-array order.
 *      The reconcile loop walks `scene.atoms` monotonically and matches
 *      each sampled item in order; out-of-order returns drop bonds.
 *
 * Implementations that only need index-based picks can ignore the fact
 * that the input is spatial; silhouette-preserving picks use the stored
 * coordinates directly (see `capsule-preview-sampling.ts`).
 */
export type ThumbAtomSampler = (
  atoms: ReadonlyArray<PreviewSceneAtomV1>,
  target: number,
) => PreviewSceneAtomV1[];

/** Atom count above which an atoms-only thumb starts reading as a dot-
 *  cloud knot, so a bond skeleton earns its DOM-budget cost. Kept above
 *  the dense-mode atom cap so any scene routed to the bonded path has
 *  strictly more atoms than the eventual sampled cap can hold. */
export const BONDS_AWARE_SOURCE_THRESHOLD = 14;

/** At or above this source-atom count, the tiered-visibility policy
 *  permits the relaxed threshold before falling back. Below this
 *  threshold, atoms-only at the sparse cap reads well enough that
 *  marginally-visible bonds would only add noise. */
const DENSE_SCENE_SOURCE_THRESHOLD = 24;

/** Minimum bond count a bonded-mode thumb must successfully produce
 *  before it's preferred over the atoms-only fallback. At 1 or 0 bonds,
 *  the atoms-only layout with 18 dots is a cleaner read than 12 dots
 *  with a stray floating segment. */
const MIN_ACCEPTABLE_BONDS = 2;

/**
 * Derive the public account-API row payload from stored scene JSON.
 *
 * Read-path pipeline (single point of downsampling — spec AC #26):
 *
 *   A. Parse storage JSON (`PreviewSceneV1`).
 *   B. Decide whether the scene is a candidate for the bonded-mode thumb
 *      (storage has bonds AND `atoms.length >= BONDS_AWARE_SOURCE_THRESHOLD`).
 *   C. **Layout-first**: sample atoms via the injected silhouette sampler
 *      (production uses `sampleForSilhouette`). Bonded candidates use the
 *      `ROW_ATOM_CAP_WITH_BONDS` budget (currently 48, see the
 *      constant); everyone else uses the `ROW_ATOM_CAP_ATOMS_ONLY`
 *      budget (18).
 *   D. Refit the sampled atoms into a thumb-specific padded cell. Refit
 *      margin is mode-aware — bonded mode uses a tighter margin because
 *      its atom glyphs are smaller.
 *   E. If the scene was a bonded candidate:
 *       - translate storage bonds into sampled-atom indices (drop any
 *         bond whose endpoints didn't both survive sampling),
 *       - filter bonds whose rendered exposed segment would be shorter
 *         than `MIN_VISIBLE_BOND_VIEWBOX` (atoms would occlude the line),
 *       - coverage-select up to `bondCap` bonds: prefer longer visible
 *         segments, cap per-atom degree so one cluster can't consume the
 *         budget.
 *       - if fewer than `MIN_ACCEPTABLE_BONDS` survive, discard this
 *         layout and re-derive as atoms-only. A single stray bond reads
 *         worse than an 18-dot cluster at 40×40.
 *   F. Return `null` when input is absent, malformed, or empty — the
 *      account client renders `PlaceholderThumb` in that case.
 *
 * Storage-only fields (`hash`, the full unsampled `atoms`/`bonds`) never
 * appear in the returned payload.
 */
export function derivePreviewThumbV1(
  raw: string | null | undefined,
  options: {
    atomCap?: number;
    bondsAwareAtomCap?: number;
    bondCap?: number;
    sampler?: ThumbAtomSampler;
    /** Override the thumb-refit padding (0..0.5). Defaults to 0.04. */
    padding?: number;
    /** Override the atom-count threshold for switching into bonds mode.
     *  Defaults to {@link BONDS_AWARE_SOURCE_THRESHOLD}. */
    bondsAwareThreshold?: number;
    /** Per-atom cap when picking the bond subset. Prevents one cluster
     *  from monopolizing the bond budget. Defaults to 2. */
    bondMaxDegree?: number;
    /** Override the STRICT minimum exposed bond segment (viewBox units).
     *  Defaults to 3. Bonds passing this threshold are always kept. */
    minVisibleBondViewbox?: number;
    /** Override the RELAXED minimum exposed bond segment (viewBox units)
     *  used as a fallback on dense scenes when the strict threshold
     *  yields too few survivors. Defaults to 2. */
    relaxedVisibleBondViewbox?: number;
    /** Override the minimum bond count required before bonded-mode is
     *  preferred over atoms-only. Defaults to 2. */
    minAcceptableBonds?: number;
    /** Override the source-atom threshold above which the relaxed
     *  visibility tier is allowed. Defaults to 24. */
    denseSceneThreshold?: number;
  } = {},
): PreviewThumbV1 | null {
  try {
    return deriveThumbImpl(raw, options);
  } catch (err) {
    // An exception here (e.g. a sampler edge case, an SVG math
    // misstep) would bubble up into the account list handler and 500
    // the entire page. Swallow locally + warn so a single bad row
    // degrades to the placeholder thumb instead of taking out the
    // endpoint. Include the scene's content hash in the warn so
    // ops can correlate failures across rows — without it, 100
    // broken rows produce 100 indistinguishable log lines.
    const msg = err instanceof Error ? err.message : String(err);
    let hash: string = 'unparsed';
    try {
      const parsed = parsePreviewSceneV1(raw);
      if (parsed?.hash) hash = parsed.hash;
    } catch {
      // The outer catch implies parse failed; keep the hash
      // marker as 'unparsed' so the correlation is still distinct.
    }
    console.warn(`[scene-store] derive-threw: ${msg} hash=${hash}`);
    return null;
  }
}

function deriveThumbImpl(
  raw: string | null | undefined,
  options: Parameters<typeof derivePreviewThumbV1>[1] = {},
): PreviewThumbV1 | null {
  const scene = parsePreviewSceneV1(raw);
  if (!scene || scene.atoms.length === 0) return null;

  const sampler = options.sampler ?? sampleEvenly;
  const sparseCap = options.atomCap ?? ROW_ATOM_CAP_ATOMS_ONLY;
  const denseCap = options.bondsAwareAtomCap ?? ROW_ATOM_CAP_WITH_BONDS;
  const bondCap = options.bondCap ?? ROW_BOND_CAP;
  const bondMaxDegree = options.bondMaxDegree ?? 3;
  const bondsThreshold = options.bondsAwareThreshold ?? BONDS_AWARE_SOURCE_THRESHOLD;
  const padding = options.padding ?? 0.04;
  const minVisibleBond = options.minVisibleBondViewbox ?? MIN_VISIBLE_BOND_VIEWBOX;
  const relaxedVisibleBond = options.relaxedVisibleBondViewbox ?? RELAXED_VISIBLE_BOND_VIEWBOX;
  const minAcceptableBonds = options.minAcceptableBonds ?? MIN_ACCEPTABLE_BONDS;
  const denseSceneThreshold = options.denseSceneThreshold ?? DENSE_SCENE_SOURCE_THRESHOLD;

  // Fast path: the publish-time pipeline already baked a thumb from the
  // selected-subject atoms (cluster-filtered when the dominance guard
  // passes, otherwise the full frame — higher fidelity than sampling
  // the 32-atom poster intermediate). Use it verbatim when present, at
  // a compatible rev,
  // AND carrying real atoms. Forward-compat: accept rev ≥ CURRENT so a
  // staggered deploy where newer rev-N+1 storage meets rev-N readers
  // doesn't silently downgrade to the legacy sampling path. Rev below
  // current triggers a one-time warn so ops can size any stuck backfill.
  if (scene.thumb && scene.thumb.atoms.length > 0) {
    if (scene.thumb.rev >= CURRENT_THUMB_REV) {
      const out: PreviewThumbV1 = {
        v: PREVIEW_SCENE_SCHEMA_VERSION,
        atoms: scene.thumb.atoms.slice(),
      };
      if (scene.thumb.bonds && scene.thumb.bonds.length > 0) {
        out.bonds = scene.thumb.bonds.slice();
      }
      return out;
    }
    console.warn(
      `[scene-store] thumb-rev-stale: stored=${scene.thumb.rev} current=${CURRENT_THUMB_REV}`,
    );
  }

  const storageHasBonds = !!(scene.bonds && scene.bonds.length > 0);
  const bondedCandidate =
    storageHasBonds && scene.atoms.length >= bondsThreshold;

  if (bondedCandidate && scene.bonds) {
    // Tier 1 (strict): every bond must have a clearly visible segment.
    let bonded = buildBondedThumb(
      scene, scene.bonds, denseCap, padding, bondCap, bondMaxDegree,
      minVisibleBond,
    );
    const strictBondCount = bonded?.bonds?.length ?? 0;
    if (bonded && strictBondCount >= minAcceptableBonds) {
      return bonded;
    }

    // Tier 2 (relaxed): only admitted for dense scenes where falling
    // back to atoms-only would lose too much connectivity signal. The
    // relaxed threshold is still readable as a stroke (≥ ~0.8 physical
    // px at 40×40), but we'd rather use the strict threshold when it
    // can cover the minimum bond count.
    if (scene.atoms.length >= denseSceneThreshold) {
      bonded = buildBondedThumb(
        scene, scene.bonds, denseCap, padding, bondCap, bondMaxDegree,
        relaxedVisibleBond,
      );
      const relaxedBondCount = bonded?.bonds?.length ?? 0;
      if (bonded && relaxedBondCount >= minAcceptableBonds) {
        return bonded;
      }
    }
  }

  // Fallback: atoms-only layout.
  return buildAtomsOnlyThumb(scene, sampler, sparseCap, padding);
}

/**
 * Core bonded-layout pipeline shared by the live-derivation
 * `buildBondedThumb` and the publish-time `buildBondedStoredThumb`.
 *
 * Pipeline:
 *   1. Sample atoms via the bond-aware sampler (`sampleForBondedThumb`).
 *   2. Build a storage-index → sampled-index map via reference identity
 *      (sampler contract preserves refs + order).
 *   3. Refit sampled atoms into the thumb cell using the bonded render
 *      margin (mode-aware: tight because atoms are small).
 *   4. Translate each source bond through the index map, compute its
 *      rendered visible segment, and filter by `minVisibleBond`.
 *   5. Sort surviving candidates by visible length descending and
 *      coverage-select up to `bondCap` with a per-atom degree cap.
 *
 * Both callers wrap the `{ atoms, bonds }` result in their own envelope
 * (`{ v }` for the live path, `{ rev }` for the storage path).
 */
interface BondedLayoutResult {
  atoms: PreviewSceneAtomV1[];
  bonds: PreviewSceneBondV1[];
}

function buildBondedLayoutCore(
  sourceAtoms: ReadonlyArray<PreviewSceneAtomV1>,
  sourceBonds: ReadonlyArray<PreviewSceneBondV1>,
  atomCap: number,
  padding: number,
  bondCap: number,
  maxDegree: number,
  minVisibleBond: number,
): BondedLayoutResult | null {
  const sampled = sourceAtoms.length > atomCap
    ? sampleForBondedThumb<PreviewSceneAtomV1>(
        sourceAtoms,
        sourceBonds,
        atomCap,
        (a) => a.x,
        (a) => a.y,
      )
    : sourceAtoms.slice();
  if (sampled.length === 0) return null;

  const idxMap = new Map<number, number>();
  let newIdx = 0;
  for (let oldIdx = 0; oldIdx < sourceAtoms.length; oldIdx++) {
    if (newIdx < sampled.length && sampled[newIdx] === sourceAtoms[oldIdx]) {
      idxMap.set(oldIdx, newIdx);
      newIdx++;
    }
  }

  const refit = refitThumbAtoms(
    sampled,
    padding,
    bondedThumbRenderMargin(sampled.length),
  );

  // Visibility filter uses per-bond endpoint radii. Under the D138
  // perspective-bake follow-up (rev ≥ 9), stored `r` is per-atom and
  // varies with depth, so the old `2 × atomRadius` uniform
  // subtraction would over-estimate occlusion for near-pairs and
  // under-estimate for far-pairs. The density-based uniform radius
  // still acts as a floor to match the renderer's effective-radius
  // logic on atoms with no stored r.
  const densityRadius = resolveBondedAtomRadius(sampled.length);
  // Shared with CurrentThumbSvg — keeps "kept vs painted" in sync.
  const radiusFloor = densityRadius * PERSPECTIVE_RADIUS_FLOOR_FACTOR;
  const effRadius = (a: PreviewSceneAtomV1): number => {
    const scaled = Number.isFinite(a.r) ? a.r * 100 : 0;
    return scaled > 0 ? Math.max(radiusFloor, scaled) : densityRadius;
  };
  interface Candidate { a: number; b: number; visible: number }
  const candidates: Candidate[] = [];
  for (const bond of sourceBonds) {
    const a = idxMap.get(bond.a);
    const b = idxMap.get(bond.b);
    if (a == null || b == null || a === b) continue;
    const pa = refit[a];
    const pb = refit[b];
    const dx = (pb.x - pa.x) * 100;
    const dy = (pb.y - pa.y) * 100;
    const len = Math.hypot(dx, dy);
    const visible = len - (effRadius(pa) + effRadius(pb));
    if (visible < minVisibleBond) continue;
    candidates.push({ a, b, visible });
  }

  // Cycle-preservation heuristic. The previous sort was "longest
  // visible first", which for a closed cage like C60 biases toward a
  // handful of perimeter bonds and leaves interior rings as isolated
  // fragments. Count how many candidate bonds each atom participates
  // in — atoms that show up in many candidate bonds are likely ring
  // atoms, and bonds between two ring atoms are strong cycle-closing
  // candidates. Score bonds by `cycleBonus(a)·cycleBonus(b)` with a
  // small visible-length tie-breaker so ties in cycle participation
  // still prefer clearly-visible bonds.
  const candidateDegree = new Map<number, number>();
  for (const c of candidates) {
    candidateDegree.set(c.a, (candidateDegree.get(c.a) ?? 0) + 1);
    candidateDegree.set(c.b, (candidateDegree.get(c.b) ?? 0) + 1);
  }
  const cycleBonus = (idx: number) => Math.min(candidateDegree.get(idx) ?? 0, 3);
  candidates.sort((p, q) => {
    const sp = cycleBonus(p.a) * cycleBonus(p.b) * 10 + p.visible;
    const sq = cycleBonus(q.a) * cycleBonus(q.b) * 10 + q.visible;
    return sq - sp;
  });
  const kept: PreviewSceneBondV1[] = [];
  const degree = new Map<number, number>();
  for (const c of candidates) {
    if (kept.length >= bondCap) break;
    const da = degree.get(c.a) ?? 0;
    const db = degree.get(c.b) ?? 0;
    if (da >= maxDegree || db >= maxDegree) continue;
    kept.push({ a: c.a, b: c.b });
    degree.set(c.a, da + 1);
    degree.set(c.b, db + 1);
  }

  return { atoms: refit, bonds: kept };
}

/**
 * Live-derivation bonded-thumb wrapper around {@link buildBondedLayoutCore}.
 */
function buildBondedThumb(
  scene: PreviewSceneV1,
  storageBonds: ReadonlyArray<PreviewSceneBondV1>,
  atomCap: number,
  padding: number,
  bondCap: number,
  maxDegree: number,
  minVisibleBond: number,
): PreviewThumbV1 | null {
  const layout = buildBondedLayoutCore(
    scene.atoms, storageBonds,
    atomCap, padding, bondCap, maxDegree, minVisibleBond,
  );
  if (!layout) return null;
  const out: PreviewThumbV1 = {
    v: PREVIEW_SCENE_SCHEMA_VERSION,
    atoms: layout.atoms,
  };
  if (layout.bonds.length > 0) out.bonds = layout.bonds;
  return out;
}

/**
 * Publish-time helper: build a {@link PreviewStoredThumbV1} directly from
 * the selected-subject render scene (cluster-filtered per D138 when the
 * dominance guard passes, otherwise the full frame — not the 32-atom
 * poster subset), preserving connectivity fidelity that the double-
 * downsampling 60 → 32 → 12 cascade would otherwise destroy.
 *
 * The returned thumb's `atoms[]` are already refit into the thumb cell
 * (0..1 normalized, thumb-specific padding + mode-aware render margin)
 * and `bonds[]` reference indices into that returned `atoms[]` array.
 *
 * Returns null when the full scene has no atoms.
 */
export function buildStoredThumbFromFullScene(
  fullProjectedAtoms: ReadonlyArray<PreviewSceneAtomV1>,
  fullBonds: ReadonlyArray<PreviewSceneBondV1>,
  options: {
    atomCap?: number;
    bondCap?: number;
    bondMaxDegree?: number;
    padding?: number;
    minVisibleBondViewbox?: number;
    relaxedVisibleBondViewbox?: number;
    minAcceptableBonds?: number;
  } = {},
): PreviewStoredThumbV1 | null {
  if (fullProjectedAtoms.length === 0) return null;
  const atomCap = options.atomCap ?? ROW_ATOM_CAP_WITH_BONDS;
  const bondCap = options.bondCap ?? ROW_BOND_CAP;
  const maxDegree = options.bondMaxDegree ?? 3;
  const padding = options.padding ?? 0.04;
  const strictThreshold = options.minVisibleBondViewbox ?? MIN_VISIBLE_BOND_VIEWBOX;
  const relaxedThreshold = options.relaxedVisibleBondViewbox ?? RELAXED_VISIBLE_BOND_VIEWBOX;
  const minAcceptable = options.minAcceptableBonds ?? MIN_ACCEPTABLE_BONDS;

  const wantBonds = fullBonds.length > 0
    && fullProjectedAtoms.length >= BONDS_AWARE_SOURCE_THRESHOLD;

  if (!wantBonds) {
    return {
      rev: CURRENT_THUMB_REV,
      atoms: sampleAtomsOnlyForStoredThumb(fullProjectedAtoms, padding),
    };
  }

  // Tier 1 strict → Tier 2 relaxed on dense → atoms-only fallback.
  let built = buildBondedStoredThumb(
    fullProjectedAtoms, fullBonds,
    atomCap, padding, bondCap, maxDegree, strictThreshold,
  );
  if (built && (built.bonds?.length ?? 0) >= minAcceptable) return built;

  if (fullProjectedAtoms.length >= DENSE_SCENE_SOURCE_THRESHOLD) {
    built = buildBondedStoredThumb(
      fullProjectedAtoms, fullBonds,
      atomCap, padding, bondCap, maxDegree, relaxedThreshold,
    );
    if (built && (built.bonds?.length ?? 0) >= minAcceptable) return built;
  }

  return {
    rev: CURRENT_THUMB_REV,
    atoms: sampleAtomsOnlyForStoredThumb(fullProjectedAtoms, padding),
  };
}

function sampleAtomsOnlyForStoredThumb(
  atoms: ReadonlyArray<PreviewSceneAtomV1>,
  padding: number,
): PreviewSceneAtomV1[] {
  const sampled = atoms.length > ROW_ATOM_CAP_ATOMS_ONLY
    ? sampleEvenly(atoms, ROW_ATOM_CAP_ATOMS_ONLY)
    : atoms.slice();
  return refitThumbAtoms(
    sampled, padding, atomsOnlyThumbRenderMargin(sampled.length),
  );
}

/** Publish-time bonded-thumb wrapper around {@link buildBondedLayoutCore}. */
function buildBondedStoredThumb(
  fullAtoms: ReadonlyArray<PreviewSceneAtomV1>,
  fullBonds: ReadonlyArray<PreviewSceneBondV1>,
  atomCap: number,
  padding: number,
  bondCap: number,
  maxDegree: number,
  minVisibleBond: number,
): PreviewStoredThumbV1 | null {
  const layout = buildBondedLayoutCore(
    fullAtoms, fullBonds,
    atomCap, padding, bondCap, maxDegree, minVisibleBond,
  );
  if (!layout) return null;
  const out: PreviewStoredThumbV1 = { rev: CURRENT_THUMB_REV, atoms: layout.atoms };
  if (layout.bonds.length > 0) out.bonds = layout.bonds;
  return out;
}

/** Atoms-only layout builder. */
function buildAtomsOnlyThumb(
  scene: PreviewSceneV1,
  sampler: ThumbAtomSampler,
  atomCap: number,
  padding: number,
): PreviewThumbV1 | null {
  const sampled = scene.atoms.length > atomCap
    ? sampler(scene.atoms, atomCap)
    : scene.atoms.slice();
  if (sampled.length === 0) return null;
  const refit = refitThumbAtoms(
    sampled,
    padding,
    atomsOnlyThumbRenderMargin(sampled.length),
  );
  return {
    v: PREVIEW_SCENE_SCHEMA_VERSION,
    atoms: refit,
  };
}

/**
 * Refit a set of 0..1-normalized atoms into a thumb-specific padded box.
 *
 * ## Aspect policy (crop, don't distort)
 *
 * Atoms keep their 1:1 aspect ratio — a circle stays a circle, an
 * angle stays an angle. The refit picks the scale that **fills the
 * SHORTER span** of the atom cloud into the padded cell; the longer
 * span overflows the viewBox and is naturally clipped by the outer
 * `<svg>` (which has `overflow: hidden` by default for outer SVGs).
 * Bonds crossing the viewBox edge draw their visible portion and
 * clip at the boundary — same mechanism, no extra work.
 *
 * Rationale, worked example on the BNR 172-atom balanced capsule:
 *   - projection span: x ∈ [0.10, 0.90] (span 0.80), y ∈ [0.38, 0.62] (span 0.24)
 *   - aspect-PRESERVE fit (old `Math.min`): shorter span 0.24
 *     stays full, x compresses → thumb is a thin horizontal stripe,
 *     bond lengths collapse below `2 × atomRadius` → every bond
 *     falls out of the visibility filter ("no bonds" regression).
 *   - independent axes (`scaleX, scaleY` separately): fills both
 *     axes but distorts — circles become ovals, bond angles skew.
 *     That was the previous attempt; it looks "shrunken" and
 *     stretched.
 *   - aspect-PRESERVE fill-shorter (`Math.max`, this version):
 *     scale = max(availX/spanX, availY/spanY). The shorter span
 *     fills the cell (here: y fills), the longer span extends past
 *     the cell boundary (here: x overflows symmetrically around
 *     centre). Atoms outside the viewBox are clipped; bonds across
 *     the boundary draw their visible portion. The visible slice is
 *     a faithful, un-distorted piece of the real structure.
 *
 * Result: circles stay circular, bond angles stay truthful, planar
 * subjects show a legible cross-section instead of a squished
 * stripe or a stretched oval. Sphere-like subjects are unaffected
 * (the two axis scales are ≈ equal → `max === min` → no overflow).
 *
 * Radius-aware: the fit is computed against **glyph bounds** (`x ± r,
 * y ± r` with `renderMargin` matching the renderer's atom radius +
 * stroke width for the chosen mode), not raw atom centers. The
 * shorter-span atoms still respect the `padding + renderMargin`
 * inset from the cell edge; only the longer-span atoms overflow.
 */
function refitThumbAtoms(
  atoms: ReadonlyArray<PreviewSceneAtomV1>,
  padding: number,
  renderMargin: number,
): PreviewSceneAtomV1[] {
  const n = atoms.length;
  if (n === 0) return [];
  if (n === 1) {
    // Single atom — center it; radius stays as stored (renderer applies
    // its density-aware floor).
    return [{ ...atoms[0], x: 0.5, y: 0.5 }];
  }
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const a of atoms) {
    if (a.x < minX) minX = a.x;
    if (a.x > maxX) maxX = a.x;
    if (a.y < minY) minY = a.y;
    if (a.y > maxY) maxY = a.y;
  }
  // Aspect-preserving fill policy with THREE regimes:
  //   1. ROUNDISH (aspect < MIN_CROP_ASPECT, ~1.5): fit-all. Any
  //      subject close to square — a sphere-like C60, a CNT seen
  //      face-on, a well-balanced patch — must STAY looking like a
  //      sphere/square. Fill-shorter would exaggerate a mild 1.2:1
  //      projection into a visibly cropped image with the longer
  //      axis running off the cell; at that aspect ratio the extra
  //      cropping communicates less than it destroys, so we
  //      preserve the full shape instead.
  //   2. ELONGATED (MIN_CROP_ASPECT ≤ aspect ≤ MAX_CROP_ASPECT):
  //      fill-shorter. Shorter span fills the cell, longer span
  //      overflows. Planar subjects (BNR, banded fragments) get a
  //      faithful cross-section instead of a squished stripe.
  //   3. EXTREME (aspect > MAX_CROP_ASPECT) or DEGENERATE (one
  //      span near-zero — dimers, collinear chains): fit-all
  //      again. Past ~5× aspect the visible slice loses too much
  //      context; at the degenerate end fill-shorter would send
  //      atoms off the canvas entirely (dimers → empty thumb).
  //
  // Thresholds are legibility choices, not math constants. See the
  // regression fixtures in `capsule-preview-pipeline.test.ts` for
  // how each regime is tested.
  const spanX = Math.max(1e-6, maxX - minX);
  const spanY = Math.max(1e-6, maxY - minY);
  const centerAvail = Math.max(0.01, 1 - 2 * padding - 2 * renderMargin);
  const scaleFromX = centerAvail / spanX;
  const scaleFromY = centerAvail / spanY;
  const MIN_SIGNIFICANT_SPAN = 0.05;
  const MIN_CROP_ASPECT = 1.5;  // below this: roundish → fit-all
  const MAX_CROP_ASPECT = 5;    // above this: too narrow to crop meaningfully
  const longerSpan = Math.max(spanX, spanY);
  const shorterSpan = Math.max(1e-6, Math.min(spanX, spanY));
  const aspectRatio = longerSpan / shorterSpan;
  const degenerate = spanX < MIN_SIGNIFICANT_SPAN || spanY < MIN_SIGNIFICANT_SPAN;
  const roundish = aspectRatio < MIN_CROP_ASPECT;
  const tooExtreme = aspectRatio > MAX_CROP_ASPECT;
  const scale = (degenerate || tooExtreme || roundish)
    ? Math.min(scaleFromX, scaleFromY)  // fit-all, aspect-preserve
    : Math.max(scaleFromX, scaleFromY); // fill-shorter, overflow-crop
  const midX = (minX + maxX) / 2;
  const midY = (minY + maxY) / 2;
  return atoms.map((a) => ({
    ...a,
    x: Number((0.5 + (a.x - midX) * scale).toFixed(4)),
    y: Number((0.5 + (a.y - midY) * scale).toFixed(4)),
  }));
}

