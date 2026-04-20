/**
 * Production-exclusion contract for the preview-audit entry.
 *
 * The audit page is a dev-only workbench that loads arbitrary
 * `*.json` capsules — shipping it to the production bundle would
 * expose an unauthenticated client-side pipeline that never makes it
 * past auth review. The gate is split across two layers:
 *
 *   1. `vite.config.ts` only registers the Rollup input when
 *      `command === 'serve' || PREVIEW_AUDIT_BUILD === '1'`.
 *   2. `preview-audit/main.tsx` throws on `import.meta.env.PROD`
 *      as defence-in-depth.
 *
 * Both are static contracts and neither is enforced by the type
 * system; a well-meaning Vite refactor could relax them. This test
 * runs the real production build programmatically and asserts the
 * audit page does NOT reach the output in any emitted shape.
 *
 * Three layered guards:
 *   (a) Primary — inspect the Rollup bundle returned by `build()`:
 *       no chunk or asset whose `fileName` contains `preview-audit`,
 *       no chunk whose `facadeModuleId` or any imported module
 *       traces back to `preview-audit/`.
 *   (b) Secondary — walk the outDir recursively and fail on any file
 *       name containing `preview-audit`. Catches anything Vite might
 *       emit outside the bundle contract (copied statics, etc.).
 *   (c) Tertiary — the legacy filesystem heuristics (no `preview-
 *       audit/` folder, no `preview-audit-*` asset chunk) stay as a
 *       readable sanity check.
 *
 * Budget: this test actually runs `vite build` so it's slow (~1–3s).
 * Keeps the write off the main `dist/` by routing the build to a
 * scoped out-directory under the OS tmp dir.
 */

import { describe, it, expect, afterAll } from 'vitest';
import { build, type Rollup } from 'vite';
import { resolve, sep } from 'node:path';
import { mkdtempSync, rmSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';

const REPO_ROOT = resolve(__dirname, '..', '..');
const FORBIDDEN = 'preview-audit';

/** Collect every file under `dir` recursively, returning paths
 *  relative to `dir`. Node 20+ supports `readdirSync(..., { recursive:
 *  true })` but the older form is fine and gives us explicit control. */
function walkFilesRelative(dir: string): string[] {
  const out: string[] = [];
  function step(sub: string) {
    for (const entry of readdirSync(resolve(dir, sub), { withFileTypes: true })) {
      const child = sub ? `${sub}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        step(child);
      } else {
        out.push(child);
      }
    }
  }
  step('');
  return out;
}

/** Normalize a `Rollup.RollupOutput | Rollup.RollupOutput[] | Rollup.RollupWatcher`
 *  return from `build()` into a flat list of bundle entries. */
function flattenBundle(
  result: Awaited<ReturnType<typeof build>>,
): Array<Rollup.OutputChunk | Rollup.OutputAsset> {
  const outputs = Array.isArray(result) ? result : [result];
  const out: Array<Rollup.OutputChunk | Rollup.OutputAsset> = [];
  for (const o of outputs) {
    // Watcher mode is not applicable here, but guard the type anyway.
    if ('output' in o) out.push(...o.output);
  }
  return out;
}

describe('preview-audit production exclusion', () => {
  let outDir: string | null = null;
  afterAll(() => {
    if (outDir && existsSync(outDir)) {
      rmSync(outDir, { recursive: true, force: true });
    }
  });

  it('production build does NOT emit preview-audit anywhere (bundle + outDir)', async () => {
    outDir = mkdtempSync(resolve(tmpdir(), 'nt-audit-build-'));

    // Default production path: PREVIEW_AUDIT_BUILD unset. If someone
    // enables it in CI by mistake, the default path must still fail
    // loudly — so we strip the var here instead of letting the outer
    // environment influence the test. Restore on the way out.
    const previousEnv = process.env.PREVIEW_AUDIT_BUILD;
    delete process.env.PREVIEW_AUDIT_BUILD;

    let result: Awaited<ReturnType<typeof build>>;
    try {
      result = await build({
        root: REPO_ROOT,
        logLevel: 'error',
        build: {
          outDir,
          emptyOutDir: true,
          reportCompressedSize: false,
          minify: false,
        },
      });
    } finally {
      if (previousEnv !== undefined) process.env.PREVIEW_AUDIT_BUILD = previousEnv;
    }

    // ── Guard (a) — bundle-level: inspect what Rollup actually emitted ──
    const bundle = flattenBundle(result);
    expect(bundle.length).toBeGreaterThan(0);

    const offendingByFileName = bundle
      .filter((e) => e.fileName.includes(FORBIDDEN))
      .map((e) => `${e.type}:${e.fileName}`);
    expect(offendingByFileName).toEqual([]);

    // Any chunk whose facade or imported module path references the
    // preview-audit source tree is a silent smuggling shape — e.g. a
    // chunk gets renamed `foo.js` but still includes audit source.
    const offendingBySource: string[] = [];
    for (const entry of bundle) {
      if (entry.type !== 'chunk') continue;
      const facadeHit =
        entry.facadeModuleId && entry.facadeModuleId.includes(`${sep}${FORBIDDEN}${sep}`);
      const moduleHit = Object.keys(entry.modules ?? {}).some((m) =>
        m.includes(`${sep}${FORBIDDEN}${sep}`),
      );
      if (facadeHit || moduleHit) {
        offendingBySource.push(entry.fileName);
      }
    }
    expect(offendingBySource).toEqual([]);

    // ── Guard (b) — disk-level: recursive walk of outDir ────────────────
    const allFiles = walkFilesRelative(outDir);
    const diskLeaks = allFiles.filter((f) => f.includes(FORBIDDEN));
    expect(diskLeaks).toEqual([]);

    // ── Guard (c) — legacy heuristics (cheap, readable) ─────────────────
    expect(existsSync(resolve(outDir, 'preview-audit'))).toBe(false);
    expect(existsSync(resolve(outDir, 'preview-audit.html'))).toBe(false);
    const assetsDir = resolve(outDir, 'assets');
    if (existsSync(assetsDir)) {
      const assetLeaks = readdirSync(assetsDir).filter((n) =>
        n.startsWith('preview-audit'),
      );
      expect(assetLeaks).toEqual([]);
    }
  }, 30_000);
});
