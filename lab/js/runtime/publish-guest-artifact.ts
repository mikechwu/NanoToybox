/**
 * Guest Quick Share publisher (anonymous POST path).
 *
 * Mirrors the auth-path byte-identity invariant from
 * {@link ./publish-capsule-artifacts.ts}: the raw capsule JSON is the
 * POST body, and Turnstile/age attestation travel in headers. The
 * measured capsule bytes must equal the POSTed bytes, so we hand the
 * CapsuleArtifact's `json` through unchanged.
 *
 * v1 does NOT support oversize trim (§Oversize Interaction). The
 * Transfer dialog disables `Continue as Guest` above MAX_PUBLISH_BYTES.
 * If the user's capture still makes it here at oversize, we throw the
 * same `PublishOversizeError` shape the auth path uses so the existing
 * error mapping keeps working.
 */

import type { CapsuleArtifact } from './publish-capsule-artifacts';
import { PublishOversizeError } from './publish-errors';
import type { ShareResultGuest } from '../../../src/share/share-result';
import { MAX_PUBLISH_BYTES } from '../../../src/share/constants';
import {
  formatPayloadTooLargeMessage,
  parsePayloadTooLargeDetails,
} from './publish-size';

/** Distinct error types mapped by TimelineBar to user-visible copy.
 *  `kind` is the discriminator TimelineBar's error switch reads. */
export class GuestTurnstileError extends Error {
  readonly kind = 'guest-turnstile' as const;
  readonly detail: 'missing' | 'failed' | 'unavailable';
  constructor(detail: GuestTurnstileError['detail'], message: string) {
    super(message);
    this.name = 'GuestTurnstileError';
    this.detail = detail;
  }
}

export class GuestAgeAttestationError extends Error {
  readonly kind = 'guest-age-attestation' as const;
  constructor(message = 'Please confirm you are at least 13 years old before publishing.') {
    super(message);
    this.name = 'GuestAgeAttestationError';
  }
}

export class GuestQuotaExceededError extends Error {
  readonly kind = 'guest-quota-exceeded' as const;
  /** Seconds from now; null when the server omitted Retry-After. */
  readonly retryAfterSeconds: number | null;
  constructor(retryAfterSeconds: number | null) {
    super('Quick Share limit reached. Try again later or sign in to save links to your account.');
    this.name = 'GuestQuotaExceededError';
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export class GuestPublishDisabledError extends Error {
  readonly kind = 'guest-publish-disabled' as const;
  constructor() {
    super('Quick Share is not currently available. Please sign in to publish.');
    this.name = 'GuestPublishDisabledError';
  }
}

interface GuestPublishSuccessBody {
  shareCode: unknown;
  shareUrl: unknown;
  sizeBytes?: unknown;
  expiresAt: unknown;
  warnings?: unknown;
}

export async function postGuestCapsuleArtifact(
  artifact: CapsuleArtifact,
  turnstileToken: string,
): Promise<ShareResultGuest> {
  if (artifact.bytes > MAX_PUBLISH_BYTES) {
    // Matches auth-path preflight; oversize-trim is not available on the
    // guest path in v1 so this will route to the sign-in-to-trim upsell
    // copy in TimelineBar.
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

  if (!turnstileToken) {
    throw new GuestTurnstileError('missing', 'Verification required. Please solve the challenge above.');
  }

  const res = await fetch('/api/capsules/guest-publish', {
    method: 'POST',
    // Byte-identity invariant (§Guest Publish Request Contract): the
    // body is the raw capsule JSON, byte-for-byte identical to the
    // auth path. Turnstile token + age attestation travel in headers.
    //
    // Deliberately NOT sent: `X-Share-Mode: guest`. The route
    // (`/api/capsules/guest-publish`) already defines the mode; the
    // header was dead metadata the server never read. Removing it
    // shrinks the contract surface so a future implementer can't
    // mistake it for a meaningful branch point.
    headers: {
      'Content-Type': 'application/json',
      'X-Turnstile-Token': turnstileToken,
      'X-Age-Attested': '1',
    },
    body: artifact.json,
  });

  if (!res.ok) {
    if (res.status === 404) {
      // Endpoint disabled via feature flag; surface a dedicated error so
      // the UI can fall back to OAuth-only rather than a generic failure.
      throw new GuestPublishDisabledError();
    }
    if (res.status === 400) {
      const body = await readJsonOrNull(res);
      const err = typeof body?.error === 'string' ? body.error : '';
      if (err === 'turnstile_missing' || err === 'turnstile_failed') {
        throw new GuestTurnstileError('failed', 'Verification failed. Please try again.');
      }
      if (err === 'age_attestation_required') {
        throw new GuestAgeAttestationError();
      }
      throw new Error(
        typeof body?.message === 'string'
          ? `Publish failed: ${body.message}`
          : 'Publish failed: invalid request.',
      );
    }
    if (res.status === 413) {
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
      const parsed = retryAfterRaw === null ? NaN : Number(retryAfterRaw);
      throw new GuestQuotaExceededError(
        Number.isFinite(parsed) && parsed > 0 ? Math.ceil(parsed) : null,
      );
    }
    if (res.status === 503) {
      throw new GuestTurnstileError(
        'unavailable',
        'Verification is temporarily unavailable. Please try again in a minute.',
      );
    }
    // 5xx or unknown non-ok. Previously this fell through to a
    // generic "Publish failed: <raw body>" which leaked raw JSON to
    // the user for operator-error cases like 500 server_not_configured.
    // Split the 500 `server_not_configured` body into a dedicated
    // message + keep 5xx as a distinct "temporarily unavailable"
    // class so ops can see from support tickets whether an outage
    // was user-side (captcha failure) or backend-side.
    if (res.status >= 500) {
      const body = await readJsonOrNull(res);
      if (body && body.error === 'server_not_configured') {
        throw new GuestTurnstileError(
          'unavailable',
          'Quick Share is temporarily unavailable. Please try again in a minute or sign in to publish.',
        );
      }
      const preview = typeof body?.message === 'string'
        ? body.message.slice(0, 200)
        : `status ${res.status}`;
      console.warn(
        `[guest-publish] server error ${res.status} [id=GUEST_PUBLISH_5XX]: ${preview}`,
      );
      throw new Error('Publish is temporarily unavailable. Please try again in a minute.');
    }
    let detail = `status ${res.status}`;
    try { detail = (await res.text()) || detail; } catch { /* keep status */ }
    throw new Error(`Publish failed: ${detail}`);
  }

  const payload = await res.json() as GuestPublishSuccessBody;
  if (
    typeof payload.shareCode !== 'string' ||
    typeof payload.shareUrl !== 'string' ||
    typeof payload.expiresAt !== 'string'
  ) {
    // Shape mismatch after a 2xx means the row is persisted server-
    // side but we can't surface its coordinates. Log the received
    // shape (keys only, no values — body may contain sensitive
    // content if the server is compromised enough to send garbage)
    // so a support/ops reviewer can correlate with D1 reconciliation.
    try {
      const keys = Object.keys(payload ?? {}).slice(0, 10).join(',');
      console.error(
        `[guest-publish] server 201 returned unexpected shape [id=GUEST_PUBLISH_201_SHAPE]: keys=${keys}`,
      );
    } catch { /* best-effort logging */ }
    throw new Error('Publish: unexpected server response shape.');
  }
  const warnings = Array.isArray(payload.warnings)
    ? payload.warnings.filter((w): w is string => typeof w === 'string')
    : undefined;
  if (warnings && warnings.length > 0) {
    console.warn('[guest-publish] server reported non-fatal warnings:', warnings);
  }
  return {
    mode: 'guest',
    shareCode: payload.shareCode,
    shareUrl: payload.shareUrl,
    expiresAt: payload.expiresAt,
    ...(warnings && warnings.length > 0 ? { warnings } : {}),
  };
}

async function readJsonOrNull(res: Response): Promise<Record<string, unknown> | null> {
  try {
    const body = await res.json();
    return body && typeof body === 'object' ? body as Record<string, unknown> : null;
  } catch {
    return null;
  }
}
