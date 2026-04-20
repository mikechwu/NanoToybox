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
 * at publish time from the **full capsule atoms** (not the downsampled
 * 32-atom poster scene), so the thumb preserves fidelity of dense
 * structures like C60 that otherwise lose recognizable topology to the
 * 60 → 32 → 12 double-downsampling cascade.
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

/** Current thumb-pipeline revision. Bump any time the thumb algorithm's
 *  observable output changes. */
export const CURRENT_THUMB_REV = 2;

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
  /** Pre-baked thumb payload derived from the FULL capsule atoms at
   *  publish time. Absent on rows published before the thumb-pipeline
   *  rollout; `derivePreviewThumbV1` falls back to live sampling from
   *  `atoms` in that case. */
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
/** Atom cap when the thumb payload carries bonds. Leaves headroom in the
 *  ≤20 DOM-element budget for up to {@link ROW_BOND_CAP} `<line>` elements
 *  (svg + rect + 12 circles + 6 lines = 20). */
export const ROW_ATOM_CAP_WITH_BONDS = 12;
/** Atom cap when the thumb payload is atoms-only (sparse scenes that
 *  don't benefit from bonds, or capsules whose stored scene omits bonds). */
export const ROW_ATOM_CAP_ATOMS_ONLY = 18;
/** Legacy alias — retained so external callers that named the cap get the
 *  bonds-free budget (the historically safer setting). */
export const ROW_ATOM_CAP = ROW_ATOM_CAP_ATOMS_ONLY;
/** Bond cap on the thumb payload. Combined with the DOM budget this keeps
 *  every thumb at ≤20 elements. */
export const ROW_BOND_CAP = 6;

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
 * the FULL capsule atoms (not from this poster scene). Returns a new
 * scene object; the hash and atoms are untouched.
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
    if (
      typeof rec.x !== 'number' || typeof rec.y !== 'number' ||
      typeof rec.r !== 'number' || typeof rec.c !== 'string'
    ) return null;
    atoms.push({ x: rec.x, y: rec.y, r: rec.r, c: rec.c });
  }
  let bonds: PreviewSceneBondV1[] | undefined;
  if (Array.isArray(obj.bonds)) {
    bonds = [];
    for (const b of obj.bonds) {
      if (!b || typeof b !== 'object') return null;
      const rec = b as Record<string, unknown>;
      if (typeof rec.a !== 'number' || typeof rec.b !== 'number') return null;
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
 *      `ROW_ATOM_CAP_WITH_BONDS` budget (12); everyone else uses the
 *      `ROW_ATOM_CAP_ATOMS_ONLY` budget (18).
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
    // endpoint.
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[scene-store] derive-threw: ${msg}`);
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
  const bondMaxDegree = options.bondMaxDegree ?? 2;
  const bondsThreshold = options.bondsAwareThreshold ?? BONDS_AWARE_SOURCE_THRESHOLD;
  const padding = options.padding ?? 0.04;
  const minVisibleBond = options.minVisibleBondViewbox ?? MIN_VISIBLE_BOND_VIEWBOX;
  const relaxedVisibleBond = options.relaxedVisibleBondViewbox ?? RELAXED_VISIBLE_BOND_VIEWBOX;
  const minAcceptableBonds = options.minAcceptableBonds ?? MIN_ACCEPTABLE_BONDS;
  const denseSceneThreshold = options.denseSceneThreshold ?? DENSE_SCENE_SOURCE_THRESHOLD;

  // Fast path: the publish-time pipeline already baked a thumb from the
  // FULL capsule atoms (higher fidelity than sampling the 32-atom poster
  // intermediate). Use it verbatim when present, at a compatible rev,
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

  const atomRadius = resolveBondedAtomRadius(sampled.length);
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
    const visible = len - 2 * atomRadius;
    if (visible < minVisibleBond) continue;
    candidates.push({ a, b, visible });
  }

  candidates.sort((p, q) => q.visible - p.visible);
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
 * the FULL capsule render scene (all atoms, not the 32-atom poster
 * subset), preserving connectivity fidelity that the double-downsampling
 * 60 → 32 → 12 cascade would otherwise destroy.
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
  const maxDegree = options.bondMaxDegree ?? 2;
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
 * The storage scene is normalized against the OG poster's 600×500 pane
 * with 10% padding, so atoms already occupy ~10%..90% of the 0..1 range.
 * At 40×40 thumb scale that wastes 6 of 40 pixels of margin per side, AND
 * the shape aspect-mismatch often leaves one axis drastically underfilled
 * (a wide structure → y-axis only spans 20%). This pass re-centers the
 * kept atoms and rescales so the smaller axis fits `1 - 2 * padding` of
 * the thumb, preserving aspect ratio.
 *
 * Radius-aware: the fit is computed against **glyph bounds** (`x ± r,
 * y ± r` with `renderMargin` matching the renderer's atom radius + stroke
 * width for the chosen mode), not raw atom centers. Without this the
 * center-cloud would fit the padded cell but rendered circles and bond
 * strokes would visually clip the edges.
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
  // Fit **center-cloud + glyph margin** into the padded cell. Center-
  // cloud must occupy `1 - 2*padding - 2*renderMargin` so the worst-case
  // glyph (centered at the span extreme, plus `renderMargin` for its
  // radius + stroke) lands exactly at the padded cell edge.
  const spanX = Math.max(1e-6, maxX - minX);
  const spanY = Math.max(1e-6, maxY - minY);
  const centerAvail = Math.max(0.01, 1 - 2 * padding - 2 * renderMargin);
  const scale = Math.min(centerAvail / spanX, centerAvail / spanY);
  const midX = (minX + maxX) / 2;
  const midY = (minY + maxY) / 2;
  return atoms.map((a) => ({
    ...a,
    x: Number((0.5 + (a.x - midX) * scale).toFixed(4)),
    y: Number((0.5 + (a.y - midY) * scale).toFixed(4)),
  }));
}

