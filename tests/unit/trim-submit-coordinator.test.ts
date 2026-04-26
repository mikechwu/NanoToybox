/**
 * Tests for the single submit-coordinator seam (`resolveTrimSubmitTarget`).
 *
 * Acceptance #11 / #12 (Phase 1 architecture report §H):
 *   - the publish layer resolves an explicit `TrimSubmitTarget` exactly
 *     once per submit, in this seam, before any executor callback is
 *     invoked
 *   - both full-history and prepared submits go through the same
 *     resolver
 *   - a Quick Share action with `authStatus = 'signed-in'` resolves
 *     to target `guest` (NOT account — auth alone does not pick the
 *     target)
 *   - signed-out account submits return `auth-required` instead of
 *     dispatching to the account executor
 *   - guest submits with `turnstileToken = null` return
 *     `verification-required` and dispatch nothing
 *   - executors do not import `AuthStatus` or `PublicConfig` (proven
 *     by static-analysis test below)
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { resolveTrimSubmitTarget } from '../../lab/js/runtime/trim-submit-coordinator';
import type { PublicConfig } from '../../lab/js/runtime/share-auth-types';

const __dirname = dirname(fileURLToPath(import.meta.url));

const enabledConfig: PublicConfig = {
  guestPublish: { enabled: true, turnstileSiteKey: 'site-key-x' },
};
const disabledConfig: PublicConfig = {
  guestPublish: { enabled: false, turnstileSiteKey: null },
};
const enabledNoSiteKey: PublicConfig = {
  guestPublish: { enabled: true, turnstileSiteKey: null },
};

describe('resolveTrimSubmitTarget — share-account action', () => {
  it('resolves to account when signed-in', () => {
    const out = resolveTrimSubmitTarget({
      action: 'share-account',
      authStatus: 'signed-in',
      publicConfig: enabledConfig,
      turnstileToken: null,
    });
    expect(out).toEqual({ kind: 'ok', target: 'account' });
  });

  it('returns auth-required when signed-out', () => {
    const out = resolveTrimSubmitTarget({
      action: 'share-account',
      authStatus: 'signed-out',
      publicConfig: enabledConfig,
      turnstileToken: null,
    });
    expect(out).toEqual({ kind: 'unavailable', reason: 'auth-required' });
  });

  it('returns auth-required when auth is loading (no definitive answer yet)', () => {
    const out = resolveTrimSubmitTarget({
      action: 'share-account',
      authStatus: 'loading',
      publicConfig: enabledConfig,
      turnstileToken: null,
    });
    expect(out).toEqual({ kind: 'unavailable', reason: 'auth-required' });
  });

  it('returns unverified when auth is unverified', () => {
    const out = resolveTrimSubmitTarget({
      action: 'share-account',
      authStatus: 'unverified',
      publicConfig: enabledConfig,
      turnstileToken: null,
    });
    expect(out).toEqual({ kind: 'unavailable', reason: 'unverified' });
  });
});

describe('resolveTrimSubmitTarget — quick-share action', () => {
  it('routes to guest when signed-in (Quick Share is target-driven, not auth-derived)', () => {
    // Acceptance #11: with authStatus = 'signed-in', Quick Share must
    // route to the guest executor — never the account executor.
    const out = resolveTrimSubmitTarget({
      action: 'quick-share',
      authStatus: 'signed-in',
      publicConfig: enabledConfig,
      turnstileToken: 'tok-abc',
    });
    expect(out).toEqual({ kind: 'ok', target: 'guest', turnstileToken: 'tok-abc' });
  });

  it('routes to guest when signed-out with valid token', () => {
    const out = resolveTrimSubmitTarget({
      action: 'quick-share',
      authStatus: 'signed-out',
      publicConfig: enabledConfig,
      turnstileToken: 'tok-abc',
    });
    expect(out).toEqual({ kind: 'ok', target: 'guest', turnstileToken: 'tok-abc' });
  });

  it('returns guest-disabled when guestPublish.enabled is false', () => {
    const out = resolveTrimSubmitTarget({
      action: 'quick-share',
      authStatus: 'signed-out',
      publicConfig: disabledConfig,
      turnstileToken: 'tok-abc',
    });
    expect(out).toEqual({ kind: 'unavailable', reason: 'guest-disabled' });
  });

  it('returns config-missing when turnstileSiteKey is null', () => {
    const out = resolveTrimSubmitTarget({
      action: 'quick-share',
      authStatus: 'signed-out',
      publicConfig: enabledNoSiteKey,
      turnstileToken: 'tok-abc',
    });
    expect(out).toEqual({ kind: 'unavailable', reason: 'config-missing' });
  });

  it('returns verification-required when turnstileToken is null (replaces TimelineBar early-return)', () => {
    const out = resolveTrimSubmitTarget({
      action: 'quick-share',
      authStatus: 'signed-out',
      publicConfig: enabledConfig,
      turnstileToken: null,
    });
    expect(out).toEqual({ kind: 'unavailable', reason: 'verification-required' });
  });
});

describe('Phase 1 mode-isolation guarantees (static analysis)', () => {
  /** Strip block comments and line comments so identifier mentions in
   *  prose docstrings don't fail the import-isolation tests. The
   *  prepared-publish executors deliberately MENTION the names they
   *  must not import, in their file-level explanatory comments. The
   *  rule we are guarding is "no import" — narrow the regex to the
   *  source body. */
  function stripComments(src: string): string {
    return src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  }

  it('account executor module does not import AuthStatus, PublicConfig, or guest error types', () => {
    const path = resolve(
      __dirname,
      '..',
      '..',
      'lab/js/runtime/publish-prepared-account-capsule.ts',
    );
    const src = stripComments(readFileSync(path, 'utf8'));
    expect(src).not.toMatch(/\bAuthStatus\b/);
    expect(src).not.toMatch(/\bPublicConfig\b/);
    expect(src).not.toMatch(/\bGuestTurnstileError\b/);
    expect(src).not.toMatch(/\bGuestQuotaExceededError\b/);
    expect(src).not.toMatch(/\bGuestAgeAttestationError\b/);
    expect(src).not.toMatch(/\bGuestPublishDisabledError\b/);
    expect(src).not.toMatch(/\bShareResultGuest\b/);
  });

  it('guest executor module does not import AuthStatus, PublicConfig, or account-only error types', () => {
    const path = resolve(
      __dirname,
      '..',
      '..',
      'lab/js/runtime/publish-prepared-guest-capsule.ts',
    );
    const src = stripComments(readFileSync(path, 'utf8'));
    expect(src).not.toMatch(/\bAuthStatus\b/);
    expect(src).not.toMatch(/\bPublicConfig\b/);
    expect(src).not.toMatch(/\bAgeConfirmationRequiredError\b/);
    expect(src).not.toMatch(/\bAuthRequiredError\b/);
    expect(src).not.toMatch(/\bShareResultAccount\b/);
  });

  it('TimelineBar share-surface gate is mode-neutral (regression guard against re-introducing an account-only entry predicate)', () => {
    // The Share entry surface must light up whenever there is a
    // range AND at least one full-publish executor is wired —
    // account, guest, or both. A previous form gated solely on
    // `onPublishFullAccountCapsule`, which would hide the share
    // surface entirely if a future config disabled the account path
    // but kept guest enabled. The `dispatchShareSubmit` seam already
    // resolves the target at submit time; this regression test
    // pins the entry predicate to that mode-neutral shape.
    const path = resolve(
      __dirname,
      '..',
      '..',
      'lab/js/components/timeline/TimelineBar.tsx',
    );
    const src = readFileSync(path, 'utf8');
    // The gate is named `canOpenShareSurface` and references both
    // executor callback names in its definition.
    const gateMatch = src.match(
      /canOpenShareSurface\s*=\s*hasRange\s*&&\s*\([^)]*onPublishFullAccountCapsule[^)]*onPublishFullGuestCapsule[^)]*\)/,
    );
    expect(gateMatch).not.toBeNull();
  });

  it('trim-submit-coordinator does not import from the Zustand store layer (clean runtime/store separation)', () => {
    // The coordinator is a pure runtime/domain seam. Auth + config
    // contract types live in `share-auth-types.ts` so runtime modules
    // can consume them without depending on the store. A regression
    // here would re-couple the publish layer to UI state ownership.
    const path = resolve(
      __dirname,
      '..',
      '..',
      'lab/js/runtime/trim-submit-coordinator.ts',
    );
    const src = stripComments(readFileSync(path, 'utf8'));
    expect(src).not.toMatch(/from\s+['"][^'"]*\/store\/app-store['"]/);
    expect(src).toMatch(/from\s+['"]\.\/share-auth-types['"]/);
  });

  it('prepared-capsule service is mode-neutral (imports neither account nor guest result types)', () => {
    const path = resolve(
      __dirname,
      '..',
      '..',
      'lab/js/runtime/prepared-capsule-service.ts',
    );
    const src = stripComments(readFileSync(path, 'utf8'));
    expect(src).not.toMatch(/\bShareResultAccount\b/);
    expect(src).not.toMatch(/\bShareResultGuest\b/);
    expect(src).not.toMatch(/\bGuestTurnstileError\b/);
    expect(src).not.toMatch(/\bAuthRequiredError\b/);
  });

  it('TimelineBar does not import ShareResultAccount or ShareResultGuest for trim-prepare paths (Acceptance #5)', () => {
    const path = resolve(
      __dirname,
      '..',
      '..',
      'lab/js/components/timeline/TimelineBar.tsx',
    );
    const src = readFileSync(path, 'utf8');
    // The file imports the discriminated union `ShareResult` for the
    // success-branch UI; it must NOT pull in the per-target type
    // aliases for trim-prepare wiring.
    expect(src).not.toMatch(/import\s+[^;]*\bShareResultAccount\b/);
    expect(src).not.toMatch(/import\s+[^;]*\bShareResultGuest\b/);
  });

  it('TimelineBar contains exactly one call site per executor callback AND all four share one enclosing block (Acceptance #12 structural check)', () => {
    const path = resolve(
      __dirname,
      '..',
      '..',
      'lab/js/components/timeline/TimelineBar.tsx',
    );
    const src = readFileSync(path, 'utf8');
    // Count actual invocations (`callbacks?.…(` or `callbacks.…(`),
    // not signature/type references.
    const findInvocation = (re: RegExp): number => {
      const m = src.match(re);
      return m ? m.length : 0;
    };
    const accountFullRe = /callbacks(?:\?)?\.onPublishFullAccountCapsule\(/g;
    const guestFullRe = /callbacks(?:\?)?\.onPublishFullGuestCapsule\(/g;
    const accountPreparedRe = /callbacks(?:\?)?\.onPublishPreparedAccountCapsule\(/g;
    const guestPreparedRe = /callbacks(?:\?)?\.onPublishPreparedGuestCapsule\(/g;
    expect(findInvocation(accountFullRe)).toBe(1);
    expect(findInvocation(guestFullRe)).toBe(1);
    expect(findInvocation(accountPreparedRe)).toBe(1);
    expect(findInvocation(guestPreparedRe)).toBe(1);

    // Acceptance #12 same-switch shape: all four invocations must
    // live inside the same coordinator-dispatch helper. We assert
    // that the four call sites are bracketed by exactly one shared
    // function declaration whose name is `dispatchShareSubmit`. A
    // refactor that scattered the calls into separate handlers would
    // break this — they would no longer share an enclosing function.
    const dispatcherStart = src.indexOf('const dispatchShareSubmit');
    expect(dispatcherStart).toBeGreaterThan(-1);
    // The dispatcher closes at `}, [callbacks, authStatus, publicConfig]);` —
    // walk forward to find the matching closing brace + dependency
    // array. We use the closing dependency-array signature (which is
    // unique to this dispatcher) as the boundary marker.
    const dispatcherEnd = src.indexOf(
      '}, [callbacks, authStatus, publicConfig]);',
      dispatcherStart,
    );
    expect(dispatcherEnd).toBeGreaterThan(dispatcherStart);
    const dispatcherBody = src.slice(dispatcherStart, dispatcherEnd);
    expect(dispatcherBody.match(accountFullRe)?.length ?? 0).toBe(1);
    expect(dispatcherBody.match(guestFullRe)?.length ?? 0).toBe(1);
    expect(dispatcherBody.match(accountPreparedRe)?.length ?? 0).toBe(1);
    expect(dispatcherBody.match(guestPreparedRe)?.length ?? 0).toBe(1);
  });

  it('snapshot recheck (assertPreparedCapsuleFresh) is only called from the two executor modules — repo-wide negative grep (Acceptance #9)', () => {
    const repoRoot = resolve(__dirname, '..', '..');
    const accountExec = readFileSync(resolve(repoRoot, 'lab/js/runtime/publish-prepared-account-capsule.ts'), 'utf8');
    const guestExec = readFileSync(resolve(repoRoot, 'lab/js/runtime/publish-prepared-guest-capsule.ts'), 'utf8');
    expect(accountExec).toMatch(/assertPreparedCapsuleFresh/);
    expect(guestExec).toMatch(/assertPreparedCapsuleFresh/);

    // Negative grep: walk every .ts/.tsx under lab/ and src/ and
    // assert that `assertPreparedCapsuleFresh(` is invoked ONLY in
    // the two executor files (the service is the *definition* site
    // and is allowed to mention the symbol; the executors are the
    // *only call sites*). This prevents a third caller from sneaking
    // in undetected.
    const allowedDefinitionFile = resolve(repoRoot, 'lab/js/runtime/prepared-capsule-service.ts');
    const allowedCallSites = new Set([
      resolve(repoRoot, 'lab/js/runtime/publish-prepared-account-capsule.ts'),
      resolve(repoRoot, 'lab/js/runtime/publish-prepared-guest-capsule.ts'),
    ]);
    const violations: string[] = [];
    for (const root of ['lab/js', 'src']) {
      walkSourceFiles(resolve(repoRoot, root), (filePath) => {
        if (filePath === allowedDefinitionFile) return;
        const body = readFileSync(filePath, 'utf8');
        if (/assertPreparedCapsuleFresh\(/.test(body) && !allowedCallSites.has(filePath)) {
          violations.push(filePath);
        }
      });
    }
    expect(violations).toEqual([]);

    // No other module performs an inline `range.snapshotId !== currentVersion`
    // check. The service throws `CapsuleSnapshotStaleError` from inside
    // `assertPreparedCapsuleFresh` only — verifying no inline snapshotId
    // comparison exists outside the service is structural intent.
    const service = readFileSync(allowedDefinitionFile, 'utf8');
    expect(service).toMatch(/range\.snapshotId !== currentVersion/);

    // And no other file inlines the same comparison.
    const inlineRegex = /range\.snapshotId\s*!==\s*[A-Za-z_][\w.]*Version/;
    const inlineViolations: string[] = [];
    for (const root of ['lab/js', 'src']) {
      walkSourceFiles(resolve(repoRoot, root), (filePath) => {
        if (filePath === allowedDefinitionFile) return;
        const body = readFileSync(filePath, 'utf8');
        if (inlineRegex.test(body)) inlineViolations.push(filePath);
      });
    }
    expect(inlineViolations).toEqual([]);
  });
});

/** Recursively walk .ts/.tsx files under `dir`, invoking `visit` for
 *  each. Skips node_modules and worktree caches. */
function walkSourceFiles(dir: string, visit: (filePath: string) => void): void {
  // Lazy import so the test file's top-level imports stay focused on
  // production-relevant types.
  const { readdirSync, statSync } = require('node:fs') as typeof import('node:fs');
  const { join } = require('node:path') as typeof import('node:path');
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue;
    const full = join(dir, entry);
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      walkSourceFiles(full, visit);
    } else if (st.isFile() && (full.endsWith('.ts') || full.endsWith('.tsx'))) {
      visit(full);
    }
  }
}
