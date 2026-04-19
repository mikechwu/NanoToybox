/**
 * Client-side helpers for the publish-size-limit UX contract.
 *
 * Formatters live here (rather than main.ts) so they can be unit-tested
 * without booting the full Lab runtime. The shared limit comes from
 * `src/share/constants.ts` — this module never hardcodes a byte value.
 *
 * ── Trust model ──────────────────────────────────────────────────────
 *
 * The numeric limit shown in a user-facing message is only rendered
 * when the client has a TRUSTWORTHY source for it:
 *
 *   1. **Server JSON body** — the most authoritative: the responding
 *      server's own view of the limit for this request.
 *   2. **`X-Max-Publish-Bytes` response header** — secondary fallback
 *      when the JSON body is malformed (CDN error-page injection,
 *      middleware rewrites, truncated transfer). The header comes
 *      from the same response so it's still the responding server's
 *      view, not a client assumption.
 *   3. **Client preflight** — local check against `MAX_PUBLISH_BYTES`
 *      before the fetch. The client decided to reject here, so it's
 *      honest to render the client's own limit; that number is by
 *      definition the reason for the rejection.
 *
 * What we deliberately do NOT do: fall back to the client's
 * `MAX_PUBLISH_BYTES` when a SERVER 413 response is unparseable. Under
 * deploy skew, a proxy rewrite, or an older backend version, the real
 * enforced limit may differ from the client's copy of the constant.
 * Rendering "Maximum allowed: 20 MB" in that case would be a confident
 * statement the client has no authority to make. We show the generic
 * "This capsule is too large to publish." instead.
 *
 * Contract matches the server at `functions/api/capsules/publish.ts`:
 *   413 body:    { error: 'payload_too_large', message, maxBytes, actualBytes? }
 *   413 header:  X-Max-Publish-Bytes: <decimal bytes>
 */

import { formatBytes } from './timeline/history-export';
import {
  MAX_PUBLISH_BYTES,
  PAYLOAD_TOO_LARGE_MESSAGE,
  type PayloadTooLargeBody,
} from '../../../src/share/constants';

/** Format a 413 message. Three priority-ordered outcomes:
 *   - `actualBytes` + `maxBytes` → "Current size: X. Maximum allowed: Y."
 *   - only `maxBytes`            → "Maximum allowed: Y."
 *   - neither                    → generic (no numeric info). Honest under
 *                                  unknown-limit conditions.
 */
export function formatPayloadTooLargeMessage(
  body: { actualBytes?: number; maxBytes?: number },
): string {
  const hasMax = typeof body.maxBytes === 'number' && Number.isFinite(body.maxBytes) && body.maxBytes > 0;
  const hasActual = typeof body.actualBytes === 'number' && Number.isFinite(body.actualBytes);
  if (!hasMax) {
    return PAYLOAD_TOO_LARGE_MESSAGE;
  }
  const max = formatBytes(body.maxBytes!);
  if (hasActual) {
    const actual = formatBytes(body.actualBytes!);
    return `${PAYLOAD_TOO_LARGE_MESSAGE} Current size: ${actual}. Maximum allowed: ${max}.`;
  }
  return `${PAYLOAD_TOO_LARGE_MESSAGE} Maximum allowed: ${max}.`;
}

/** Safely parse a positive finite integer from an unknown header value. */
function parsePositiveInt(raw: string | null): number | undefined {
  if (raw === null) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
}

/** Parse the 413 JSON body from a fetch Response and format the user-facing
 *  message. Priority chain, strictly one trust tier per rendered message:
 *    1. Parsed JSON body with valid `maxBytes` — render from body, and
 *       include `actualBytes` only if ALSO from that same body. Both
 *       figures come from a single trusted source.
 *    2. `X-Max-Publish-Bytes` header — render Maximum-only. Do NOT pull
 *       `actualBytes` from a body whose `maxBytes` was invalid; mixing
 *       an untrusted body's `actualBytes` with a trusted header's
 *       `maxBytes` would put two trust tiers in one user-facing message.
 *    3. Neither — render the generic message without any numeric limit.
 *
 *  Never falls back to the client's own `MAX_PUBLISH_BYTES` for SERVER
 *  responses; under deploy skew the client's constant may not match the
 *  responding server's enforced limit. Client preflight rejections are a
 *  different path that consults `MAX_PUBLISH_BYTES` directly (local
 *  reasoning, the client IS the source of truth for its own decision). */
export async function parsePayloadTooLargeMessage(res: Response): Promise<string> {
  const headerBytes = parsePositiveInt(res.headers.get('X-Max-Publish-Bytes'));
  let bodyMax: number | undefined;
  let bodyActual: number | undefined;
  try {
    const body = (await res.json()) as Partial<PayloadTooLargeBody>;
    bodyMax = typeof body.maxBytes === 'number' && Number.isFinite(body.maxBytes) && body.maxBytes > 0
      ? body.maxBytes
      : undefined;
    bodyActual = typeof body.actualBytes === 'number' && Number.isFinite(body.actualBytes)
      ? body.actualBytes
      : undefined;
  } catch {
    // JSON parse failed (non-JSON body, HTML error page, etc). Header
    // may still be intact — falls into the tier-2 header-only path below.
  }

  if (bodyMax !== undefined) {
    // Tier 1: body is the single source of truth for this message.
    // actualBytes is only honored when from the same body.
    return formatPayloadTooLargeMessage({ maxBytes: bodyMax, actualBytes: bodyActual });
  }
  if (headerBytes !== undefined) {
    // Tier 2: header provides the max. actualBytes from an invalid body
    // is deliberately dropped — mixing tiers would render a misleading
    // "Current size" alongside a header-sourced "Maximum allowed".
    return formatPayloadTooLargeMessage({ maxBytes: headerBytes });
  }
  // Tier 3: no trustworthy numeric source; render generic only.
  return formatPayloadTooLargeMessage({});
}

// Re-export so main.ts's preflight path can use the shared constant
// without a second import line at each call site.
export { MAX_PUBLISH_BYTES };
