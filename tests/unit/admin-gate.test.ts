/**
 * Tests for functions/admin-gate.ts — the shared admin hard gate used by
 * seed, moderation-delete, and both sweep endpoints.
 *
 * This is a security boundary. Both checks must pass, and any loosening
 * (e.g. substring match on hostname, truthy check on the env var) would
 * expose admin routes in production.
 */

import { describe, it, expect } from 'vitest';
import { requireAdminOr404 } from '../../functions/admin-gate';
import type { Env } from '../../functions/env';

function makeRequest(url: string): Request {
  return new Request(url);
}

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    // Bindings are not touched by the gate — cast through unknown.
    DB: undefined as unknown as Env['DB'],
    R2_BUCKET: undefined as unknown as Env['R2_BUCKET'],
    ...overrides,
  };
}

describe('requireAdminOr404 — DEV_ADMIN_ENABLED check', () => {
  it('returns 404 when DEV_ADMIN_ENABLED is undefined', async () => {
    const res = requireAdminOr404(makeRequest('http://localhost/api/admin/seed'), makeEnv());
    expect(res).not.toBeNull();
    expect(res!.status).toBe(404);
    expect(await res!.text()).toBe('Not found');
  });

  it('returns 404 for DEV_ADMIN_ENABLED = "false" (strict equality, not truthy)', () => {
    const res = requireAdminOr404(
      makeRequest('http://localhost/'),
      makeEnv({ DEV_ADMIN_ENABLED: 'false' }),
    );
    expect(res).not.toBeNull();
    expect(res!.status).toBe(404);
  });

  it('returns 404 for DEV_ADMIN_ENABLED = "0"', () => {
    const res = requireAdminOr404(
      makeRequest('http://localhost/'),
      makeEnv({ DEV_ADMIN_ENABLED: '0' }),
    );
    expect(res!.status).toBe(404);
  });

  it('returns 404 for DEV_ADMIN_ENABLED = "" (empty string)', () => {
    const res = requireAdminOr404(
      makeRequest('http://localhost/'),
      makeEnv({ DEV_ADMIN_ENABLED: '' }),
    );
    expect(res!.status).toBe(404);
  });

  it('returns 404 for DEV_ADMIN_ENABLED = "TRUE" (case-sensitive)', () => {
    const res = requireAdminOr404(
      makeRequest('http://localhost/'),
      makeEnv({ DEV_ADMIN_ENABLED: 'TRUE' }),
    );
    expect(res!.status).toBe(404);
  });

  it('returns 404 for DEV_ADMIN_ENABLED = "yes"', () => {
    const res = requireAdminOr404(
      makeRequest('http://localhost/'),
      makeEnv({ DEV_ADMIN_ENABLED: 'yes' }),
    );
    expect(res!.status).toBe(404);
  });
});

describe('requireAdminOr404 — hostname check', () => {
  const env = { DEV_ADMIN_ENABLED: 'true' } as const;

  it('passes for http://localhost/...', () => {
    const res = requireAdminOr404(makeRequest('http://localhost/api/admin/seed'), makeEnv(env));
    expect(res).toBeNull();
  });

  it('passes for http://127.0.0.1/...', () => {
    const res = requireAdminOr404(makeRequest('http://127.0.0.1/api/admin/seed'), makeEnv(env));
    expect(res).toBeNull();
  });

  it('passes for https://localhost/... (protocol is not the gate)', () => {
    const res = requireAdminOr404(makeRequest('https://localhost:8443/api/admin/seed'), makeEnv(env));
    expect(res).toBeNull();
  });

  it('returns 404 for other loopback addresses like 127.0.0.2', () => {
    const res = requireAdminOr404(makeRequest('http://127.0.0.2/'), makeEnv(env));
    expect(res!.status).toBe(404);
  });

  it('returns 404 for 127.0.0.11 (not an exact match for 127.0.0.1)', () => {
    const res = requireAdminOr404(makeRequest('http://127.0.0.11/'), makeEnv(env));
    expect(res!.status).toBe(404);
  });

  it('returns 404 for subdomain-of-localhost spoof attempts', () => {
    const res = requireAdminOr404(makeRequest('http://localhost.attacker.com/'), makeEnv(env));
    expect(res!.status).toBe(404);
  });

  it('returns 404 for production domain', () => {
    const res = requireAdminOr404(makeRequest('https://atomdojo.pages.dev/api/admin/seed'), makeEnv(env));
    expect(res!.status).toBe(404);
  });

  it('returns 404 for any non-loopback IP', () => {
    const res = requireAdminOr404(makeRequest('http://10.0.0.1/'), makeEnv(env));
    expect(res!.status).toBe(404);
  });
});

describe('requireAdminOr404 — CRON_SECRET path', () => {
  it('accepts production request with matching X-Cron-Secret header', () => {
    const req = new Request('https://atomdojo.pages.dev/api/admin/sweep/orphans', {
      headers: { 'X-Cron-Secret': 'sekret' },
    });
    const res = requireAdminOr404(req, makeEnv({ CRON_SECRET: 'sekret' }));
    expect(res).toBeNull();
  });

  it('rejects production request without X-Cron-Secret header', () => {
    const req = new Request('https://atomdojo.pages.dev/api/admin/sweep/orphans');
    const res = requireAdminOr404(req, makeEnv({ CRON_SECRET: 'sekret' }));
    expect(res!.status).toBe(404);
  });

  it('rejects production request with wrong X-Cron-Secret value', () => {
    const req = new Request('https://atomdojo.pages.dev/api/admin/sweep/orphans', {
      headers: { 'X-Cron-Secret': 'not-it' },
    });
    const res = requireAdminOr404(req, makeEnv({ CRON_SECRET: 'sekret' }));
    expect(res!.status).toBe(404);
  });

  it('rejects when CRON_SECRET is empty string (not configured)', () => {
    const req = new Request('https://atomdojo.pages.dev/api/admin/sweep/orphans', {
      headers: { 'X-Cron-Secret': '' },
    });
    const res = requireAdminOr404(req, makeEnv({ CRON_SECRET: '' }));
    expect(res!.status).toBe(404);
  });

  it('rejects when header value length differs from secret length', () => {
    const req = new Request('https://atomdojo.pages.dev/api/admin/sweep/orphans', {
      headers: { 'X-Cron-Secret': 'sekret-extra' },
    });
    const res = requireAdminOr404(req, makeEnv({ CRON_SECRET: 'sekret' }));
    expect(res!.status).toBe(404);
  });

  it('CRON_SECRET path does NOT require localhost (it is the production path)', () => {
    const req = new Request('https://atomdojo.pages.dev/', {
      headers: { 'X-Cron-Secret': 'sekret' },
    });
    const res = requireAdminOr404(req, makeEnv({ CRON_SECRET: 'sekret' }));
    expect(res).toBeNull();
  });

  it('CRON_SECRET path does NOT require DEV_ADMIN_ENABLED', () => {
    const req = new Request('https://atomdojo.pages.dev/', {
      headers: { 'X-Cron-Secret': 'sekret' },
    });
    const res = requireAdminOr404(
      req,
      makeEnv({ CRON_SECRET: 'sekret' /* DEV_ADMIN_ENABLED absent */ }),
    );
    expect(res).toBeNull();
  });
});

describe('requireAdminOr404 — combined gate', () => {
  it('requires BOTH checks — DEV_ADMIN_ENABLED=true alone with prod host still rejects', () => {
    const res = requireAdminOr404(
      makeRequest('https://atomdojo.pages.dev/api/admin/seed'),
      makeEnv({ DEV_ADMIN_ENABLED: 'true' }),
    );
    expect(res!.status).toBe(404);
  });

  it('requires BOTH checks — localhost alone without DEV_ADMIN_ENABLED still rejects', () => {
    const res = requireAdminOr404(
      makeRequest('http://localhost/api/admin/seed'),
      makeEnv(), // no DEV_ADMIN_ENABLED
    );
    expect(res!.status).toBe(404);
  });

  it('returns exactly null (not a Response) when allowed', () => {
    const res = requireAdminOr404(
      makeRequest('http://localhost/'),
      makeEnv({ DEV_ADMIN_ENABLED: 'true' }),
    );
    expect(res).toBeNull();
  });

  it('never returns 403 — all rejection paths return 404 (no existence leak)', async () => {
    const rejected = [
      requireAdminOr404(makeRequest('http://localhost/'), makeEnv()),
      requireAdminOr404(makeRequest('http://localhost/'), makeEnv({ DEV_ADMIN_ENABLED: 'false' })),
      requireAdminOr404(makeRequest('https://prod.example.com/'), makeEnv({ DEV_ADMIN_ENABLED: 'true' })),
    ];
    for (const res of rejected) {
      expect(res).not.toBeNull();
      expect(res!.status).toBe(404);
    }
  });
});
