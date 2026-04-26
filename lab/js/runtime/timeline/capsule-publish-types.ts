/**
 * Capsule publish — shared types.
 *
 * Consumed by app-store (callback shapes), timeline-subsystem (subsystem
 * methods), TimelineBar (trim UI state), main.ts (artifact builder + cache),
 * and prepared-capsule-service (preparation factory).
 *
 * This module is dependency-free (no React, no Zustand, no main-thread
 * side effects) so every layer imports the same canonical shapes without
 * creating circular dependencies.
 */

/**
 * Capsule export input version — string tuple combining every mutable
 * input the capsule artifact reads from. Format:
 *   `${frameVersion}:${metadataVersion}:${appearanceVersion}:${policyVersion}`
 *
 * policyVersion is the constant `0` in v1 (bond policy has no runtime
 * edit path today). Each component counter is monotonically increasing
 * for its owner's lifetime and never reset — even `clear()` bumps it.
 * Equality is plain string equality; no hashing, no summing, no collision
 * risk.
 */
export type CapsuleSnapshotId = string;

export interface CapsuleFrameIndex {
  snapshotId: CapsuleSnapshotId;
  /** Lightweight projection of the dense-frame array. Chronological,
   *  no holes. Frozen for the lifetime of the trim session. */
  frames: ReadonlyArray<{ frameId: number; timePs: number }>;
}

export interface CapsuleSelectionRange {
  snapshotId: CapsuleSnapshotId;
  startFrameIndex: number;
  /** Inclusive end index. */
  endFrameIndex: number;
}

export interface PreparedCapsuleSummary {
  /** Opaque token. Required for the publish call. Single-use; evicted
   *  after publish or cancel. */
  prepareId: string;
  bytes: number;
  /** Hard cap. Null when no trustworthy source exists. See maxSource. */
  maxBytes: number | null;
  /** Where `maxBytes` came from:
   *    'server'          — PublishOversizeError.maxBytes (parsed 413 body
   *                        or X-Max-Publish-Bytes header).
   *    'client-fallback' — local MAX_PUBLISH_BYTES; render copy honestly.
   *    'unknown'         — neither parsed; render no denominator.
   *  Local measurement always returns 'client-fallback' — the local
   *  constant is never silently treated as a server confirmation. */
  maxSource: 'server' | 'client-fallback' | 'unknown';
  frameCount: number;
}

/**
 * UI-held wrapping of a prepared capsule, including the range it was
 * prepared for so the trim UI can prove identity before reuse.
 *
 * Scope: USED ONLY BY THE UI LAYER (TimelineBar). Defined here for
 * consistency, but prepared-capsule-service.ts, main.ts, and the
 * subsystem do NOT import it — the service's API surface is
 * PreparedCapsuleSummary.
 */
export type HeldPreparedCapsule = PreparedCapsuleSummary & {
  range: CapsuleSelectionRange;
};

/**
 * Trim entry kind. Drives whether the preparation layer auto-prepares
 * on entry (`oversize` → measurement is required up front) or sits in a
 * deferred-measurement state until submit (`manual`).
 */
export type TrimEntryKind = 'manual' | 'oversize';

/**
 * Measurement policy. A stored value only — the preparation layer reads
 * it to decide whether to fire a prepare on entry. Selection-layer code
 * never calls prepare itself.
 *
 *   - `deferred` — manual trim. Range may exist with no prepared
 *                  artifact and no measured bytes; that is a valid
 *                  non-error state, not a half-broken loading case.
 *   - `required` — oversize trim. Auto-prepare on entry; default
 *                  selection search runs.
 */
export type TrimMeasurementPolicy = 'deferred' | 'required';

/**
 * UI/session state for an active trim. This is the canonical model the
 * UI consumes; concrete React state (TimelineBar's `shareTrimState`)
 * may carry additional view-only fields, but every load-bearing field
 * here must be present and behave per this contract.
 *
 * `CapsuleTrimUiState` is distinct from the *preparation service* in
 * `prepared-capsule-service.ts` — the two never share a module or a
 * name. The UI never owns fetch behavior, prepared-cache policy, or
 * submit-target pinning.
 */
export interface CapsuleTrimUiState {
  entryKind: TrimEntryKind;
  measurementPolicy: TrimMeasurementPolicy;
  snapshotId: CapsuleSnapshotId;
  frames: CapsuleFrameIndex['frames'];
  selection: CapsuleSelectionRange;
  /** Null is a first-class state under `measurementPolicy = 'deferred'`. */
  preparedArtifact: HeldPreparedCapsule | null;
  /** Null is a first-class state under `measurementPolicy = 'deferred'`. */
  measuredBytes: number | null;
  status: 'idle' | 'preparing' | 'ready' | 'over-limit' | 'unavailable';
}
