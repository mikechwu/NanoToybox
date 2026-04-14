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
