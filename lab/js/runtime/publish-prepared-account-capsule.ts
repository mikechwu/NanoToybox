/**
 * Account-mode prepared-publish executor.
 *
 * Calls `assertPreparedCapsuleFresh(prepareId)` on the prepared-capsule
 * service BEFORE network I/O, then POSTs the cached bytes via the
 * shared `postAccountCapsuleArtifact`.
 *
 * Mode-isolated by design: this module imports neither
 * `ShareResultGuest` nor any guest error type. Submit-target
 * resolution is the publish layer's responsibility (see
 * `trim-submit-coordinator.ts`); this executor never branches on auth
 * status, public config, or Turnstile state.
 *
 * ## Cache eviction policy (success-only)
 *
 * The Phase 1 auth-transition contract (architecture report §G) is
 * that mid-trim auth/config transitions preserve the prepared
 * artifact. A 401/AuthRequiredError, 428/AgeConfirmationRequiredError,
 * transient 5xx, or network blip MUST leave the cached prepareId in
 * place so the user can retry the same trimmed selection after
 * re-auth without rebuilding the capsule.
 *
 * The executor therefore evicts ONLY on the success path. Other
 * eviction sources, by ownership:
 *
 *   - **Snapshot-stale** — `assertPreparedCapsuleFresh` (called above
 *     the POST, before any network I/O) evicts internally and throws
 *     `CapsuleSnapshotStaleError` when the recording moved. The
 *     cached bytes are no longer safe to POST against the current
 *     scene, so eviction is correct there.
 *   - **Explicit cancel / reset / dialog close / new selection** —
 *     `TimelineBar` calls `onCancelPreparedCapsule` from its
 *     teardown paths.
 *   - **Cache LRU bound** — `prepared-capsule-service` evicts the
 *     oldest entry when `maxCacheEntries` is exceeded; bounds any
 *     pathological retry loop without changing the per-error policy.
 */

import type { ShareResultAccount } from '../../../src/share/share-result';
import type { PreparedCapsuleService } from './prepared-capsule-service';
import { postAccountCapsuleArtifact } from './post-account-capsule';

export interface PublishPreparedAccountDeps {
  service: PreparedCapsuleService;
  /** Injected so unit tests can stub the POST without globals. */
  postAccount?: typeof postAccountCapsuleArtifact;
}

export function createPublishPreparedAccountCapsule(
  deps: PublishPreparedAccountDeps,
): (prepareId: string) => Promise<ShareResultAccount> {
  const post = deps.postAccount ?? postAccountCapsuleArtifact;
  return async function publishPreparedAccountCapsule(
    prepareId: string,
  ): Promise<ShareResultAccount> {
    // Snapshot recheck is the SOLE owner of staleness validation —
    // service throws CapsuleSnapshotStaleError on mismatch and evicts
    // the entry. Executors never inline-compare snapshotIds.
    deps.service.assertPreparedCapsuleFresh(prepareId);
    const artifact = deps.service.getPreparedCapsuleArtifact(prepareId);
    // Recoverable POST errors propagate to the caller WITHOUT
    // evicting — the user may retry the same prepareId after
    // re-auth / age-confirmation / network recovery.
    const result = await post(artifact);
    deps.service.cancelPreparedPublish(prepareId);
    return result;
  };
}
