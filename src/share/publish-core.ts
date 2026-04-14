/**
 * Shared publish logic: validation, metadata extraction, hash computation,
 * ID generation, and collision-safe D1 insert.
 *
 * Used by both the publish endpoint (functions/api/capsules/publish.ts)
 * and the admin seed tool (functions/api/admin/seed.ts) to ensure
 * seeded and published records are structurally identical.
 *
 * Owns:        preparePublishRecord (pure), persistRecord (D1 insert)
 * Depends on:  src/history/history-file-v1.ts (validateCapsuleFile),
 *              src/share/share-code.ts (generateShareCode)
 * Called by:    functions/api/capsules/publish.ts,
 *              functions/api/admin/seed.ts
 */

import { validateCapsuleFile } from '../history/history-file-v1';
import type { D1Database } from './d1-types';
import type { AtomDojoPlaybackCapsuleFileV1 } from '../history/history-file-v1';
import { generateShareCode } from './share-code';
import type { ShareRecordStatus, PreviewStatus } from './share-record';

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
 */
export interface PreparedPublishRecord {
  id: string;
  objectKey: string;
  ownerUserId: string;
  metadata: CapsuleShareMetadata;
  sha256: string;
  sizeBytes: number;
  blob: Uint8Array;
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

  return {
    id,
    objectKey,
    ownerUserId: input.ownerUserId,
    metadata,
    sha256,
    sizeBytes,
    blob,
  };
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
            preview_status, created_at, uploaded_at, published_at
          ) VALUES (
            ?, ?, ?, ?, ?,
            ?, ?, ?, ?, ?,
            ?, ?, ?, ?, ?,
            ?, ?, ?,
            ?, ?, ?, ?
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
