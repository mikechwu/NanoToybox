/**
 * Prepared-capsule publisher — owns the "build once, POST same bytes"
 * contract that makes the trim-mode byte measurement authoritative.
 *
 * Lives in a small runtime module (not main.ts) so Vitest unit tests
 * can import it without booting the renderer, worker runtime, Zustand
 * store, and auth flow.
 *
 * Responsibilities:
 *   - cache prepared artifact JSON keyed by opaque `prepareId`
 *   - enforce snapshot-version recheck immediately before POST so a
 *     recording mutation between Prepare and Publish cannot send
 *     stale bytes
 *   - evict cache entries on publish success, publish failure, or
 *     explicit cancel
 *
 * The publisher does NOT own:
 *   - the `buildCapsuleArtifact(range)` body (injected — runs identity-
 *     stale guard, snapshot-version validation, bounds check, then
 *     slices and serializes)
 *   - the `fetch` call (injected as `postCapsuleArtifact` so the
 *     non-trim `publishCapsule()` path in main.ts shares identical
 *     server-error semantics)
 *
 * The cache stores the full `{ range, artifact }` entry so the
 * snapshot recheck can compare `range.snapshotId` against the current
 * `getCapsuleExportInputVersion()` BEFORE any network activity.
 */

import {
  CapsuleSnapshotStaleError,
  PublishOversizeError,
} from './publish-errors';
import type {
  CapsuleSelectionRange,
  CapsuleSnapshotId,
  PreparedCapsuleSummary,
} from './timeline/capsule-publish-types';
import type { AtomDojoPlaybackCapsuleFileV1 } from '../../../src/history/history-file-v1';
import { MAX_PUBLISH_BYTES } from '../../../src/share/constants';
import {
  formatPayloadTooLargeMessage,
  parsePayloadTooLargeDetails,
} from './publish-size';
import { AuthRequiredError, AgeConfirmationRequiredError } from './auth-runtime';

export interface CapsuleArtifact {
  file: AtomDojoPlaybackCapsuleFileV1;
  json: string;
  bytes: number;
}

// The prepared-artifact publisher is account-mode only in v1 — guest
// trim is explicitly out of scope (§Frontend Result Contract "Deferred").
// Aliasing to the canonical type keeps the wire contract + UI branching
// aligned with the store/runtime without duplicating the shape.
import type { ShareResultAccount } from '../../../src/share/share-result';
export type PublishResult = ShareResultAccount;

export interface PreparedCapsulePublisherDeps {
  /** Builds the capsule for a given range. Throws on identity-stale,
   *  snapshot-stale, or out-of-range input. May return null only when
   *  no capsule can be built at all (e.g., empty timeline). Tests stub
   *  this with a deterministic fixture so they don't need a real
   *  TimelineSubsystem. */
  buildCapsuleArtifact: (range: CapsuleSelectionRange) => CapsuleArtifact | null;
  /** Reads the combined capsule export input version. Tests stub this
   *  to drive snapshot-stale assertions. */
  getCapsuleExportInputVersion: () => CapsuleSnapshotId;
  /** Single owner of fetch + 401/428/413/429/generic branching. Same
   *  function the no-arg publish path uses — passed in so both code
   *  paths share identical server-error semantics. */
  postCapsuleArtifact: (artifact: CapsuleArtifact) => Promise<PublishResult>;
  /** Opaque token generator. Defaults to crypto.randomUUID(). */
  generatePrepareId?: () => string;
  /** Cache ceiling. Defaults to 4. The trim UI realistically only ever
   *  holds one outstanding `prepareId` at a time — the bound is a
   *  defensive check against runaway leaks. */
  maxCacheEntries?: number;
}

/**
 * Test-only seam exposed on the publisher instance.
 *
 * Stored under a MODULE-LOCAL `Symbol()` so production code cannot
 * reach it at runtime OR at the type layer:
 *   · type layer: the public `PreparedCapsulePublisher` interface
 *     below does not declare the accessor, so
 *     `publisher.__test_only_cacheSize()` does not typecheck.
 *   · runtime: `Symbol()` (unlike `Symbol.for(...)`) is NOT in the
 *     global registry, so an unrelated module cannot re-derive
 *     this key via `Symbol.for('publish-capsule.…')`. Only callers
 *     that explicitly import `TEST_ONLY_CACHE_SIZE` hold the
 *     handle — test files do, production wiring does not.
 */
export const TEST_ONLY_CACHE_SIZE: unique symbol = Symbol('publish-capsule.__test_only_cacheSize');

/**
 * Extra surface the publisher carries internally. Production callers
 * should only ever type against `PreparedCapsulePublisher`.
 */
type PreparedCapsulePublisherInternal = PreparedCapsulePublisher & {
  [TEST_ONLY_CACHE_SIZE](): number;
};

export interface PreparedCapsulePublisher {
  prepareCapsulePublish(range: CapsuleSelectionRange): Promise<PreparedCapsuleSummary>;
  publishPreparedCapsule(prepareId: string): Promise<PublishResult>;
  cancelPreparedPublish(prepareId: string): void;
}

type PreparedCapsuleCacheEntry = {
  /** Includes snapshotId so `publishPreparedCapsule` can recheck
   *  staleness before POST without re-routing through the caller. */
  range: CapsuleSelectionRange;
  artifact: CapsuleArtifact;
};

/**
 * POST a prepared capsule artifact. Single owner of fetch +
 * 401/428/413/429/generic error branching. Both publish paths share
 * this function so server-error semantics cannot drift between them.
 *
 * Uses `artifact.bytes` directly for the preflight check — no
 * re-measurement — so Acceptance #16 (measured bytes == POSTed bytes)
 * holds by construction.
 */
export async function postCapsuleArtifact(artifact: CapsuleArtifact): Promise<PublishResult> {
  // Advisory client-side preflight against the local constant. Under
  // deploy skew the server may enforce a different limit; the server
  // remains authoritative. Throws `PublishOversizeError(source:
  // 'preflight')` so the trim-mode branch in TimelineBar can route
  // this into the trim flow identically to a server 413.
  if (artifact.bytes > MAX_PUBLISH_BYTES) {
    throw new PublishOversizeError({
      actualBytes: artifact.bytes,
      maxBytes: MAX_PUBLISH_BYTES,
      source: 'preflight',
      message: formatPayloadTooLargeMessage({
        actualBytes: artifact.bytes,
        maxBytes: MAX_PUBLISH_BYTES,
      }),
    });
  }

  const res = await fetch('/api/capsules/publish', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: artifact.json,
  });
  if (!res.ok) {
    if (res.status === 401) {
      throw new AuthRequiredError('Your session expired. Sign in to publish again.');
    }
    if (res.status === 428) {
      let policyVersion: string | null = null;
      try {
        const body = await res.json();
        if (body && typeof body.policyVersion === 'string') {
          policyVersion = body.policyVersion;
        }
      } catch { /* fall through */ }
      throw new AgeConfirmationRequiredError(
        'Please confirm you meet the minimum age required in your country of residence before publishing.',
        policyVersion,
      );
    }
    if (res.status === 413) {
      // Structured parser: preserves the trust-tier model from
      // publish-size.ts. `actualBytes` may be null when the server
      // rejected on Content-Length before reading the body;
      // `maxBytes` may be null only when neither the body nor the
      // X-Max-Publish-Bytes header was parseable.
      const details = await parsePayloadTooLargeDetails(res);
      throw new PublishOversizeError({
        actualBytes: details.actualBytes,
        maxBytes: details.maxBytes,
        source: '413',
        message: details.message,
      });
    }
    if (res.status === 429) {
      const retryAfterRaw = res.headers.get('Retry-After');
      const retrySecs = retryAfterRaw === null ? NaN : Number(retryAfterRaw);
      throw new Error(
        Number.isFinite(retrySecs) && retrySecs > 0
          ? `Publish quota exceeded — try again in ${Math.ceil(retrySecs)}s.`
          : 'Publish quota exceeded. Try again later.',
      );
    }
    let detail = `status ${res.status}`;
    try { detail = (await res.text()) || detail; } catch { /* keep status */ }
    throw new Error(`Publish failed: ${detail}`);
  }
  const payload = (await res.json()) as {
    shareCode?: unknown;
    shareUrl?: unknown;
    warnings?: unknown;
  };
  if (typeof payload.shareCode !== 'string' || typeof payload.shareUrl !== 'string') {
    throw new Error('Publish: unexpected server response shape.');
  }
  const warnings = Array.isArray(payload.warnings)
    ? payload.warnings.filter((w): w is string => typeof w === 'string')
    : undefined;
  if (warnings && warnings.length > 0) {
    console.warn('[publish] server reported non-fatal warnings:', warnings);
  }
  return {
    mode: 'account',
    shareCode: payload.shareCode,
    shareUrl: payload.shareUrl,
    ...(warnings && warnings.length > 0 ? { warnings } : {}),
  };
}

function defaultPrepareIdGenerator(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // Sufficient uniqueness for a short-lived in-process cache key.
  return `prep-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function createPreparedCapsulePublisher(
  deps: PreparedCapsulePublisherDeps,
): PreparedCapsulePublisher {
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
      // and overlays it on the status row. See §3c in the plan.
      maxSource: 'client-fallback',
      frameCount: artifact.file.timeline.denseFrames.length,
    };
  }

  async function publishPreparedCapsule(prepareId: string): Promise<PublishResult> {
    const entry = cache.get(prepareId);
    if (!entry) {
      throw new Error(`No prepared capsule found for prepareId ${prepareId}.`);
    }

    // Snapshot-stale recheck BEFORE POST. If any capsule input has
    // changed since prepareCapsulePublish ran, the cached JSON
    // describes a frame set that no longer matches reality — evict and
    // abort. The UI will surface a recoverable "Recording changed"
    // message and the user can retry Publish for a fresh prepare.
    const currentVersion = deps.getCapsuleExportInputVersion();
    if (entry.range.snapshotId !== currentVersion) {
      cache.delete(prepareId);
      throw new CapsuleSnapshotStaleError();
    }

    try {
      const result = await deps.postCapsuleArtifact(entry.artifact);
      cache.delete(prepareId);
      return result;
    } catch (err) {
      // Evict on any error so a retry-with-different-selection doesn't
      // accidentally re-POST the same (failed) bytes.
      cache.delete(prepareId);
      throw err;
    }
  }

  function cancelPreparedPublish(prepareId: string): void {
    cache.delete(prepareId);
  }

  // Object literal carries the Symbol-keyed test-only accessor but
  // up-casts to the narrow public `PreparedCapsulePublisher` on the
  // way out, so production callers never see the test seam. Tests
  // import `TEST_ONLY_CACHE_SIZE` explicitly to reach it.
  const instance: PreparedCapsulePublisherInternal = {
    prepareCapsulePublish,
    publishPreparedCapsule,
    cancelPreparedPublish,
    [TEST_ONLY_CACHE_SIZE]: () => cache.size,
  };
  return instance;
}
