/**
 * Shared publish logic: validation, metadata extraction, hash computation,
 * ID generation, publish-time preview-scene projection, and collision-safe
 * D1 insert.
 *
 * Used by both the publish endpoint (functions/api/capsules/publish.ts)
 * and the admin seed tool (functions/api/admin/seed.ts) to ensure
 * seeded and published records are structurally identical.
 *
 * Owns:        preparePublishRecord (pure), persistRecord (D1 insert)
 * Depends on:  src/history/history-file-v1.ts (validateCapsuleFile),
 *              src/share/share-code.ts (generateShareCode),
 *              src/share/capsule-preview-{frame,project,scene-store}.ts
 * Called by:   functions/api/capsules/publish.ts,
 *              functions/api/admin/seed.ts
 *
 * V2 publish-time pre-bake (spec §S1): preparePublishRecord projects the
 * previewable scene from the parsed capsule and returns it as
 * `previewSceneV1Json: string | null`. persistRecord INSERTs that prepared
 * field verbatim — it does NOT re-parse the capsule. (AC #25)
 */

import { validateCapsuleFile } from '../history/history-file-v1';
import type { D1Database } from './d1-types';
import type { AtomDojoPlaybackCapsuleFileV1 } from '../history/history-file-v1';
import { generateShareCode } from './share-code';
import type { ShareRecordStatus, PreviewStatus, ShareMode } from './share-record';
import {
  buildPreviewSceneFromCapsule,
  PreviewSceneBuildException,
} from './capsule-preview-frame';
import {
  projectPreviewScenePerspective,
  deriveBondPairsForProjectedScene,
} from './capsule-preview-project';
import { buildBondTopologyFromAtoms } from '../topology/build-bond-topology';
import { createBondRules } from '../topology/bond-rules';
import { selectPreviewSubjectCluster } from './capsule-preview-cluster-select';
import {
  attachStoredThumb,
  buildPreviewSceneV1,
  buildStoredThumbFromFullScene,
  normalizeHex,
  serializePreviewSceneV1,
  SCENE_ATOM_CAP,
  SCENE_BOND_CAP,
  type PreviewSceneAtomV1,
  type PreviewSceneBondV1,
} from './capsule-preview-scene-store';
import {
  deriveCanonicalPreviewCamera,
} from './capsule-preview-camera';
import { sampleForSilhouette } from './capsule-preview-sampling';
import type { CapsulePreviewAtom3D, CapsulePreviewScene3D } from './capsule-preview-frame';

export interface PublishInput {
  capsuleJson: string;
  /** Null when `shareMode === 'guest'`; a string user id when 'account'.
   *  The runtime invariant is enforced by {@link preparePublishRecord}
   *  and mirrored by the DB CHECK constraint (migration 0011). */
  ownerUserId: string | null;
  shareMode: ShareMode;
  /** ISO timestamp for guest rows; null for account rows. */
  expiresAt: string | null;
  appVersion: string;
}

/** Metadata extracted from a validated capsule file. */
export interface CapsuleShareMetadata {
  format: string;
  version: number;
  kind: string;
  appVersion: string;
  frameCount: number;
  atomCount: number;
  maxAtomCount: number;
  durationPs: number;
  hasAppearance: boolean;
  hasInteraction: boolean;
  title: string | null;
}

/**
 * Prepared record — everything except the public share code.
 * Share code is assigned by the persistence layer during insert,
 * not precomputed, because collision retry may change it.
 *
 * `previewSceneV1Json` carries the serialized V2 preview scene so
 * `persistRecord` can INSERT it verbatim without re-parsing the capsule
 * (spec AC #25). `null` when the capsule is structurally incapable of
 * producing a scene (e.g. kind != 'capsule', no dense frames) — the
 * poster route falls into the terminal-fallback branch in that case.
 */
export interface PreparedPublishRecord {
  id: string;
  objectKey: string;
  ownerUserId: string | null;
  shareMode: ShareMode;
  expiresAt: string | null;
  metadata: CapsuleShareMetadata;
  sha256: string;
  sizeBytes: number;
  blob: Uint8Array;
  previewSceneV1Json: string | null;
}

/** Persisted record — after D1 insert, includes the DB-assigned share code. */
export type PersistedPublishRecord = PreparedPublishRecord & {
  shareCode: string;
};

/**
 * Validate capsule, extract metadata, compute hash, generate record ID and object key.
 * Pure function — no I/O. Does NOT generate a share code (that is a persistence concern).
 *
 * Throws on invalid JSON or failed validation.
 */
export async function preparePublishRecord(
  input: PublishInput,
): Promise<PreparedPublishRecord> {
  // Invariant mirrors the DB CHECK constraint (migration 0011).
  if (input.shareMode === 'account' && input.ownerUserId == null) {
    throw new PublishValidationError('shareMode=account requires ownerUserId');
  }
  if (input.shareMode === 'guest' && input.ownerUserId != null) {
    throw new PublishValidationError('shareMode=guest requires ownerUserId=null');
  }

  // Parse JSON
  let parsed: unknown;
  try {
    parsed = JSON.parse(input.capsuleJson);
  } catch {
    throw new PublishValidationError('Invalid JSON');
  }

  // Validate capsule structure
  const errors = validateCapsuleFile(parsed);
  if (errors.length > 0) {
    throw new PublishValidationError(`Capsule validation failed: ${errors[0]}`);
  }

  const capsule = parsed as AtomDojoPlaybackCapsuleFileV1;

  // Extract metadata
  const metadata: CapsuleShareMetadata = {
    format: capsule.format,
    version: capsule.version,
    kind: capsule.kind,
    appVersion: input.appVersion,
    frameCount: capsule.simulation.frameCount,
    atomCount: capsule.atoms.atoms.length,
    maxAtomCount: capsule.simulation.maxAtomCount,
    durationPs: capsule.simulation.durationPs,
    hasAppearance: capsule.appearance != null,
    hasInteraction: capsule.timeline.interactionTimeline != null,
    title: null, // capsule v1 has no title field; reserved for future use
  };

  // Encode to bytes for hashing and storage
  const encoder = new TextEncoder();
  const blob = encoder.encode(input.capsuleJson);
  const sizeBytes = blob.byteLength;

  // Compute SHA-256 hash
  const hashBuffer = await crypto.subtle.digest('SHA-256', blob);
  const hashArray = new Uint8Array(hashBuffer);
  const sha256 = Array.from(hashArray)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

  // Generate internal record ID (UUID v4)
  const id = crypto.randomUUID();
  const objectKey = `capsules/${id}/capsule.atomdojo`;

  // V2 publish-time pre-bake (spec §S1). Failure here is non-fatal: we
  // want publish to succeed even for structurally-degenerate capsules so
  // the lazy-backfill path (or terminal fallback) handles them at read
  // time instead of blocking the user. Log the failure with a short
  // cause tag for operability.
  const previewSceneV1Json = projectCapsuleToSceneJson(capsule);

  return {
    id,
    objectKey,
    ownerUserId: input.ownerUserId,
    shareMode: input.shareMode,
    expiresAt: input.expiresAt,
    metadata,
    sha256,
    sizeBytes,
    blob,
    previewSceneV1Json,
  };
}

/**
 * Project the capsule's first dense frame into the storage-ready
 * {@link PreviewSceneV1} JSON. Returns null on any failure — the caller
 * stores that null, and the poster route lazy-backfills from R2 or
 * serves the terminal fallback.
 *
 * Exported so the backfill script can reuse the same projection logic
 * without duplicating error handling.
 */
export function projectCapsuleToSceneJson(
  capsule: AtomDojoPlaybackCapsuleFileV1,
): string | null {
  try {
    const fullScene3d = buildPreviewSceneFromCapsule(capsule);

    // Derive bonds on the FULL atom set, BEFORE downsampling, using
    // the SAME rule as lab/watch (`buildBondTopologyFromAtoms` with
    // a single-cutoff `BondRuleSet`). This guarantees the preview's
    // bond list is physically realistic — determined in 3D before
    // projection, not inferred from 2D positions after the z axis
    // has been discarded. Cutoff + minDist honor any `bondPolicy`
    // carried by the capsule file.
    let fullBondPairs: Array<{ a: number; b: number }> = [];
    try {
      const rules = createBondRules({
        cutoff: capsule.bondPolicy?.cutoff ?? 1.85,
        minDist: capsule.bondPolicy?.minDist ?? 0.5,
      });
      const tuples = buildBondTopologyFromAtoms(fullScene3d.atoms, rules);
      // `tuples[i]` = [a, b, distance]; preview keeps only the index
      // pair (a, b) — the renderer computes its own projected length.
      fullBondPairs = tuples.map((t) => ({ a: t[0], b: t[1] }));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[publish] bonds-skipped: ${msg}`);
    }

    // Subject-cluster selection (ADR D138). Picks the largest bonded
    // cluster when the dominance guard accepts it; otherwise the full
    // frame. Both poster and thumb source the selected subject so they
    // represent the same physical subject.
    const subject = selectPreviewSubjectCluster(fullScene3d, fullBondPairs, {
      mode: 'largest-bonded-cluster',
    });
    {
      const d = subject.diagnostics;
      console.info(
        `[publish] cluster-select: mode=${d.mode}`
          + ` size=${d.selectedAtomCount}/${d.fullFrameAtomCount}`
          + ` components=${d.componentCount}`
          + ` meaningful=${d.meaningfulComponentCount}`
          + ` fallback=${d.fellBackToFullFrame}`
          + ` reason=${d.fallbackReason}`,
      );
    }
    const scene3d = subject.scene;
    const selectedBondPairs = subject.bondPairs;

    // Snapshot the pre-sample atom array (post-cluster-select) so bond
    // indices — which reference it — translate correctly even when the
    // sampler mutates `scene3d.atoms` below.
    const preSampleAtoms: ReadonlyArray<CapsulePreviewAtom3D> = scene3d.atoms.slice();

    // Mutable working copy for the sampled poster path. Keeping the
    // cluster-selected scene immutable lets the full-atoms thumb path
    // below reuse `preSampleAtoms` verbatim.
    const posterScene3d = { ...scene3d, atoms: scene3d.atoms.slice() };

    // Server-side downsample so the projected scene is always ≤ SCENE_ATOM_CAP
    // atoms regardless of how dense the capsule is. Silhouette-preserving
    // sampler (extrema + farthest-point in 3D) keeps the structure's
    // envelope + representative interior atoms.
    if (posterScene3d.atoms.length > SCENE_ATOM_CAP) {
      posterScene3d.atoms = sampleForSilhouette<CapsulePreviewAtom3D>(
        posterScene3d.atoms,
        SCENE_ATOM_CAP,
        (a) => a.x,
        (a) => a.y,
        (a) => a.z,
      );
    }

    // PERSPECTIVE projection target, SQUARE 600×600.
    //
    // The poster-scene bake used to be orthographic (`projectPreviewScene`)
    // so every atom rendered at one uniform radius — the "structural
    // diagram" framing at V2 launch. That framing is deprecated:
    // under D135 follow-up 4 (2026-04-21) the poster scene moves to
    // pinhole perspective so both the OG poster AND the account-row
    // thumb carry the same depth cues. Two reasons:
    //
    //   1. Product consistency. The thumb bake has always been
    //      perspective (`projectPreviewScenePerspective`, square 500×500);
    //      having the poster be orthographic meant a front-page share
    //      image looked structurally different from the profile thumb
    //      of the same capsule. The user-facing product voice is "3D
    //      molecular figure with depth", not "diagram for one surface
    //      and 3D figure for the other".
    //
    //   2. The downstream renderer (`CurrentPosterSceneSvg`) already
    //      applies `perspectiveMultiplier(a.r, rMedian)` to stored
    //      per-atom radii. Under an orthographic bake every atom had
    //      identical `r`, so the multiplier collapsed to ≈ 1 and the
    //      code was dead. Swapping to the perspective bake lets the
    //      stored `a.r` carry real depth scaling and the renderer's
    //      existing ±15% clamp is what it was built for.
    //
    // Square target + isotropic normalization in `buildPreviewSceneV1`
    // (uniform `/600` on both axes) keeps the aspect-ratio fix from
    // follow-up 3 intact — the perspective projector also does its
    // own aspect-preserving fit into the padded target box, so
    // spherical subjects stay round and anisotropic subjects stay
    // correctly proportioned.
    const projected = projectPreviewScenePerspective(posterScene3d, {
      targetWidth: 600,
      targetHeight: 600,
      padding: 0.1,
    });

    // Translate selected bond pairs (indexed into `preSampleAtoms`) into
    // projected-atom-index space via the shared helper. The helper maps
    // atomId → projectedIndex; bonds whose endpoints didn't both survive
    // sampling are silently dropped — atoms-only is a valid fallback.
    const preSampleScene: CapsulePreviewScene3D = { ...scene3d, atoms: preSampleAtoms.slice() };
    const projectedBonds = selectedBondPairs.length > 0
      ? deriveBondPairsForProjectedScene(
          preSampleScene, projected, 0, 0,
          { precomputedRawPairs: selectedBondPairs },
        )
      : [];
    const bonds: Array<{ a: number; b: number }> = [];
    for (const pair of projectedBonds) {
      bonds.push({ a: pair.a, b: pair.b });
      if (bonds.length >= SCENE_BOND_CAP) break;
    }

    let stored = buildPreviewSceneV1(projected, bonds);

    // Build the stored thumb payload from the selected-subject atoms
    // (pre-sample — not the 32-atom poster scene). This avoids the
    // 60 → 32 → 12 double-downsampling cascade that would destroy
    // recognizable topology for dense structures like C60 cages.
    //
    // **Perspective bake (Path A).** The thumb path uses the pinhole
    // perspective projection (K per `PERSPECTIVE_K_DEFAULT`, currently
    // 3.17) so per-atom radii carry depth cues — nearest atoms
    // render larger, farthest render smaller. As of D135 follow-up 4
    // (2026-04-21) the POSTER scene above ALSO uses perspective
    // (`projectPreviewScenePerspective` at the 600×600 target), so
    // both surfaces share the same depth-cue contract. The two
    // payloads remain distinct because their downstream surfaces
    // are different: the poster targets a 1200×630 OG card at
    // 600×600 bake resolution, while the thumb targets a 96×96
    // account-row cell at 500×500 bake resolution with a chunkier
    // base atom radius (22 vs. the poster's density-aware default).
    // Stored `thumb.atoms[*].r` (like `scene.atoms[*].r`) carries
    // the per-atom scaled radius; the renderer honors stored r in
    // bonded mode so the paint reflects the bake.
    const fullProjected = projectPreviewScenePerspective(
      preSampleScene,
      {
        // SQUARE projection target — the account-row thumb cell is
        // 96 × 96 (square). The previous 600 × 500 target produced
        // near-isotropic pixel bounds for spherical subjects, but
        // the downstream `x / 600, y / 500` normalization then
        // warped them to a 1.2:1 tall aspect. Using a square
        // target + uniform `/size` normalization keeps C60
        // looking round.
        targetWidth: 500,
        targetHeight: 500,
        padding: 0.1,
        // 0.8× of the previous 28 → 22 px at publish time. At
        // 96 px account-row scale that lands near atoms at ~4.4
        // viewBox radius (≈ 4.2 physical px) — still clearly
        // shaded spheres, but no longer so chunky that they pile
        // up over each other's silhouettes on dense scenes.
        baseAtomRadius: 22,
      },
    );
    const fullProjectedBonds = selectedBondPairs.length > 0
      ? deriveBondPairsForProjectedScene(
          preSampleScene, fullProjected, 0, 0,
          { precomputedRawPairs: selectedBondPairs },
        )
      : [];
    const fullBondsProjectedSpace: PreviewSceneBondV1[] = fullProjectedBonds.map(
      (p) => ({ a: p.a, b: p.b }),
    );
    // Isotropic normalization — MUST match the perspective
    // projection's target dimensions (set to 500 × 500 above) so
    // an isotropic 3D subject stays isotropic in storage. A mixed
    // `/600 / /500` here warped spheres into 1.2:1 talls.
    const fullNormAtoms: PreviewSceneAtomV1[] = fullProjected.atoms.map((a) => ({
      x: a.x / 500,
      y: a.y / 500,
      r: a.r / 500,
      c: normalizeHex(a.colorHex),
    }));
    // Narrow try around only the thumb builder — if it throws (sampler
    // edge case, visibility-filter NaN, etc.) the poster scene is still
    // valid and we publish without the thumb pre-bake. Old read-path
    // sampling will kick in as the fallback.
    try {
      // Effectively-uncapped bake: keep every bond whose endpoints
      // both survived sampling, with no degree cap and NO
      // projection-occlusion gating. `NEGATIVE_INFINITY` on the
      // visibility thresholds sidesteps the filter at line 748–749
      // of `buildBondedLayoutCore` — for a dense 3D cluster the
      // back-hemisphere atoms project onto the front-hemisphere
      // atoms, so `projected_bond_length < (r_a + r_b)` for most
      // bonds and a threshold of `0` silently drops them all. The
      // renderer handles occlusion correctly via the depth-sorted
      // paint list; there is no reason to pre-filter at the bake.
      //
      // `bondsAwareThreshold: 0` bypasses the `n >= 14` atom-count
      // guard inside `buildStoredThumbFromFullScene` — that guard
      // was tuned for the old 40 px thumb where 3–5 atoms +
      // sub-pixel bonds read as dots anyway. At 96 px thumb and
      // 600 px poster, small-cluster capsules (glycine-class)
      // absolutely benefit from their bonds being drawn.
      const thumb = buildStoredThumbFromFullScene(
        fullNormAtoms, fullBondsProjectedSpace,
        {
          minVisibleBondViewbox: Number.NEGATIVE_INFINITY,
          relaxedVisibleBondViewbox: Number.NEGATIVE_INFINITY,
          minAcceptableBonds: 0,
          bondMaxDegree: Number.POSITIVE_INFINITY,
          bondsAwareThreshold: 0,
        },
      );
      if (thumb) stored = attachStoredThumb(stored, thumb);
    } catch (err) {
      const errName = err instanceof Error ? err.name : typeof err;
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(
        `[publish] stored-thumb-skipped: ${errName}:${msg}` +
          ` atoms=${fullNormAtoms.length} bonds=${fullBondsProjectedSpace.length}`,
      );
    }

    return serializePreviewSceneV1(stored);
  } catch (err) {
    const msg = err instanceof PreviewSceneBuildException
      ? err.message
      : err instanceof Error ? err.message : String(err);
    console.warn(`[publish] preview-scene-skipped: ${msg}`);
    return null;
  }
}

/**
 * Insert a D1 row with collision-safe share code generation.
 * Generates a code, attempts insert, retries up to 5 times on UNIQUE conflict.
 * Returns the persisted record including the DB-assigned share code.
 */
export async function persistRecord(
  db: D1Database,
  record: PreparedPublishRecord,
): Promise<PersistedPublishRecord> {
  const now = new Date().toISOString();
  const m = record.metadata;
  const MAX_RETRIES = 5;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const code = generateShareCode();
    try {
      await db
        .prepare(
          `INSERT INTO capsule_share (
            id, share_code, status, owner_user_id, object_key,
            format, version, kind, app_version, sha256,
            size_bytes, frame_count, atom_count, max_atom_count, duration_ps,
            has_appearance, has_interaction, title,
            preview_status, preview_scene_v1,
            share_mode, expires_at,
            created_at, uploaded_at, published_at
          ) VALUES (
            ?, ?, ?, ?, ?,
            ?, ?, ?, ?, ?,
            ?, ?, ?, ?, ?,
            ?, ?, ?,
            ?, ?,
            ?, ?,
            ?, ?, ?
          )`,
        )
        .bind(
          record.id,
          code,
          'ready' satisfies ShareRecordStatus,
          record.ownerUserId,
          record.objectKey,
          m.format,
          m.version,
          m.kind,
          m.appVersion,
          record.sha256,
          record.sizeBytes,
          m.frameCount,
          m.atomCount,
          m.maxAtomCount,
          m.durationPs,
          m.hasAppearance ? 1 : 0,
          m.hasInteraction ? 1 : 0,
          m.title,
          'none' satisfies PreviewStatus,
          record.previewSceneV1Json,
          record.shareMode,
          record.expiresAt,
          now,
          now,
          now,
        )
        .run();

      return { ...record, shareCode: code };
    } catch (err: unknown) {
      if (isUniqueConstraintError(err)) continue;
      throw err;
    }
  }
  throw new Error(
    'Failed to generate a unique share code after 5 attempts',
  );
}

/** Error class for validation failures — distinguishable from system errors. */
export class PublishValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PublishValidationError';
  }
}

function isUniqueConstraintError(err: unknown): boolean {
  if (err instanceof Error) {
    const msg = err.message.toLowerCase();
    return msg.includes('unique') || msg.includes('constraint');
  }
  return false;
}
