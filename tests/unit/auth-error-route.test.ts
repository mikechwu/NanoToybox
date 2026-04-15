/**
 * Tests for `functions/auth/error.ts` — the friendly landing page used
 * when the OAuth callback bails on acceptance failure (D120).
 *
 * Contract guards:
 *   - returns 200 + Cache-Control: no-store
 *   - whitelists `reason` (acceptance_failed | oauth_failed); arbitrary
 *     query values fall through to a generic body and are NEVER
 *     reflected into the HTML
 *   - whitelists `provider` (google | github); arbitrary values render
 *     as a generic "your provider" label
 *   - body always contains the Try-again link to /lab/
 *   - body always carries Privacy/Terms recovery links
 *   - does NOT set or read any session cookie
 */

import { describe, it, expect } from 'vitest';
import { onRequestGet } from '../../functions/auth/error';

async function get(query: string): Promise<{ status: number; body: string; headers: Headers }> {
  const url = `https://atomdojo.test/auth/error${query}`;
  const request = new Request(url);
  const res = await onRequestGet({
    request,
  } as unknown as Parameters<typeof onRequestGet>[0]);
  return { status: res.status, body: await res.text(), headers: res.headers };
}

describe('/auth/error landing page', () => {
  it('200 + no-store cache header', async () => {
    const { status, headers } = await get('?reason=acceptance_failed&provider=google');
    expect(status).toBe(200);
    expect(headers.get('Cache-Control')).toBe('no-store');
    expect(headers.get('Content-Type')).toMatch(/text\/html/);
  });

  it('renders agreement copy + Google label for acceptance_failed + google', async () => {
    const { body } = await get('?reason=acceptance_failed&provider=google');
    expect(body).toContain('agreement');
    expect(body).toContain('Google');
    expect(body).toContain('Try again');
    expect(body).toContain('Privacy Policy');
    expect(body).toContain('Terms');
  });

  it('renders generic copy when reason is unknown — does NOT reflect raw input', async () => {
    const { body } = await get('?reason=%3Cscript%3Ealert(1)%3C%2Fscript%3E&provider=google');
    expect(body).not.toContain('<script>');
    expect(body).not.toContain('alert(1)');
    // Falls through to oauth_failed generic copy.
    expect(body).toContain('Sign-in didn');
    expect(body).toContain('Try again');
  });

  it('renders generic provider label when provider is unknown — does NOT reflect raw input', async () => {
    const { body } = await get('?reason=acceptance_failed&provider=evil.example');
    expect(body).not.toContain('evil.example');
    expect(body).toContain('your provider');
  });

  it('omits both query params → generic copy + no reflection', async () => {
    const { body } = await get('');
    expect(body).toContain('Try again');
    expect(body).toContain('Privacy Policy');
  });

  it('does NOT set a Set-Cookie header', async () => {
    const { headers } = await get('?reason=acceptance_failed&provider=google');
    expect(headers.get('Set-Cookie')).toBeNull();
  });
});
