/**
 * Guest-mode prepared-publish executor.
 *
 * Calls `assertPreparedCapsuleFresh(prepareId)` on the prepared-capsule
 * service BEFORE network I/O, then POSTs the cached bytes via the
 * shared `postGuestCapsuleArtifact` with the supplied Turnstile
 * token. After any outcome (success or failure) it evicts the cache
 * entry so a retry cannot accidentally re-POST the same bytes.
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
    try {
      const result = await post(artifact, turnstileToken);
      deps.service.cancelPreparedPublish(prepareId);
      return result;
    } catch (err) {
      deps.service.cancelPreparedPublish(prepareId);
      throw err;
    }
  };
}
