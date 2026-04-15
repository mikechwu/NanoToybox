/**
 * Shared constants for the capsule share feature.
 *
 * Single source of truth — imported by the publish Pages Function, the
 * Lab publish-capsule caller, and every test that exercises the limit.
 * One change here propagates to server enforcement, client preflight,
 * error copy, and regression tests together. Drift-free by construction.
 */

/**
 * Maximum accepted capsule upload size, in bytes.
 *
 * Enforced identically in every environment (local wrangler dev,
 * preview deploy, production). No dev-mode bypass, no env override, no
 * "localhost is unlimited" branch — testing with real-world-sized
 * artifacts keeps dev and prod behavior aligned.
 */
export const MAX_PUBLISH_BYTES = 20 * 1024 * 1024; // 20 MB

/**
 * Structured error response body returned on HTTP 413 from
 * `/api/capsules/publish`. Enables the client to format a precise,
 * size-specific message without duplicating the limit string.
 *
 * Both enforcement layers (Content-Length preflight + post-read
 * authoritative check) return the same shape. `actualBytes` is omitted
 * (not null) when only Content-Length was consulted and we chose not
 * to read the body — the client's formatter tolerates this.
 */
export interface PayloadTooLargeBody {
  error: 'payload_too_large';
  message: string;
  maxBytes: number;
  actualBytes?: number;
}

/**
 * Canonical user-facing prose for 413. Kept here so server and any
 * fallback client path share the exact wording.
 */
export const PAYLOAD_TOO_LARGE_MESSAGE = 'This capsule is too large to publish.';

/**
 * Monotonic version label for the public Privacy Policy + Terms copy
 * and the 13+ age-gate acknowledgment. The literal value lives in
 * `src/policy/policy-config.ts` (single source of truth shared with
 * the build-time HTML transform); we re-export here so server-side
 * callers (publish endpoint, age-confirmation endpoint) and frontend
 * callers (policy page, account UI) all read the same string and
 * historical `user_policy_acceptance.policy_version` rows are
 * verifiable against the rendered page.
 */
export { POLICY_VERSION } from '../policy/policy-config';

/**
 * Structured body returned on 428 Precondition Required from
 * /api/capsules/publish when the authenticated user has no
 * minimum-age acceptance row on file (legacy / pre-D120 users — see
 * `functions/policy-acceptance.ts MINIMUM_AGE_POLICY_KIND`). The
 * frontend catches this the same way it catches 413 and renders the
 * publish-clickwrap fallback (single Publish button; clicking IS
 * the consent).
 */
export interface AgeConfirmationRequiredBody {
  error: 'age_confirmation_required';
  message: string;
  policyVersion: string;
}

export const AGE_CONFIRMATION_REQUIRED_MESSAGE =
  'Please confirm you meet the minimum age required in your country of residence before publishing.';

/**
 * Maximum allowed length of the `message` field on a `/privacy-request`
 * submission, in characters (not bytes — the field is decoded as a
 * string and counted with `.length`).
 *
 * Deliberately distinct from `MAX_PUBLISH_BYTES` / the 413 envelope:
 * the privacy-request flow uses a 400 `message_too_long` body whose
 * shape and copy are local to that endpoint. See the 2026-04-14 plan,
 * "Why message_too_long (400) and not payload_too_large (413)".
 */
export const MAX_PRIVACY_REQUEST_CHARS = 2000;

export const MESSAGE_TOO_LONG_MESSAGE =
  'Your request is too long to submit. Maximum allowed: 2,000 characters.';

/** Allowed values for `privacy_requests.request_type`. */
export const PRIVACY_REQUEST_TYPES = [
  'access',
  'deletion',
  'correction',
  'under_13_remediation',
  'other',
] as const;

export type PrivacyRequestType = (typeof PRIVACY_REQUEST_TYPES)[number];
