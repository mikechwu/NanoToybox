/**
 * Shared no-cache headers + JSON-with-no-cache helper.
 *
 * The Phase-7 account + privacy endpoints (`/api/account/me`,
 * `/api/account/capsules`, `/api/account/age-confirmation`,
 * `/api/account/age-confirmation/intent`, `/api/privacy-request/nonce`)
 * each had a private copy of this header set and a private
 * `noCacheHeaders()` builder. Centralised here so the directives stay
 * aligned across the per-user / CSRF-nonce surface.
 *
 * - `Cache-Control: no-store, private` forbids ANY cache (browser,
 *   intermediary, edge) from storing the response. Critical for
 *   per-user state — a shared cache could otherwise leak one
 *   account's data to another.
 * - `Pragma: no-cache` covers HTTP/1.0 intermediaries.
 * - `Vary: Cookie` is defense-in-depth for any cache that ignores the
 *   `no-store` directive.
 */

export const NO_CACHE_HEADERS: Readonly<Record<string, string>> = {
  'Cache-Control': 'no-store, private',
  Pragma: 'no-cache',
  Vary: 'Cookie',
};

/** Build a fresh `Headers` instance with the no-cache set applied. */
export function noCacheHeaders(extra?: Record<string, string>): Headers {
  const headers = new Headers();
  for (const [k, v] of Object.entries(NO_CACHE_HEADERS)) headers.set(k, v);
  if (extra) {
    for (const [k, v] of Object.entries(extra)) headers.set(k, v);
  }
  return headers;
}

/** `Response.json` with the no-cache set merged in. */
export function noCacheJson(body: unknown, init?: ResponseInit): Response {
  const headers = new Headers(init?.headers);
  for (const [k, v] of Object.entries(NO_CACHE_HEADERS)) {
    if (!headers.has(k)) headers.set(k, v);
  }
  return Response.json(body, { ...init, headers });
}
