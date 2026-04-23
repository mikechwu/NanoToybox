/**
 * Tests for src/share/turnstile.ts
 *
 * Covers success, siteverify rejection, siteverify unparseable,
 * network failure, and the 8-second timeout contract — the last two
 * MUST route to {reason: 'siteverify_timeout' | 'siteverify_network'}
 * so the endpoint layer can map them to 503 turnstile_unavailable
 * (never bypass).
 */

import { describe, it, expect, vi } from 'vitest';
import {
  verifyTurnstileToken,
  TURNSTILE_SITEVERIFY_URL,
} from '../../src/share/turnstile';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('verifyTurnstileToken', () => {
  it('returns ok when siteverify replies success', async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ success: true, action: 'publish' }));
    const result = await verifyTurnstileToken('tok', '1.2.3.4', 'secret', { fetchFn });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.action).toBe('publish');

    // POSTs to the siteverify endpoint with the expected form fields.
    const call = fetchFn.mock.calls[0];
    expect(call[0]).toBe(TURNSTILE_SITEVERIFY_URL);
    const init = call[1] as RequestInit;
    expect(init.method).toBe('POST');
    const body = init.body as string;
    expect(body).toContain('secret=secret');
    expect(body).toContain('response=tok');
    expect(body).toContain('remoteip=1.2.3.4');
  });

  it('returns siteverify_rejected when success=false', async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse({ success: false, 'error-codes': ['invalid-input-response'] }),
    );
    const result = await verifyTurnstileToken('tok', '', 'secret', { fetchFn });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('siteverify_rejected');
      expect(result.errorCodes).toEqual(['invalid-input-response']);
    }
  });

  it('rejects empty token without a network round trip', async () => {
    const fetchFn = vi.fn();
    const result = await verifyTurnstileToken('', '1.1.1.1', 'secret', { fetchFn });
    expect(fetchFn).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
  });

  it('rejects missing secret without a network round trip', async () => {
    const fetchFn = vi.fn();
    const result = await verifyTurnstileToken('tok', '1.1.1.1', '', { fetchFn });
    expect(fetchFn).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
  });

  it('returns siteverify_timeout when the fetch is aborted', async () => {
    const fetchFn = vi.fn(async (_url: string, init?: RequestInit) => {
      // Simulate the abort by awaiting the signal and throwing an
      // AbortError once it fires.
      const signal = init?.signal;
      if (!signal) throw new Error('no signal');
      await new Promise<void>((_, reject) => {
        signal.addEventListener('abort', () => {
          reject(new DOMException('aborted', 'AbortError'));
        });
      });
      throw new Error('unreachable');
    });
    const result = await verifyTurnstileToken('tok', '', 'secret', {
      fetchFn,
      timeoutMs: 10,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('siteverify_timeout');
  });

  it('returns siteverify_network on transport failure', async () => {
    const fetchFn = vi.fn(async () => { throw new TypeError('network'); });
    const result = await verifyTurnstileToken('tok', '', 'secret', { fetchFn });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('siteverify_network');
  });

  it('returns siteverify_unparseable on non-2xx status', async () => {
    const fetchFn = vi.fn(async () => new Response('Bad Gateway', { status: 502 }));
    const result = await verifyTurnstileToken('tok', '', 'secret', { fetchFn });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('siteverify_unparseable');
  });

  it('returns siteverify_unparseable when body is not JSON', async () => {
    const fetchFn = vi.fn(async () => new Response('<html>error</html>', { status: 200 }));
    const result = await verifyTurnstileToken('tok', '', 'secret', { fetchFn });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('siteverify_unparseable');
  });
});
