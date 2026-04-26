/**
 * Guest-mode prepared-publish executor.
 *
 * Calls `assertPreparedCapsuleFresh(prepareId)` on the prepared-capsule
 * service BEFORE network I/O, then POSTs the cached bytes via the
 * shared `postGuestCapsuleArtifact` with the supplied Turnstile
 * token.
 *
 * Mode-isolated by design: this module imports neither
 * `ShareResultAccount` nor any account-only error type
 * (`AgeConfirmationRequiredError`, `AuthRequiredError`). The submit
 * coordinator (`trim-submit-coordinator.ts`) resolves the target +
 * Turnstile token and dispatches here; this executor never reads
 * `authStatus`, `publicConfig`, or any Turnstile widget ref.
 *
 * Byte-identity (Acceptance #8): the bytes posted here are exactly
 * the bytes summarized by `prepareCapsulePublish` for `prepareId`.
 *
 * ## Cache eviction policy (success-only)
 *
 * Mirrors `publish-prepared-account-capsule.ts`. Recoverable submit
 * errors — `GuestTurnstileError` (challenge retry), guest quota
 * exhaustion, transient 5xx, network blip — leave the cached
 * prepareId in place so the user can solve a fresh challenge or wait
 * out the quota window and retry the same trimmed selection without
 * rebuilding the capsule. Eviction sources outside this executor:
 *
 *   - **Snapshot-stale** — `assertPreparedCapsuleFresh` evicts
 *     internally before any network I/O.
 *   - **Explicit cancel / reset / dialog close / new selection** —
 *     `TimelineBar` calls `onCancelPreparedCapsule`.
 *   - **Cache LRU bound** — `prepared-capsule-service` evicts the
 *     oldest entry when `maxCacheEntries` is exceeded.
 */

import type { ShareResultGuest } from '../../../src/share/share-result';
import type { PreparedCapsuleService } from './prepared-capsule-service';
import { postGuestCapsuleArtifact } from './post-guest-capsule';

export interface PublishPreparedGuestDeps {
  service: PreparedCapsuleService;
  /** Injected so unit tests can stub the POST without globals. */
  postGuest?: typeof postGuestCapsuleArtifact;
}

export function createPublishPreparedGuestCapsule(
  deps: PublishPreparedGuestDeps,
): (prepareId: string, turnstileToken: string) => Promise<ShareResultGuest> {
  const post = deps.postGuest ?? postGuestCapsuleArtifact;
  return async function publishPreparedGuestCapsule(
    prepareId: string,
    turnstileToken: string,
  ): Promise<ShareResultGuest> {
    deps.service.assertPreparedCapsuleFresh(prepareId);
    const artifact = deps.service.getPreparedCapsuleArtifact(prepareId);
    // Recoverable POST errors propagate to the caller WITHOUT
    // evicting — the user may retry the same prepareId after solving
    // a fresh Turnstile challenge / waiting out a quota window /
    // network recovery.
    const result = await post(artifact, turnstileToken);
    deps.service.cancelPreparedPublish(prepareId);
    return result;
  };
}
