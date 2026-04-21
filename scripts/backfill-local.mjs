/**
 * One-shot local backfill: walks the Miniflare D1 sqlite, reads each
 * capsule blob directly from the R2 blob filesystem, projects the
 * preview scene via the real `projectCapsuleToSceneJson` code path, and
 * writes it back to `preview_scene_v1`.
 *
 * Runs against the dev state under .wrangler/. Not for production.
 *
 *   node scripts/backfill-local.mjs              # rebake null + out-of-rev
 *   node scripts/backfill-local.mjs --force      # rebake every row
 *
 * `--force` is the operator escape hatch when an algorithm change needs
 * to propagate to every stored row. Without it, the script only rebakes
 * rows where the stored thumb's `rev` is behind `CURRENT_THUMB_REV` (or
 * where `preview_scene_v1` is null altogether).
 *
 * Implementation note: the repo is `"type": "commonjs"` with no `tsx`
 * dependency, so Node cannot natively `import('src/.../foo.ts')`.
 * Instead we use the already-installed `esbuild` to bundle the few
 * required TS entrypoints into a tmp `.mjs` on the fly and import from
 * that. This keeps the script runnable with zero new dev-dependencies
 * and mirrors what the production `capsule-preview:backfill:prod` path
 * does under the hood (esbuild is also how wrangler bundles the
 * admin-endpoint code at runtime).
 */

import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';
import esbuild from 'esbuild';

const ROOT = path.dirname(path.dirname(url.fileURLToPath(import.meta.url)));
const D1_PATH = path.join(ROOT, '.wrangler/state/v3/d1/miniflare-D1DatabaseObject/9d4da4f0a2e26de0c84d02e70c79421651e62693dca0c5359a728d0c3453618e.sqlite');
const R2_DB = path.join(ROOT, '.wrangler/state/v3/r2/miniflare-R2BucketObject/bb6cf21e130fb558bc07bd9874442047a6ec76c18caf34d42d110aedaafb7cde.sqlite');
const R2_BLOBS = path.join(ROOT, '.wrangler/state/v3/r2/atomdojo-capsules-prod/blobs');

const force = process.argv.includes('--force');

/** Bundle a TS entrypoint into a tmp ESM .mjs and import from it. */
async function loadTsBundle(relativeTsPath) {
  const entry = path.join(ROOT, relativeTsPath);
  const outFile = path.join(
    os.tmpdir(),
    `backfill-local-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`,
  );
  await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    outfile: outFile,
    logLevel: 'error',
  });
  try {
    return await import(url.pathToFileURL(outFile).href);
  } finally {
    // Keep the tmp file around in case an import error surfaces a stack
    // trace pointing at it; the OS reaps /tmp on reboot anyway.
  }
}

const publishCore = await loadTsBundle('src/share/publish-core.ts');
const historyV1 = await loadTsBundle('src/history/history-file-v1.ts');
const sceneStore = await loadTsBundle('src/share/capsule-preview-scene-store.ts');
const { projectCapsuleToSceneJson } = publishCore;
const { validateCapsuleFile } = historyV1;
const { CURRENT_THUMB_REV } = sceneStore;

const d1 = new DatabaseSync(D1_PATH);
const r2 = new DatabaseSync(R2_DB, { readOnly: true });

// Select rows whose stored scene is missing, or whose embedded thumb
// revision is behind the current pipeline, or every row if `--force`.
// The `json_extract` guards are safe against rows without a thumb —
// `json_extract(null, '$.thumb.rev')` returns null, which compares as
// `< CURRENT_THUMB_REV` in SQLite's type coercion.
const predicate = force
  ? ''
  : `AND (preview_scene_v1 IS NULL
         OR IFNULL(json_extract(preview_scene_v1, '$.thumb.rev'), 0) < ${CURRENT_THUMB_REV})`;

const rows = d1.prepare(
  `SELECT id, object_key, share_code FROM capsule_share
    WHERE object_key IS NOT NULL
      AND kind = 'capsule'
      AND status = 'ready'
      ${predicate}`,
).all();

console.log(`[backfill] ${rows.length} rows to process${force ? ' (--force: every row)' : ''}`);
const blobLookup = r2.prepare('SELECT blob_id FROM _mf_objects WHERE key = ?');
const update = d1.prepare('UPDATE capsule_share SET preview_scene_v1 = ? WHERE id = ?');

let updated = 0, skipped = 0, failed = 0;
for (const row of rows) {
  try {
    const meta = blobLookup.get(row.object_key);
    if (!meta) { console.warn(`[backfill] ${row.share_code}: no R2 object`); skipped++; continue; }
    const blobPath = path.join(R2_BLOBS, meta.blob_id);
    if (!fs.existsSync(blobPath)) { console.warn(`[backfill] ${row.share_code}: blob file missing`); skipped++; continue; }
    const text = fs.readFileSync(blobPath, 'utf8');
    const parsed = JSON.parse(text);
    const errors = validateCapsuleFile(parsed);
    if (errors.length > 0) { console.warn(`[backfill] ${row.share_code}: invalid capsule: ${errors[0]}`); failed++; continue; }
    const sceneJson = projectCapsuleToSceneJson(parsed);
    if (!sceneJson) { console.warn(`[backfill] ${row.share_code}: projection returned null`); failed++; continue; }
    update.run(sceneJson, row.id);
    updated++;
    console.log(`[backfill] ${row.share_code}: ok (${sceneJson.length}b)`);
  } catch (err) {
    // Stack trace is operator-visible by design — this script is only
    // run interactively by devs, so verbosity is a feature. Collapsing
    // to err.message previously hid whether a failure was a parse vs.
    // project vs. D1 write problem.
    const trace = err instanceof Error && err.stack ? err.stack : String(err);
    console.warn(`[backfill] ${row.share_code}: ${trace}`);
    failed++;
  }
}

console.log(`[backfill] done — updated=${updated} skipped=${skipped} failed=${failed}`);
