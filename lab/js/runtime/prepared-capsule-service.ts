/**
 * Prepared-capsule service — mode-neutral preparation layer.
 *
 * The single owner of:
 *   - capsule artifact preparation for a `CapsuleSelectionRange`
 *   - cached prepared bytes keyed by opaque `prepareId`
 *   - byte-identity guarantees (the bytes summarized at prepare time
 *     are exactly the bytes the executor POSTs)
 *   - **snapshot recheck before any prepared reuse** (`assertPreparedCapsuleFresh`)
 *   - prepared-artifact invalidation / cancellation
 *
 * Mode-neutrality is load-bearing: the service does not know whether a
 * prepared artifact will eventually be POSTed to the account or guest
 * endpoint. Submit-target resolution lives in the publish layer
 * (`trim-submit-coordinator` + the two prepared-publish executors); the
 * service exposes a read-only `getPreparedCapsuleArtifact(prepareId)`
 * for executors to consume.
 *
 * Lives in a small runtime module (not main.ts) so Vitest unit tests
 * can import it without booting the renderer, worker runtime, Zustand
 * store, and auth flow.
 *
 * The service does NOT own:
 *   - the `buildCapsuleArtifact(range)` body (injected — runs identity-
 *     stale guard, snapshot-version validation, bounds check, then
 *     slices and serializes)
 *   - any fetch / network I/O — POSTs are owned by the per-mode helpers
 *     in `post-account-capsule.ts` and `post-guest-capsule.ts`, invoked
 *     by the prepared-publish executors after `assertPreparedCapsuleFresh`
 *   - any auth state, Turnstile state, or public config — none of those
 *     belong on the preparation layer
 *
 * The cache stores the full `{ range, artifact }` entry so the
 * snapshot recheck can compare `range.snapshotId` against the current
 * `getCapsuleExportInputVersion()` BEFORE any network activity.
 */

import { CapsuleSnapshotStaleError } from './publish-errors';
import type {
  CapsuleSelectionRange,
  CapsuleSnapshotId,
  PreparedCapsuleSummary,
} from './timeline/capsule-publish-types';
import type { AtomDojoPlaybackCapsuleFileV1 } from '../../../src/history/history-file-v1';
import { MAX_PUBLISH_BYTES } from '../../../src/share/constants';

export interface CapsuleArtifact {
  file: AtomDojoPlaybackCapsuleFileV1;
  json: string;
  bytes: number;
}

export interface PreparedCapsuleServiceDeps {
  /** Builds the capsule for a given range. Throws on identity-stale,
   *  snapshot-stale, or out-of-range input. May return null only when
   *  no capsule can be built at all (e.g., empty timeline). Tests stub
   *  this with a deterministic fixture so they don't need a real
   *  TimelineSubsystem. */
  buildCapsuleArtifact: (range: CapsuleSelectionRange) => CapsuleArtifact | null;
  /** Reads the combined capsule export input version. Tests stub this
   *  to drive snapshot-stale assertions. */
  getCapsuleExportInputVersion: () => CapsuleSnapshotId;
  /** Opaque token generator. Defaults to crypto.randomUUID(). */
  generatePrepareId?: () => string;
  /** Cache ceiling. Defaults to 4. The trim UI realistically only ever
   *  holds one outstanding `prepareId` at a time — the bound is a
   *  defensive check against runaway leaks. */
  maxCacheEntries?: number;
}

/**
 * Test-only seam exposed on the service instance.
 *
 * Stored under a MODULE-LOCAL `Symbol()` so production code cannot
 * reach it at runtime OR at the type layer:
 *   · type layer: the public `PreparedCapsuleService` interface
 *     below does not declare the accessor, so
 *     `service.__test_only_cacheSize()` does not typecheck.
 *   · runtime: `Symbol()` (unlike `Symbol.for(...)`) is NOT in the
 *     global registry, so an unrelated module cannot re-derive
 *     this key via `Symbol.for('prepared-capsule.…')`. Only callers
 *     that explicitly import `TEST_ONLY_CACHE_SIZE` hold the
 *     handle — test files do, production wiring does not.
 */
export const TEST_ONLY_CACHE_SIZE: unique symbol = Symbol('prepared-capsule.__test_only_cacheSize');

/**
 * Extra surface the service carries internally. Production callers
 * should only ever type against `PreparedCapsuleService`.
 */
type PreparedCapsuleServiceInternal = PreparedCapsuleService & {
  [TEST_ONLY_CACHE_SIZE](): number;
};

export interface PreparedCapsuleService {
  /** Build + serialize the candidate capsule once and cache the bytes
   *  under an opaque `prepareId`. The summary's bytes are the bytes a
   *  matching executor will POST — byte-identity is enforced by
   *  construction (no rebuild on publish). */
  prepareCapsulePublish(range: CapsuleSelectionRange): Promise<PreparedCapsuleSummary>;
  /** Evict the cached bytes for `prepareId`. Idempotent. Must be
   *  called on Cancel, Reset, dialog close, snapshot invalidation, and
   *  after any publish attempt completes (success OR failure). */
  cancelPreparedPublish(prepareId: string): void;
  /**
   * Throws `CapsuleSnapshotStaleError` if any capsule input has changed
   * since `prepareId` was prepared (frame / metadata / appearance /
   * policy version composition mismatch). Also throws when the entry
   * is missing entirely (already evicted). On stale detection the
   * entry is evicted as a side effect — the existing reservation can
   * never be reused.
   *
   * Single owner of the snapshot-recheck contract: every prepared-
   * publish executor MUST invoke this BEFORE network I/O. No other
   * module performs an inline `range.snapshotId !== currentVersion`
   * check.
   */
  assertPreparedCapsuleFresh(prepareId: string): void;
  /**
   * Read-only handle for prepared-publish executors. Returns the
   * cached `CapsuleArtifact` so the executor can POST exactly the
   * prepared bytes without rebuilding. Throws when the entry is
   * missing — callers should treat this as a programming error
   * (always pair with `assertPreparedCapsuleFresh` in the same flow,
   * which will throw `CapsuleSnapshotStaleError` first if eviction
   * happened).
   */
  getPreparedCapsuleArtifact(prepareId: string): CapsuleArtifact;
}

type PreparedCapsuleCacheEntry = {
  /** Includes snapshotId so `assertPreparedCapsuleFresh` can recheck
   *  staleness before POST without re-routing through the caller. */
  range: CapsuleSelectionRange;
  artifact: CapsuleArtifact;
};

function defaultPrepareIdGenerator(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // Sufficient uniqueness for a short-lived in-process cache key.
  return `prep-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function createPreparedCapsuleService(
  deps: PreparedCapsuleServiceDeps,
): PreparedCapsuleService {
  const generate = deps.generatePrepareId ?? defaultPrepareIdGenerator;
  const maxEntries = Math.max(1, deps.maxCacheEntries ?? 4);

  // Insertion-ordered Map so "evict oldest" is just `keys().next()`.
  const cache = new Map<string, PreparedCapsuleCacheEntry>();

  async function prepareCapsulePublish(range: CapsuleSelectionRange): Promise<PreparedCapsuleSummary> {
    // buildCapsuleArtifact runs the identity-stale guard, snapshot
    // version validation, and bounds check. Throws on stale/invalid.
    const artifact = deps.buildCapsuleArtifact(range);
    if (!artifact) {
      throw new Error('No recorded history to publish.');
    }

    const prepareId = generate();
    cache.set(prepareId, { range, artifact });

    // Bound: evict the oldest entry if we exceeded the cap. Map
    // iteration order is insertion order.
    while (cache.size > maxEntries) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }

    return {
      prepareId,
      bytes: artifact.bytes,
      maxBytes: MAX_PUBLISH_BYTES,
      // Local measurement is never a server confirmation — the trim
      // session keeps the originating error's 'server' value separately
      // and overlays it on the status row.
      maxSource: 'client-fallback',
      frameCount: artifact.file.timeline.denseFrames.length,
    };
  }

  function cancelPreparedPublish(prepareId: string): void {
    cache.delete(prepareId);
  }

  function assertPreparedCapsuleFresh(prepareId: string): void {
    const entry = cache.get(prepareId);
    if (!entry) {
      // No prepared entry → can never POST stale or fresh bytes; treat
      // as stale so the executor's existing recovery copy fires
      // (eviction may have happened from a concurrent cancel/snapshot
      // bump, both of which are recoverable from the user's POV).
      throw new CapsuleSnapshotStaleError();
    }
    const currentVersion = deps.getCapsuleExportInputVersion();
    if (entry.range.snapshotId !== currentVersion) {
      cache.delete(prepareId);
      throw new CapsuleSnapshotStaleError();
    }
  }

  function getPreparedCapsuleArtifact(prepareId: string): CapsuleArtifact {
    const entry = cache.get(prepareId);
    if (!entry) {
      throw new Error(`No prepared capsule found for prepareId ${prepareId}.`);
    }
    return entry.artifact;
  }

  // Object literal carries the Symbol-keyed test-only accessor but
  // up-casts to the narrow public `PreparedCapsuleService` on the
  // way out, so production callers never see the test seam. Tests
  // import `TEST_ONLY_CACHE_SIZE` explicitly to reach it.
  const instance: PreparedCapsuleServiceInternal = {
    prepareCapsulePublish,
    cancelPreparedPublish,
    assertPreparedCapsuleFresh,
    getPreparedCapsuleArtifact,
    [TEST_ONLY_CACHE_SIZE]: () => cache.size,
  };
  return instance;
}
