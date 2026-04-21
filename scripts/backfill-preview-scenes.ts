/**
 * scripts/backfill-preview-scenes.ts — pure library for populating
 * `capsule_share.preview_scene_v1` on legacy rows (spec §S1 backfill,
 * ADR D138 rollout).
 *
 * Idempotent; safe to re-run. The poster route's lazy-backfill path
 * handles any row this function misses, so a deploy can land before a
 * full sweep completes.
 *
 * **This module has no CLI entrypoint by design.** Do not add a
 * `main()` or `import.meta.url` guard — the repo is `"type":
 * "commonjs"` with no `tsx` dependency, and the production runtime
 * model for "needs D1 + R2 bindings" is a Pages Function, not a
 * standalone Node script. Consumers:
 *
 * - Production: `POST /api/admin/backfill-preview-scenes`
 *   (`functions/api/admin/backfill-preview-scenes.ts`), called via
 *   `npm run capsule-preview:backfill:prod` which POSTs to that
 *   admin-gated endpoint from
 *   `scripts/backfill-preview-scenes-prod.mjs`.
 * - Local dev: `npm run capsule-preview:backfill:local` (runs
 *   `scripts/backfill-local.mjs` against the Miniflare state).
 * - Tests: `tests/unit/*.test.ts` import `backfillPreviewScenes`
 *   directly.
 */

import type { AtomDojoPlaybackCapsuleFileV1 } from '../src/history/history-file-v1';
import { validateCapsuleFile } from '../src/history/history-file-v1';
import { projectCapsuleToSceneJson } from '../src/share/publish-core';

interface D1Like {
  prepare(sql: string): {
    bind(...args: unknown[]): {
      all<T>(): Promise<{ results: T[] }>;
      run(): Promise<unknown>;
    };
  };
}

interface R2Like {
  get(key: string): Promise<{ text(): Promise<string> } | null>;
}

interface BackfillOptions {
  db: D1Like;
  r2: R2Like;
  /** Page size for the SELECT loop. Keeps memory bounded on large datasets. */
  pageSize?: number;
  /** When true, log each row's outcome at INFO level. */
  verbose?: boolean;
  /** When true, rebake every row regardless of current thumb revision.
   *  Default: rebake only rows with `preview_scene_v1 IS NULL` OR whose
   *  embedded `thumb.rev` is behind the current pipeline. */
  force?: boolean;
  /** Current thumb-pipeline revision. Pass `CURRENT_THUMB_REV` from
   *  `capsule-preview-scene-store.ts`; exposed as a parameter so this
   *  script stays decoupled from that module's internals. */
  currentThumbRev: number;
}

interface BackfillSummary {
  scanned: number;
  updated: number;
  skipped: number;
  failed: Array<{ id: string; reason: string }>;
}

/**
 * Run the backfill over every `capsule_share` row with `preview_scene_v1 IS NULL`.
 * Returns a summary so callers can decide whether to re-run or investigate
 * failed rows individually.
 */
export async function backfillPreviewScenes(opts: BackfillOptions): Promise<BackfillSummary> {
  const { db, r2 } = opts;
  const pageSize = opts.pageSize ?? 100;
  const summary: BackfillSummary = {
    scanned: 0,
    updated: 0,
    skipped: 0,
    failed: [],
  };

  const selectionPredicate = opts.force
    ? ''
    : `AND (preview_scene_v1 IS NULL
           OR IFNULL(json_extract(preview_scene_v1, '$.thumb.rev'), 0) < ${opts.currentThumbRev})`;

  while (true) {
    const page = await db.prepare(
      `SELECT id, object_key FROM capsule_share
        WHERE object_key IS NOT NULL
          AND kind = 'capsule'
          ${selectionPredicate}
        LIMIT ?`,
    ).bind(pageSize).all<{ id: string; object_key: string }>();

    if (page.results.length === 0) break;
    summary.scanned += page.results.length;

    for (const row of page.results) {
      try {
        const obj = await r2.get(row.object_key);
        if (!obj) {
          summary.skipped += 1;
          summary.failed.push({ id: row.id, reason: 'blob-missing' });
          continue;
        }
        const text = await obj.text();
        const parsed = JSON.parse(text);
        const errors = validateCapsuleFile(parsed);
        if (errors.length > 0) {
          summary.failed.push({ id: row.id, reason: `capsule-invalid:${errors[0]}` });
          continue;
        }
        const sceneJson = projectCapsuleToSceneJson(parsed as AtomDojoPlaybackCapsuleFileV1);
        if (!sceneJson) {
          summary.failed.push({ id: row.id, reason: 'no-scene' });
          continue;
        }
        // In force/rev-mismatch mode, the UPDATE must be unconditional;
        // the legacy IS NULL guard would skip rows that already carry a
        // stale scene. The row-level SELECT gating above has already
        // excluded anything that shouldn't be touched.
        await db.prepare(
          `UPDATE capsule_share SET preview_scene_v1 = ? WHERE id = ?`,
        ).bind(sceneJson, row.id).run();
        summary.updated += 1;
        if (opts.verbose) console.log(`[backfill] ${row.id} updated`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        summary.failed.push({ id: row.id, reason: msg });
      }
    }

    // When the last page returned fewer rows than the page size, we've
    // drained the table.
    if (page.results.length < pageSize) break;
  }

  return summary;
}
