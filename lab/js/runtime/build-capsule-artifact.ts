/**
 * Capsule artifact builder — produces a validated JSON-serialized
 * capsule for a given frame-index range (or the full snapshot).
 *
 * Extracted from main.ts so the critical guards (identity-stale,
 * snapshot-version, range-bounds) can be exercised in isolation
 * without booting the renderer / worker / Zustand store.
 *
 * Guard ordering (LOAD-BEARING):
 *   1. identity-stale — matches the existing `buildExportArtifact('capsule')`
 *      precondition; surfaces as a generic Error so the higher-level
 *      caller can surface the "Export is unavailable" copy.
 *   2. snapshot-version recheck when `range` is supplied — throws
 *      `CapsuleSnapshotStaleError` so the trim UI abort path fires.
 *   3. empty-frames defense when `range` is supplied — also throws
 *      `CapsuleSnapshotStaleError` because a concurrent `clear()`
 *      between the version check and the snapshot read would put
 *      us here.
 *   4. range bounds — delegated to `sliceExportSnapshotToCapsuleFrameRange`.
 */

import {
  buildCapsuleHistoryFile,
  sliceExportSnapshotToCapsuleFrameRange,
  type TimelineExportData,
} from './timeline/history-export';
import {
  validateCapsuleFile,
  type AtomDojoPlaybackCapsuleFileV1,
} from '../../../src/history/history-file-v1';
import { CapsuleSnapshotStaleError } from './publish-errors';
import type { CapsuleArtifact } from './publish-capsule-artifacts';
import type {
  CapsuleSelectionRange,
  CapsuleSnapshotId,
} from './timeline/capsule-publish-types';
import type { AtomMetadataEntry } from './timeline/atom-metadata-registry';

export interface BuildCapsuleArtifactDeps {
  /** True when identity tracking has been invalidated by worker
   *  compaction without a keep[] mapping — capsule export is not
   *  viable until the next clean reset. */
  isIdentityStale: () => boolean;
  /** Combined capsule export input version (string tuple). Read
   *  before and after the snapshot pull; a mismatch means someone
   *  mutated a capsule input while we were composing. */
  getCapsuleExportInputVersion: () => CapsuleSnapshotId;
  /** Cloned export snapshot of the timeline, safe to serialize. */
  getTimelineExportSnapshot: () => TimelineExportData;
  /** Atom metadata table for the `atoms` section of the envelope. */
  getAtomTable: () => AtomMetadataEntry[];
  /** Bonded-group color assignments for the optional `appearance`
   *  section. Projected into the capsule as-is in store order. */
  getColorAssignments: () => { atomIds: number[]; colorHex: string }[];
  /** App version string recorded on the envelope's `producer`. */
  appVersion: string;
}

/**
 * Build a validated capsule artifact for the given frame-index
 * range, or the full snapshot when `range` is null.
 *
 * Returns null ONLY when the snapshot has no dense frames AND no
 * range was supplied (i.e. "nothing to publish yet" — not an error).
 *
 * Throws:
 *   · Error on identity-stale.
 *   · CapsuleSnapshotStaleError on version mismatch or empty frames
 *     under a non-null range.
 *   · Error on validation failure.
 *   · Error from `sliceExportSnapshotToCapsuleFrameRange` on invalid
 *     range bounds.
 */
export function buildCapsuleArtifact(
  deps: BuildCapsuleArtifactDeps,
  range: CapsuleSelectionRange | null,
): CapsuleArtifact | null {
  // 1. Identity-stale: matches the existing buildExportArtifact('capsule')
  //    precondition; throwing lets the caller surface the existing
  //    "Export is unavailable because atom identity is stale…" copy.
  if (deps.isIdentityStale()) {
    throw new Error('Export is unavailable because atom identity is stale after worker compaction.');
  }

  // 2. Snapshot-version recheck: a range is only valid against the
  //    version it was captured at. Mismatch means the user moved on
  //    before we could build — abort the trim session gracefully.
  if (range) {
    const current = deps.getCapsuleExportInputVersion();
    if (range.snapshotId !== current) {
      throw new CapsuleSnapshotStaleError();
    }
  }

  const snapshot = deps.getTimelineExportSnapshot();

  // 3. Defensive empty-frames check for non-null ranges — even with
  //    matching snapshotId, a concurrent `clear()` between the
  //    version check above and getTimelineExportSnapshot would leave
  //    us with zero frames. Throw the typed stale error so the
  //    recoverable trim-abort path fires, rather than surfacing as
  //    a generic Error from the slice helper.
  if (range && snapshot.denseFrames.length === 0) {
    throw new CapsuleSnapshotStaleError();
  }

  // 4. Range bounds: slice BEFORE buildCapsuleHistoryFile so
  //    interaction events only reference retained frames (plan §2
  //    ordering rule — Watch's importer rejects orphan events).
  const effective = range
    ? sliceExportSnapshotToCapsuleFrameRange(snapshot, {
        startFrameIndex: range.startFrameIndex,
        endFrameIndex: range.endFrameIndex,
      })
    : snapshot;

  const file: AtomDojoPlaybackCapsuleFileV1 | null = buildCapsuleHistoryFile({
    getTimelineExportData: () => effective,
    getAtomTable: deps.getAtomTable,
    getColorAssignments: deps.getColorAssignments,
    appVersion: deps.appVersion,
  });
  if (!file) return null;

  const errors = validateCapsuleFile(file);
  if (errors.length > 0) throw new Error(`Validation failed: ${errors[0]}`);

  const json = JSON.stringify(file);
  const bytes = new TextEncoder().encode(json).byteLength;
  return { file, json, bytes };
}
