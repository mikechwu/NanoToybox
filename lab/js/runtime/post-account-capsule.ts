/**
 * Account-mode POST helper.
 *
 * Single owner of fetch + 401/413/428/429/generic error branching for
 * the auth-path publish endpoint (`/api/capsules/publish`). Both the
 * full-history account publish (in `main.ts`) and the prepared-publish
 * executor (`publish-prepared-account-capsule.ts`) call this function,
 * so server-error semantics cannot drift between them.
 *
 * Mode-specific by design — the guest path has its own helper in
 * `post-guest-capsule.ts`. Account error mapping (AuthRequiredError,
 * AgeConfirmationRequiredError) lives here and never crosses into the
 * guest module.
 *
 * Uses `artifact.bytes` directly for the preflight check — no
 * re-measurement — so byte-identity (measured == POSTed) holds by
 * construction.
 */

import type { CapsuleArtifact } from './prepared-capsule-service';
import { PublishOversizeError } from './publish-errors';
import type { ShareResultAccount } from '../../../src/share/share-result';
import { MAX_PUBLISH_BYTES } from '../../../src/share/constants';
import {
  formatPayloadTooLargeMessage,
  parsePayloadTooLargeDetails,
} from './publish-size';
import { AuthRequiredError, AgeConfirmationRequiredError } from './auth-runtime';

export async function postAccountCapsuleArtifact(
  artifact: CapsuleArtifact,
): Promise<ShareResultAccount> {
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
      } catch (err) {
        // Body parse failure is best-effort: the top-level 428 error
        // is still surfaced. Logged so an unparseable body looks
        // different from a body-omitted 428 in support tickets.
        console.warn('[publish] POST_ACCOUNT_428_BODY_PARSE_FAILED:', err);
      }
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
    try {
      detail = (await res.text()) || detail;
    } catch (err) {
      // Text body unreadable for the generic non-ok branch — degrade
      // to status-only detail. Logged so the failure doesn't look
      // identical to a clean status-only response in ops dashboards.
      console.warn(`[publish] POST_ACCOUNT_${res.status}_BODY_READ_FAILED:`, err);
    }
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
