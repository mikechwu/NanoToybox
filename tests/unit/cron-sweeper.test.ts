/**
 * Unit tests for workers/cron-sweeper/src/index.ts.
 *
 * Verifies the Worker's HTTP shape — URL composition, headers, error
 * handling, secret-required gate — without spinning up a real Worker
 * runtime. The scheduled handler itself is a thin wrapper around
 * invokeSweep(), which is exported for this purpose.
 */

import { describe, it, expect, vi } from 'vitest';
import workerHandler, { invokeSweep } from '../../workers/cron-sweeper/src/index';
import type { Env } from '../../workers/cron-sweeper/src/index';

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    PAGES_BASE_URL: 'https://atomdojo.pages.dev',
    CRON_SECRET: 'test-secret',
    ...overrides,
  };
}

describe('cron-sweeper invokeSweep', () => {
  it('POSTs to PAGES_BASE_URL + path with X-Cron-Secret header', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    const result = await invokeSweep('/api/admin/sweep/sessions', makeEnv(), fetchMock);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://atomdojo.pages.dev/api/admin/sweep/sessions');
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers['X-Cron-Secret']).toBe('test-secret');

    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
    expect(result.bodyPreview).toContain('ok');
  });

  it('strips trailing slash from PAGES_BASE_URL', async () => {
    const fetchMock = vi.fn(async () => new Response('', { status: 200 }));
    await invokeSweep('/api/admin/sweep/orphans', makeEnv({ PAGES_BASE_URL: 'https://atomdojo.pages.dev/' }), fetchMock);
    const [url] = fetchMock.mock.calls[0] as unknown as [string];
    expect(url).toBe('https://atomdojo.pages.dev/api/admin/sweep/orphans');
  });

  it('returns ok=false when the target returns non-2xx', async () => {
    const fetchMock = vi.fn(async () => new Response('Not found', { status: 404 }));
    const result = await invokeSweep('/api/admin/sweep/sessions', makeEnv(), fetchMock);
    expect(result.ok).toBe(false);
    expect(result.status).toBe(404);
    expect(result.bodyPreview).toBe('Not found');
  });

  it('truncates long body previews to 200 chars', async () => {
    const body = 'x'.repeat(1000);
    const fetchMock = vi.fn(async () => new Response(body, { status: 500 }));
    const result = await invokeSweep('/api/admin/sweep/orphans', makeEnv(), fetchMock);
    expect(result.bodyPreview.length).toBe(200);
  });

  it('refuses to call out when CRON_SECRET is missing (fails closed)', async () => {
    const fetchMock = vi.fn();
    const result = await invokeSweep(
      '/api/admin/sweep/sessions',
      makeEnv({ CRON_SECRET: '' }),
      fetchMock,
    );
    expect(result.ok).toBe(false);
    expect(result.status).toBe(0);
    expect(result.bodyPreview).toContain('CRON_SECRET');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('tolerates an unreadable response body (no crash)', async () => {
    // Response whose text() throws — rare but possible under runtime errors.
    const brokenResponse = {
      ok: true,
      status: 200,
      async text() { throw new Error('body read failed'); },
    } as unknown as Response;
    const fetchMock = vi.fn(async () => brokenResponse);
    const result = await invokeSweep('/api/admin/sweep/sessions', makeEnv(), fetchMock);
    expect(result.ok).toBe(true);
    expect(result.bodyPreview).toBe('');
  });
});

// ── Worker fetch handler — auth ordering ───────────────────────────────────
//
// Critical: the fetch handler must authenticate BEFORE parsing any
// operator input. A 400 "Usage" response returned to an unauthenticated
// caller would leak route existence. The only allowed unauth response
// is 404.

describe('cron-sweeper fetch handler auth ordering', () => {
  function callFetch(init: {
    url?: string;
    secret?: string;
    env?: Partial<Env>;
  }): Promise<Response> {
    const url = init.url ?? 'https://x.workers.dev/?target=sessions';
    const request = new Request(url, {
      headers: init.secret !== undefined ? { 'X-Cron-Secret': init.secret } : {},
    });
    const env = makeEnv(init.env);
    // The fetch signature is (request, env, ctx) — ctx unused in handler logic.
    return workerHandler.fetch(request, env, {} as ExecutionContext);
  }

  it('returns 404 (not 400 Usage) when X-Cron-Secret header is missing, even with bad target', async () => {
    const res = await callFetch({ url: 'https://x.workers.dev/?target=invalid', secret: undefined });
    expect(res.status).toBe(404);
    const body = await res.text();
    // No mention of "Usage" or available targets — auth must be first.
    expect(body).not.toContain('Usage');
    expect(body).not.toContain('sessions');
    expect(body).not.toContain('orphans');
  });

  it('returns 404 when X-Cron-Secret is wrong, even without ?target=', async () => {
    const res = await callFetch({ url: 'https://x.workers.dev/', secret: 'wrong' });
    expect(res.status).toBe(404);
  });

  it('returns 404 when CRON_SECRET is not configured at all (fails closed)', async () => {
    const res = await callFetch({ secret: 'anything', env: { CRON_SECRET: '' } });
    expect(res.status).toBe(404);
  });

  it('returns 404 when header and secret differ only in length (constant-time compare)', async () => {
    const res = await callFetch({ secret: 'test-secret-extra' });
    expect(res.status).toBe(404);
  });

  it('returns 400 "Usage" only AFTER successful auth', async () => {
    const res = await callFetch({ url: 'https://x.workers.dev/', secret: 'test-secret' });
    expect(res.status).toBe(400);
    const body = await res.text();
    expect(body).toContain('Usage');
  });

  it('returns 400 "Usage" after successful auth with an invalid target', async () => {
    const res = await callFetch({
      url: 'https://x.workers.dev/?target=not-a-target',
      secret: 'test-secret',
    });
    expect(res.status).toBe(400);
  });

  it('authenticated + valid target dispatches to the right sweep endpoint', async () => {
    // Intercept fetch — we're exercising dispatch, not the full invokeSweep.
    const originalFetch = globalThis.fetch;
    const calls: Array<{ url: string }> = [];
    (globalThis as { fetch: typeof fetch }).fetch = async (
      input: RequestInfo | URL,
    ) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      calls.push({ url });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    };
    try {
      const res1 = await callFetch({
        url: 'https://x.workers.dev/?target=sessions',
        secret: 'test-secret',
      });
      expect(res1.status).toBe(200);
      expect(calls[0].url).toContain('/api/admin/sweep/sessions');

      const res2 = await callFetch({
        url: 'https://x.workers.dev/?target=orphans',
        secret: 'test-secret',
      });
      expect(res2.status).toBe(200);
      expect(calls[1].url).toContain('/api/admin/sweep/orphans');
    } finally {
      (globalThis as { fetch: typeof fetch }).fetch = originalFetch;
    }
  });
});
