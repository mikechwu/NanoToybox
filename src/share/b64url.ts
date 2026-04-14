/**
 * Base64URL encode/decode helpers.
 *
 * Single source of truth — used by both the cursor pagination encoder
 * (`functions/api/account/capsules/index.ts`) and the signed-intent
 * helper (`functions/signed-intents.ts`). Previously each file
 * inlined its own version; the inline copies disagreed about whether
 * to restore `=` padding before `atob`, which made `signed-intents`
 * silently reject ~75% of valid tokens in strict runtimes (Workers,
 * Deno, modern Node).
 *
 * RFC 4648 §5 base64url:
 *   - replace `+` → `-` and `/` → `_`
 *   - strip trailing `=` padding
 *
 * Decoding restores both transformations + the padding before
 * delegating to `atob`. Inputs that fail `atob` propagate as the
 * `InvalidCharacterError` it raises — callers should catch it and
 * surface the failure (see e.g. `decodeCursor` returning null).
 */

export function b64urlEncode(raw: string): string {
  return btoa(raw).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64urlDecode(token: string): string {
  const swapped = token.replace(/-/g, '+').replace(/_/g, '/');
  // Restore the `=` padding the encoder strips. Without this `atob`
  // throws on inputs whose length is not a multiple of 4.
  const padded = swapped + '='.repeat((4 - (swapped.length % 4)) % 4);
  return atob(padded);
}
