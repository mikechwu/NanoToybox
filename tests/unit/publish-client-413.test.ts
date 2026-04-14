/**
 * Client-side 413 formatter tests.
 *
 * Locks the copy contract AND the trust model for the payload-too-large
 * path. `parsePayloadTooLargeMessage` walks a strict three-tier priority
 * chain when interpreting a server 413 response:
 *
 *   Tier 1 — parsed JSON body (trusted):
 *     Render from body.maxBytes, including body.actualBytes only if
 *     that same body provided it. Both figures come from one source.
 *     Produces either "Current size: X. Maximum allowed: Y." or
 *     "Maximum allowed: Y." depending on whether actualBytes is present
 *     (server omits it on the Content-Length preflight path — it hasn't
 *     read the body yet and can't fabricate a measurement).
 *
 *   Tier 2 — X-Max-Publish-Bytes response header (trusted):
 *     Used ONLY when the body is unparseable / missing a valid
 *     maxBytes. Renders Maximum-only. `actualBytes` from an untrusted
 *     body is deliberately NOT pulled into this tier — mixing an
 *     untrusted "Current size" with a trusted "Maximum allowed" would
 *     put two trust levels in one user-facing message.
 *
 *   Tier 3 — generic (no numeric limit):
 *     When neither the body nor the header supplies a trustworthy
 *     maxBytes. Under deploy skew / CDN rewrite, the real enforced
 *     limit on this response may not match the client's copy of the
 *     shared constant — the client deliberately does NOT fall back to
 *     its own `MAX_PUBLISH_BYTES` for server responses. Honest "we
 *     can't state the exact limit right now" beats rendering a
 *     confident number the client has no authority to assert.
 *
 * The client's own `MAX_PUBLISH_BYTES` constant is reserved for local
 * preflight rejections where the client IS the source of truth for
 * its own decision (see `lab/js/main.ts publishCapsule`); server-
 * response rendering never consults it as a fallback.
 *
 * This file is the primary spec for that policy — if a reviewer is
 * tempted to "simplify" the parser by falling back to the client
 * constant, the tests below should stop them.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  formatPayloadTooLargeMessage,
  parsePayloadTooLargeMessage,
} from '../../lab/js/runtime/publish-size';
import { MAX_PUBLISH_BYTES, PAYLOAD_TOO_LARGE_MESSAGE } from '../../src/share/constants';

// ── formatPayloadTooLargeMessage ────────────────────────────────────────

describe('formatPayloadTooLargeMessage — copy contract', () => {
  it('renders "Current size + Maximum" when actualBytes is present', () => {
    const msg = formatPayloadTooLargeMessage({
      actualBytes: 23.5 * 1024 * 1024,
      maxBytes: 20 * 1024 * 1024,
    });
    expect(msg).toContain(PAYLOAD_TOO_LARGE_MESSAGE);
    expect(msg).toContain('Current size:');
    expect(msg).toContain('23.5 MB');
    expect(msg).toContain('Maximum allowed:');
    expect(msg).toContain('20.0 MB');
  });

  it('renders only "Maximum allowed" when actualBytes is missing', () => {
    const msg = formatPayloadTooLargeMessage({
      maxBytes: 20 * 1024 * 1024,
    });
    expect(msg).toContain(PAYLOAD_TOO_LARGE_MESSAGE);
    expect(msg).not.toContain('Current size');
    expect(msg).toContain('Maximum allowed: 20.0 MB');
  });

  it('ignores NaN / non-finite actualBytes (falls back to max-only copy)', () => {
    const nanMsg = formatPayloadTooLargeMessage({
      actualBytes: NaN,
      maxBytes: 20 * 1024 * 1024,
    });
    const infMsg = formatPayloadTooLargeMessage({
      actualBytes: Infinity,
      maxBytes: 20 * 1024 * 1024,
    });
    for (const msg of [nanMsg, infMsg]) {
      expect(msg).not.toContain('Current size');
      expect(msg).toContain('Maximum allowed: 20.0 MB');
    }
  });

  it('uses the SHARED MAX_PUBLISH_BYTES when called with it (no hardcoded MB literal)', () => {
    const msg = formatPayloadTooLargeMessage({ maxBytes: MAX_PUBLISH_BYTES });
    expect(msg).toContain('Maximum allowed: 20.0 MB');
    // Guard: if the shared constant ever moves back to 10 MB, this test
    // would show "10.0 MB" — the failing assertion below locks the
    // expected 20 MB from the plan.
    expect(msg).not.toContain('10.0 MB');
  });

  it('renders GENERIC when maxBytes is missing (honest under unknown-limit conditions)', () => {
    const msg = formatPayloadTooLargeMessage({});
    expect(msg).toBe(PAYLOAD_TOO_LARGE_MESSAGE);
    expect(msg).not.toContain('Maximum allowed');
    expect(msg).not.toContain('MB');
  });

  it('renders GENERIC when maxBytes is zero / negative / non-finite', () => {
    for (const bad of [0, -1, NaN, Infinity, -Infinity]) {
      const msg = formatPayloadTooLargeMessage({ maxBytes: bad });
      expect(msg, `bad maxBytes ${bad} must render generic`).toBe(PAYLOAD_TOO_LARGE_MESSAGE);
    }
  });

  it('ignores actualBytes when maxBytes is missing (generic wins)', () => {
    // actualBytes without maxBytes is meaningless — what's the threshold?
    // Fall back to generic rather than inventing partial numeric info.
    const msg = formatPayloadTooLargeMessage({ actualBytes: 25 * 1024 * 1024 });
    expect(msg).toBe(PAYLOAD_TOO_LARGE_MESSAGE);
    expect(msg).not.toContain('Current size');
  });
});

// ── parsePayloadTooLargeMessage — body → formatted string ───────────────

describe('parsePayloadTooLargeMessage — consumes server JSON', () => {
  function mockResponse(body: unknown, init: ResponseInit = {}): Response {
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status: 413,
      headers: { 'Content-Type': 'application/json' },
      ...init,
    });
  }

  it('renders Current + Maximum from a full structured body', async () => {
    const res = mockResponse({
      error: 'payload_too_large',
      message: PAYLOAD_TOO_LARGE_MESSAGE,
      maxBytes: 20 * 1024 * 1024,
      actualBytes: 21_500_000,
    });
    const msg = await parsePayloadTooLargeMessage(res);
    expect(msg).toContain('Current size:');
    expect(msg).toContain('Maximum allowed: 20.0 MB');
  });

  it('renders Maximum-only when actualBytes is omitted (Content-Length preflight path)', async () => {
    const res = mockResponse({
      error: 'payload_too_large',
      message: PAYLOAD_TOO_LARGE_MESSAGE,
      maxBytes: 20 * 1024 * 1024,
    });
    const msg = await parsePayloadTooLargeMessage(res);
    expect(msg).not.toContain('Current size');
    expect(msg).toContain('Maximum allowed: 20.0 MB');
  });

  it('falls back to X-Max-Publish-Bytes HEADER when body is not parseable JSON', async () => {
    // Trust model: body-first, header-second, generic-third. A CDN / proxy
    // that rewrote the body into HTML but preserved response headers
    // should still produce a trustworthy numeric limit.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const res = mockResponse('<html>Gateway Timeout</html>', {
      headers: {
        'Content-Type': 'text/html',
        'X-Max-Publish-Bytes': String(20 * 1024 * 1024),
      },
    });
    const msg = await parsePayloadTooLargeMessage(res);
    expect(msg).toContain(PAYLOAD_TOO_LARGE_MESSAGE);
    expect(msg).toContain('Maximum allowed: 20.0 MB');
    expect(msg).not.toMatch(/undefined|NaN/);
    warn.mockRestore();
  });

  it('falls back to GENERIC (no numeric max) when both body and header are unusable', async () => {
    // The client must NOT synthesize a numeric limit from its own
    // MAX_PUBLISH_BYTES when no server source confirms it — under
    // deploy skew / proxy rewrites, the responding server's real limit
    // may differ. Generic copy preserves correctness.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const res = mockResponse('<html>Gateway Timeout</html>', {
      headers: { 'Content-Type': 'text/html' }, // no X-Max-Publish-Bytes
    });
    const msg = await parsePayloadTooLargeMessage(res);
    expect(msg).toBe(PAYLOAD_TOO_LARGE_MESSAGE);
    expect(msg).not.toContain('Maximum allowed');
    expect(msg).not.toContain('MB');
    expect(msg).not.toMatch(/undefined|NaN/);
    warn.mockRestore();
  });

  it('falls back to HEADER when body maxBytes is garbage', async () => {
    // Body parses but maxBytes is wrong type. Header is the secondary
    // trusted source — use it rather than the client's constant.
    const res = mockResponse(
      {
        error: 'payload_too_large',
        message: PAYLOAD_TOO_LARGE_MESSAGE,
        maxBytes: 'not a number' as unknown as number,
      },
      { headers: { 'X-Max-Publish-Bytes': String(20 * 1024 * 1024) } },
    );
    const msg = await parsePayloadTooLargeMessage(res);
    expect(msg).toContain('Maximum allowed: 20.0 MB');
  });

  it('falls back to GENERIC when body maxBytes is garbage AND no header', async () => {
    const res = mockResponse({
      error: 'payload_too_large',
      message: PAYLOAD_TOO_LARGE_MESSAGE,
      maxBytes: 'not a number' as unknown as number,
    });
    const msg = await parsePayloadTooLargeMessage(res);
    // No trustworthy server-authored limit → generic only.
    expect(msg).toBe(PAYLOAD_TOO_LARGE_MESSAGE);
  });

  it('body maxBytes takes precedence over header when both are valid', async () => {
    // Body is the richer signal (may also carry actualBytes), so it wins
    // when both are present and valid — even if they disagree.
    const res = mockResponse(
      {
        error: 'payload_too_large',
        message: PAYLOAD_TOO_LARGE_MESSAGE,
        maxBytes: 30 * 1024 * 1024,
        actualBytes: 32 * 1024 * 1024,
      },
      { headers: { 'X-Max-Publish-Bytes': String(20 * 1024 * 1024) } },
    );
    const msg = await parsePayloadTooLargeMessage(res);
    expect(msg).toContain('Maximum allowed: 30.0 MB');
    expect(msg).toContain('Current size: 32.0 MB');
  });

  it('rejects non-positive / non-finite header values', async () => {
    for (const bad of ['0', '-1', 'NaN', 'Infinity', 'abc', '']) {
      const res = mockResponse('not-json', {
        headers: { 'X-Max-Publish-Bytes': bad },
      });
      const msg = await parsePayloadTooLargeMessage(res);
      expect(msg, `bad header value "${bad}" must fall through to generic`).toBe(PAYLOAD_TOO_LARGE_MESSAGE);
    }
  });

  it('does NOT mix body.actualBytes (untrusted) with header maxBytes (trusted)', async () => {
    // Tier-purity regression: when the body's maxBytes is invalid we fall
    // back to the header's max, but we MUST NOT pull actualBytes from the
    // same invalid body. A mixed-source "Current size + Maximum allowed"
    // message would put two trust tiers in one user-facing string.
    const res = mockResponse(
      {
        error: 'payload_too_large',
        message: PAYLOAD_TOO_LARGE_MESSAGE,
        maxBytes: 'garbage' as unknown as number,
        // Body says "actualBytes = 99 MB" — but we don't trust the body.
        actualBytes: 99 * 1024 * 1024,
      },
      { headers: { 'X-Max-Publish-Bytes': String(20 * 1024 * 1024) } },
    );
    const msg = await parsePayloadTooLargeMessage(res);
    // Header supplied a trustworthy max → render Maximum-only.
    expect(msg).toContain('Maximum allowed: 20.0 MB');
    // The untrusted "Current size" must NOT appear alongside the trusted max.
    expect(msg).not.toContain('Current size');
    expect(msg).not.toContain('99.0 MB');
  });

  it('DOES honor body.actualBytes when body.maxBytes is ALSO valid (same trust tier)', async () => {
    // Positive counterpart to the tier-purity test above: when body.maxBytes
    // is valid the body is the single source of truth and actualBytes
    // from the same body is accepted.
    const res = mockResponse({
      error: 'payload_too_large',
      message: PAYLOAD_TOO_LARGE_MESSAGE,
      maxBytes: 20 * 1024 * 1024,
      actualBytes: 25 * 1024 * 1024,
    });
    const msg = await parsePayloadTooLargeMessage(res);
    expect(msg).toContain('Current size: 25.0 MB');
    expect(msg).toContain('Maximum allowed: 20.0 MB');
  });

  it('formatter is driven by server maxBytes — NOT a client-hardcoded string', async () => {
    // If the server ever changed the limit (with the shared constant
    // updated) the client would render whatever the server returned,
    // not a stale hardcoded value. Simulate a 30 MB server limit and
    // assert the client renders 30.0 MB.
    const res = mockResponse({
      error: 'payload_too_large',
      message: PAYLOAD_TOO_LARGE_MESSAGE,
      maxBytes: 30 * 1024 * 1024,
      actualBytes: 35 * 1024 * 1024,
    });
    const msg = await parsePayloadTooLargeMessage(res);
    expect(msg).toContain('Maximum allowed: 30.0 MB');
    expect(msg).toContain('Current size: 35.0 MB');
  });
});
