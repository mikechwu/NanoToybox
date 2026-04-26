/**
 * Account-mode prepared-publish executor.
 *
 * Calls `assertPreparedCapsuleFresh(prepareId)` on the prepared-capsule
 * service BEFORE network I/O, then POSTs the cached bytes via the
 * shared `postAccountCapsuleArtifact`. After any outcome (success or
 * failure) it evicts the cache entry so a retry-with-different-
 * selection cannot accidentally re-POST the same bytes.
 *
 * Mode-isolated by design: this module imports neither
 * `ShareResultGuest` nor any guest error type. Submit-target
 * resolution is the publish layer's responsibility (see
 * `trim-submit-coordinator.ts`); this executor never branches on auth
 * status, public config, or Turnstile state.
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
    try {
      const result = await post(artifact);
      deps.service.cancelPreparedPublish(prepareId);
      return result;
    } catch (err) {
      // Evict on any error so a retry cannot accidentally re-POST the
      // same (failed) bytes. Idempotent — a snapshot-stale eviction
      // earlier in the flow is harmless.
      deps.service.cancelPreparedPublish(prepareId);
      throw err;
    }
  };
}
