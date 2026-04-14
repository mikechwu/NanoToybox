/**
 * POST /api/admin/sweep/orphans — delete R2 objects that have no
 * matching capsule_share row and are older than a safety threshold.
 *
 * Protects against the narrow window where an R2 put succeeds but the
 * subsequent D1 persist fails AND the synchronous rollback also fails
 * (double network failure). Such blobs become invisible to the read
 * path but still cost storage.
 *
 * Safety:
 *   - Only deletes blobs older than ORPHAN_MIN_AGE_MS (default 24h).
 *   - Only touches objects under the 'capsules/' prefix.
 *   - Records one audit event per deletion.
 *
 * Runs from an admin-gated endpoint — intended to be invoked by a
 * Cloudflare Cron Trigger in production (see wrangler.toml notes) or
 * manually in local dev via curl.
 */

import type { Env } from '../../../env';
import { requireAdminOr404 } from '../../../admin-gate';
import { recordAuditEvent } from '../../../../src/share/audit';

// 24-hour age floor.
//
// This must stay safely larger than the maximum lifetime of a single
// publish request. Cloudflare Pages Functions are hard-capped at 30s
// wall-time (CPU-time is tighter), so "in-flight publish between R2 put
// and D1 persist" cannot exceed a few seconds in practice. 24h is
// ~2800× that, comfortably safe.
//
// If the architecture ever changes (e.g. async publish via a queue,
// resumable large uploads), revisit this constant BEFORE enabling the
// new path — a background job that holds an unpublished R2 object for
// longer than this threshold would be swept out from under itself.
const ORPHAN_MIN_AGE_MS = 24 * 60 * 60 * 1000; // 24h
const DEFAULT_MAX_DELETE = 100;
const R2_PREFIX = 'capsules/';

export const onRequestPost: PagesFunction<Env> = async (context) => {
  const { request, env } = context;

  const denied = requireAdminOr404(request, env);
  if (denied) return denied;

  const url = new URL(request.url);
  const maxDelete = Math.max(
    1,
    Math.min(1000, parseInt(url.searchParams.get('max') ?? String(DEFAULT_MAX_DELETE), 10) || DEFAULT_MAX_DELETE),
  );
  const dryRun = url.searchParams.get('dry') === '1';

  const now = Date.now();
  let scanned = 0;
  let candidates = 0;
  const deletedKeys: string[] = [];
  let cursor: string | undefined;

  do {
    const listing = await env.R2_BUCKET.list({
      prefix: R2_PREFIX,
      cursor,
      limit: 1000,
    });
    cursor = listing.truncated ? listing.cursor : undefined;

    for (const obj of listing.objects) {
      scanned++;
      // Safe fallback: if R2 ever drops the `uploaded` field (API change),
      // treat the object as "just now" so it is preserved. Log loudly so
      // the contract change surfaces in ops rather than silently breaking
      // the sweeper.
      let uploadedMs: number;
      if (obj.uploaded instanceof Date) {
        uploadedMs = obj.uploaded.getTime();
      } else {
        console.error(
          `[sweep/orphans] missing obj.uploaded for ${obj.key} — R2 API contract drift? [id=R2_UPLOADED_MISSING]`,
        );
        uploadedMs = Date.now();
      }
      if (now - uploadedMs < ORPHAN_MIN_AGE_MS) continue; // too new; skip

      // Is there a D1 row pointing at this object?
      const row = await env.DB.prepare(
        'SELECT 1 AS hit FROM capsule_share WHERE object_key = ? LIMIT 1',
      )
        .bind(obj.key)
        .first<{ hit: number }>();

      if (row) continue; // not an orphan

      candidates++;
      if (deletedKeys.length >= maxDelete) continue;

      if (!dryRun) {
        try {
          await env.R2_BUCKET.delete(obj.key);
          deletedKeys.push(obj.key);
          await recordAuditEvent(env.DB, {
            eventType: 'orphan_swept',
            actor: 'sweeper',
            severity: 'info',
            reason: `orphan r2 object aged ${Math.round((now - uploadedMs) / 3600000)}h`,
            details: { objectKey: obj.key, uploadedAt: new Date(uploadedMs).toISOString() },
          });
        } catch (err) {
          console.error(
            `[sweep/orphans] delete failed for ${obj.key}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      } else {
        deletedKeys.push(obj.key);
      }
    }
  } while (cursor && deletedKeys.length < maxDelete);

  return Response.json({
    scanned,
    candidates,
    deleted: deletedKeys.length,
    dryRun,
    deletedKeys: deletedKeys.slice(0, 50), // preview; full list in audit log
  });
};
