/**
 * Cloudflare Turnstile server-side verifier.
 *
 * Contract:
 *   - tokens are single-use; server-side Siteverify is mandatory.
 *   - call timeout is explicit (8 seconds via AbortController) so the
 *     request-path latency cannot be held hostage by Siteverify hangs.
 *   - a timeout or network failure returns { ok: false, reason: 'siteverify_timeout' }
 *     — NEVER translate that to "allow." The endpoint layer maps this to
 *     503 turnstile_unavailable.
 *
 * Owns:        verifyTurnstileToken
 * Depends on:  global fetch
 * Called by:   functions/api/capsules/guest-publish.ts (anonymous POST gate)
 *
 * References:
 *   https://developers.cloudflare.com/turnstile/get-started/server-side-validation/
 */

export type TurnstileVerifyResult =
  | { ok: true; action?: string; cdata?: string }
  | { ok: false; reason: TurnstileFailureReason; errorCodes?: string[] };

export type TurnstileFailureReason =
  /** Siteverify replied with success=false. Token was invalid,
   *  duplicate-used, or expired (>5 min since solve). */
  | 'siteverify_rejected'
  /** Siteverify did not respond before the timeout expired. */
  | 'siteverify_timeout'
  /** Network/DNS/TLS failure reaching Siteverify. */
  | 'siteverify_network'
  /** Siteverify returned a non-2xx or unparseable body. */
  | 'siteverify_unparseable';

export const TURNSTILE_SITEVERIFY_URL =
  'https://challenges.cloudflare.com/turnstile/v0/siteverify';

export const TURNSTILE_VERIFY_TIMEOUT_MS = 8000;

interface SiteverifyBody {
  success: boolean;
  'error-codes'?: string[];
  action?: string;
  cdata?: string;
}

export async function verifyTurnstileToken(
  token: string,
  remoteip: string,
  secret: string,
  options: {
    fetchFn?: typeof fetch;
    timeoutMs?: number;
  } = {},
): Promise<TurnstileVerifyResult> {
  if (!token) {
    return { ok: false, reason: 'siteverify_rejected', errorCodes: ['missing-input-response'] };
  }
  if (!secret) {
    return { ok: false, reason: 'siteverify_rejected', errorCodes: ['missing-input-secret'] };
  }

  const fetchFn = options.fetchFn ?? fetch;
  const timeoutMs = options.timeoutMs ?? TURNSTILE_VERIFY_TIMEOUT_MS;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const form = new URLSearchParams();
  form.set('secret', secret);
  form.set('response', token);
  if (remoteip) form.set('remoteip', remoteip);

  let res: Response;
  try {
    res = await fetchFn(TURNSTILE_SITEVERIFY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
      signal: controller.signal,
    });
  } catch (err) {
    const isAbort = err instanceof DOMException && err.name === 'AbortError';
    return {
      ok: false,
      reason: isAbort ? 'siteverify_timeout' : 'siteverify_network',
    };
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    return { ok: false, reason: 'siteverify_unparseable', errorCodes: [`status-${res.status}`] };
  }

  let body: SiteverifyBody;
  try {
    body = await res.json() as SiteverifyBody;
  } catch {
    return { ok: false, reason: 'siteverify_unparseable' };
  }

  if (!body.success) {
    return {
      ok: false,
      reason: 'siteverify_rejected',
      errorCodes: body['error-codes'] ?? [],
    };
  }

  return { ok: true, action: body.action, cdata: body.cdata };
}
