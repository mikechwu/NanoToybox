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
import type { ShareRecordStatus, PreviewStatus } from './share-record';
import {
  buildPreviewSceneFromCapsule,
  PreviewSceneBuildException,
} from './capsule-preview-frame';
import {
  projectPreviewScene,
  deriveBondPairs,
} from './capsule-preview-project';
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
import type { CapsulePreviewAtom3D } from './capsule-preview-frame';

export interface PublishInput {
  capsuleJson: string;
  ownerUserId: string;
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
  ownerUserId: string;
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
    const scene3d = buildPreviewSceneFromCapsule(capsule);

    // Derive bonds on the FULL atom set, BEFORE downsampling. Bond pairs
    // reflect real nearest-neighbor connectivity in the source structure;
    // if we sampled first and then computed bonds, the silhouette
    // sampler's "spread atoms apart" objective would leave almost no
    // pairs under the cutoff, and the poster + thumb would both lose
    // the bonds that define the structure.
    let fullBondPairs: Array<{ a: number; b: number }> = [];
    try {
      fullBondPairs = deriveBondPairs(
        scene3d,
        capsule.bondPolicy?.cutoff ?? 1.85,
        capsule.bondPolicy?.minDist ?? 0.5,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[publish] bonds-skipped: ${msg}`);
    }

    // Snapshot the pre-sample atom array so bond-pair indices (which
    // reference it) can be translated through to the final projected
    // atom order even when the sampler mutates `scene3d.atoms`.
    const preSampleAtoms: ReadonlyArray<CapsulePreviewAtom3D> = scene3d.atoms.slice();

    // Server-side downsample so the projected scene is always ≤ SCENE_ATOM_CAP
    // atoms regardless of how dense the capsule is. Silhouette-preserving
    // sampler (extrema + farthest-point in 3D) keeps the structure's
    // envelope + representative interior atoms.
    if (scene3d.atoms.length > SCENE_ATOM_CAP) {
      scene3d.atoms = sampleForSilhouette<CapsulePreviewAtom3D>(
        scene3d.atoms,
        SCENE_ATOM_CAP,
        (a) => a.x,
        (a) => a.y,
        (a) => a.z,
      );
    }

    const projected = projectPreviewScene(scene3d, {
      targetWidth: 600,
      targetHeight: 500,
      padding: 0.1,
    });

    // Translate bond pairs from pre-sample space to projected-atom space
    // via atomId. Any bond whose endpoints didn't both survive sampling
    // is silently dropped — atoms-only scenes are a valid fallback, and
    // over-connecting to non-kept atoms would produce ghost edges.
    const bonds: Array<{ a: number; b: number }> = [];
    if (fullBondPairs.length > 0) {
      const atomIdToProjectedIndex = new Map<number, number>();
      for (let i = 0; i < projected.atoms.length; i++) {
        atomIdToProjectedIndex.set(projected.atoms[i].atomId, i);
      }
      for (const pair of fullBondPairs) {
        const aId = preSampleAtoms[pair.a]?.atomId;
        const bId = preSampleAtoms[pair.b]?.atomId;
        if (aId == null || bId == null) continue;
        const ia = atomIdToProjectedIndex.get(aId);
        const ib = atomIdToProjectedIndex.get(bId);
        if (ia == null || ib == null) continue;
        bonds.push({ a: ia, b: ib });
        if (bonds.length >= SCENE_BOND_CAP) break;
      }
    }

    let stored = buildPreviewSceneV1(projected, bonds);

    // Build the stored thumb payload from the FULL pre-sample atom set
    // (not the 32-atom poster scene). This avoids the 60 → 32 → 12
    // double-downsampling cascade that destroys recognizable topology
    // for dense structures like C60 cages. The helper projects the
    // FULL atoms into the thumb cell directly and selects bonds whose
    // endpoints both survive its own sampling pass.
    // Project + translate bonds from the FULL pre-sample atom set. These
    // steps use the same routines as the poster-scene path above; if any
    // throw, it's a real upstream bug and should surface via the outer
    // catch with a `preview-scene-skipped` tag, not be collapsed to
    // `stored-thumb-skipped`.
    const fullProjected = projectPreviewScene(
      { ...scene3d, atoms: preSampleAtoms.slice() },
      { targetWidth: 600, targetHeight: 500, padding: 0.1 },
    );
    const fullIdToIdx = new Map<number, number>();
    for (let i = 0; i < fullProjected.atoms.length; i++) {
      fullIdToIdx.set(fullProjected.atoms[i].atomId, i);
    }
    const fullBondsProjectedSpace: PreviewSceneBondV1[] = [];
    for (const pair of fullBondPairs) {
      const aId = preSampleAtoms[pair.a]?.atomId;
      const bId = preSampleAtoms[pair.b]?.atomId;
      if (aId == null || bId == null) continue;
      const ia = fullIdToIdx.get(aId);
      const ib = fullIdToIdx.get(bId);
      if (ia == null || ib == null) continue;
      fullBondsProjectedSpace.push({ a: ia, b: ib });
    }
    const fullNormAtoms: PreviewSceneAtomV1[] = fullProjected.atoms.map((a) => ({
      x: a.x / 600,
      y: a.y / 500,
      r: a.r / Math.min(600, 500),
      c: normalizeHex(a.colorHex),
    }));
    // Narrow try around only the thumb builder — if it throws (sampler
    // edge case, visibility-filter NaN, etc.) the poster scene is still
    // valid and we publish without the thumb pre-bake. Old read-path
    // sampling will kick in as the fallback.
    try {
      const thumb = buildStoredThumbFromFullScene(
        fullNormAtoms, fullBondsProjectedSpace,
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
            created_at, uploaded_at, published_at
          ) VALUES (
            ?, ?, ?, ?, ?,
            ?, ?, ?, ?, ?,
            ?, ?, ?, ?, ?,
            ?, ?, ?,
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
