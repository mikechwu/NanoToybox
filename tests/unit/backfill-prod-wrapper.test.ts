/**
 * Tests for scripts/backfill-preview-scenes-prod.mjs (ADR D138 Lane A).
 *
 * The wrapper is a thin HTTP client. Assert the contract with the
 * admin endpoint via mocked `globalThis.fetch`: header shape, body
 * shape, exit-code mapping, and the pre-flight error when the
 * admin-secret env var is missing.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — .mjs JS wrapper exports are resolved at runtime via vite-node.
import { main } from '../../scripts/backfill-preview-scenes-prod.mjs';

function baseArgv(...extra: string[]): string[] {
  return [
    'node',
    'scripts/backfill-preview-scenes-prod.mjs',
    '--base-url', 'https://atomdojo.pages.dev',
    '--admin-secret', 'CRON_SECRET',
    ...extra,
  ];
}

describe('backfill-prod-wrapper', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    fetchMock = vi.fn();
    (globalThis as unknown as { fetch: unknown }).fetch = fetchMock;
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function allLogOutput(): string {
    return logSpy.mock.calls.map((c) => c.map(String).join(' ')).join('\n');
  }
  function allErrorOutput(): string {
    return errorSpy.mock.calls.map((c) => c.map(String).join(' ')).join('\n');
  }

  it('sends X-Cron-Secret + Content-Type headers from the env var', async () => {
    fetchMock.mockResolvedValue({
      status: 200,
      text: async () => JSON.stringify({ scanned: 0, updated: 0, skipped: 0, failed: [] }),
    });
    await main(baseArgv(), { CRON_SECRET: 'shh' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://atomdojo.pages.dev/api/admin/backfill-preview-scenes');
    expect(init.method).toBe('POST');
    expect(init.headers['X-Cron-Secret']).toBe('shh');
    expect(init.headers['Content-Type']).toBe('application/json');
  });

  it('CLI flags produce the documented body shape', async () => {
    fetchMock.mockResolvedValue({
      status: 200,
      text: async () => JSON.stringify({ scanned: 0, updated: 0, skipped: 0, failed: [] }),
    });
    await main(
      baseArgv('--force', '--page-size', '50', '--verbose', '--dry-run'),
      { CRON_SECRET: 'shh' },
    );
    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(init.body);
    expect(body).toEqual({
      force: true,
      pageSize: 50,
      verbose: true,
      dryRun: true,
    });
  });

  it('exits non-zero on HTTP >= 400 and carries the endpoint body on stderr', async () => {
    fetchMock.mockResolvedValue({
      status: 500,
      text: async () => 'server exploded',
    });
    const code = await main(baseArgv(), { CRON_SECRET: 'shh' });
    expect(code).not.toBe(0);
    expect(allErrorOutput()).toContain('server exploded');
  });

  it('exits non-zero when summary.failed.length > 0 and carries the summary on stdout', async () => {
    fetchMock.mockResolvedValue({
      status: 200,
      text: async () => JSON.stringify({
        scanned: 2, updated: 1, skipped: 0,
        failed: [{ id: 'x', reason: 'bad' }],
      }),
    });
    const code = await main(baseArgv(), { CRON_SECRET: 'shh' });
    expect(code).not.toBe(0);
    const stdout = allLogOutput();
    expect(stdout).toContain('scanned');
    expect(stdout).toContain('failed');
  });

  it('exits 0 on clean success and prints the summary to stdout', async () => {
    fetchMock.mockResolvedValue({
      status: 200,
      text: async () => JSON.stringify({
        scanned: 5, updated: 5, skipped: 0, failed: [],
      }),
    });
    const code = await main(baseArgv(), { CRON_SECRET: 'shh' });
    expect(code).toBe(0);
    expect(allLogOutput()).toContain('scanned');
  });

  it('exits non-zero without calling fetch when the admin-secret env var is missing', async () => {
    const code = await main(baseArgv('--admin-secret', 'NOT_SET'), {});
    expect(code).not.toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a truncated argv where --admin-secret has no value (no silent fallback)', async () => {
    const argv = [
      'node',
      'scripts/backfill-preview-scenes-prod.mjs',
      '--base-url', 'https://atomdojo.pages.dev',
      '--admin-secret', // value missing — must NOT silently fall back
    ];
    const code = await main(argv, { CRON_SECRET: 'shh' });
    expect(code).not.toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(allErrorOutput()).toContain('--admin-secret');
  });
});
