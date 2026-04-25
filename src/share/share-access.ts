/**
 * Capsule access recording — thresholded `last_accessed_at` writer plus
 * its companion route-level freshness predicate.
 *
 * Replaces the prior write-on-read pattern at
 * functions/api/capsules/[code].ts. The shipped design is two layers:
 *
 *   1. **Route-level gate** — callers invoke `shouldRecordShareAccess`
 *      against the SELECTed row BEFORE scheduling background work.
 *      Fresh rows short-circuit here, so D1 sees zero write queries on
 *      repeat reads. This is what actually unburdens the read-heavy
 *      path (D1 forwards every UPDATE to primary regardless of
 *      `meta.changes`).
 *   2. **Conditional UPDATE** — `recordShareAccessIfStale` issues a
 *      single conditional UPDATE that re-checks the same predicate in
 *      SQL. Race-safety for concurrent readers that both pass the gate
 *      from the same stale snapshot.
 *
 * Both layers reference `LAST_ACCESSED_WRITE_WINDOW_MS` and apply the
 * same `NULL OR stored < staleBeforeIso` predicate. Centralizing the
 * JS computation in `shouldRecordShareAccess` removes the only seam
 * the route would otherwise own; the SQL string is the necessary
 * second copy of the predicate but it is parameterized over the same
 * `staleBeforeIso` value.
 *
 * Owns:        write-window policy, route-level freshness predicate,
 *              conditional UPDATE SQL, missing-`meta` fallback
 * Depends on:  ./d1-types (LOCAL shim only — `src/share/*` is also
 *              compiled by the frontend tsconfig and Workers types are
 *              unavailable there; see d1-types.ts header)
 * Called by:   functions/api/capsules/[code].ts (gate + waitUntil
 *              wrapper + console.error catch)
 */

import type { D1Database } from './d1-types';

/**
 * Single source of truth for the access write window. One hour: large
 * enough to absorb cache-bypassing repeat traffic (bots, unfurlers,
 * server-to-server callers, `Cache-Control: no-cache` refreshes), small
 * enough to keep "last accessed" useful for admin/account UIs.
 */
export const LAST_ACCESSED_WRITE_WINDOW_MS = 60 * 60 * 1000;

/**
 * Module-scoped guard mirroring src/share/capsule-preview-heal.ts:61.
 * Emits a single `[share-access] d1-shape-unknown` warning per isolate
 * when D1 returns a result with no `meta` field. Enough signal to
 * trigger investigation; not enough to spam the warn stream under
 * sustained degradation.
 */
let d1ShapeUnknownWarned = false;

/** Test-only: reset the warn-once flag between cases. NOT exported from
 *  the production surface — only re-exported below for the testing
 *  helper to bind. */
function _resetD1ShapeUnknownWarnedForTesting(): void {
  d1ShapeUnknownWarned = false;
}

/**
 * Compute the production "stale before" boundary for a given `nowIso`.
 *
 * Single seam for the threshold math: every JS caller that needs the
 * cutoff (route gate, helper SQL bind, future telemetry) routes through
 * this function so a window-policy change has exactly one site.
 *
 * Contract: `nowIso` MUST be the output of `new Date(...).toISOString()`
 * (millisecond-width UTC). A malformed input throws a named error
 * synchronously rather than corrupting the bind value — important
 * because this function is called from the route gate OUTSIDE the
 * `recordShareAccessIfStale(...).catch(...)` chain, so a silent
 * `RangeError: Invalid time value` would otherwise surface as an
 * unlogged 500.
 */
export function computeShareAccessStaleBeforeIso(nowIso: string): string {
  const t = Date.parse(nowIso);
  if (!Number.isFinite(t)) {
    throw new Error(`[share-access] invalid nowIso: ${JSON.stringify(nowIso)}`);
  }
  return new Date(t - LAST_ACCESSED_WRITE_WINDOW_MS).toISOString();
}

/**
 * Route-level freshness predicate. Returns `true` when the route should
 * schedule a background access-recording write, `false` when the row is
 * already fresh inside the window and the route should short-circuit
 * without issuing any UPDATE.
 *
 * This is the **JS-side** mirror of the helper's SQL conditional. Both
 * compare against the same `staleBeforeIso` from
 * `computeShareAccessStaleBeforeIso(nowIso)`, so the two layers cannot
 * drift on the threshold value.
 *
 * Callers MUST invoke this against the SELECTed row before
 * `context.waitUntil(recordShareAccessIfStale(...))`.
 */
export function shouldRecordShareAccess(
  lastAccessedAt: string | null,
  nowIso: string,
): boolean {
  // Validate `nowIso` BEFORE the NULL short-circuit so a malformed
  // input surfaces the same named error on every code path. Otherwise
  // bad input would only fail when there is an existing
  // `last_accessed_at`, producing inconsistent behavior across rows.
  const staleBeforeIso = computeShareAccessStaleBeforeIso(nowIso);
  if (lastAccessedAt === null) return true;
  return lastAccessedAt < staleBeforeIso;
}

/**
 * Record `last_accessed_at = nowIso` on the row IFF the stored value is
 * NULL or strictly older than `staleBeforeIso = nowIso - windowMs`.
 *
 * **Best-effort.** Rejects on D1 error. Callers MUST wrap in
 * `context.waitUntil(...)` and `.catch(console.error)`. The route MUST
 * NOT await the result on the response critical path.
 *
 * Returns `{ written: true }` when exactly one row was updated, and
 * `{ written: false }` otherwise. Two distinct causes produce the
 * "false" outcome and the helper does not distinguish them:
 *  1. Threshold not crossed — stored timestamp is newer than the window
 *     (the normal repeat-read case).
 *  2. Concurrent-delete race — the row was deleted between the SELECT
 *     and this UPDATE (rare; see capsule-preview-heal.ts:152-158 for
 *     the same pattern on a sibling write path).
 *
 * Missing-`meta` semantics (D1 result with no `meta` field — older
 * Workers runtimes or a mocked binding in tests): treated as
 * `{ written: false }` and a one-time `[share-access] d1-shape-unknown`
 * warning is emitted via the module guard above.
 *
 * Implementation note: reads `meta.changes` via a local structural
 * cast rather than widening `./d1-types`, matching the precedent at
 * src/share/capsule-preview-heal.ts:164-172.
 */
export async function recordShareAccessIfStale(
  db: D1Database,
  shareId: string,
  nowIso: string,
): Promise<{ written: boolean }> {
  return runConditionalUpdate(db, shareId, nowIso, LAST_ACCESSED_WRITE_WINDOW_MS);
}

/**
 * Test-only override of `recordShareAccessIfStale` that accepts a
 * `windowMs` parameter. Production code MUST call
 * `recordShareAccessIfStale` (which pins `LAST_ACCESSED_WRITE_WINDOW_MS`)
 * — the override exists only so unit tests can pin boundary behavior
 * without depending on real time.
 *
 * `windowMs = 0` is **not** an unconditional update: it collapses the
 * predicate to `last_accessed_at < nowIso`, so a second call with the
 * same `nowIso` (or two calls landing in the same millisecond-width
 * ISO) will observe `{ written: false }`. Tests that need to pin
 * "advances on later instant" MUST pass two distinct ISO instants.
 *
 * Also exposes `_resetD1ShapeUnknownWarnedForTesting` so the
 * missing-`meta` warn-once invariant can be exercised across cases.
 */
export async function _recordShareAccessIfStaleForTesting(
  db: D1Database,
  shareId: string,
  nowIso: string,
  windowMs: number,
): Promise<{ written: boolean }> {
  return runConditionalUpdate(db, shareId, nowIso, windowMs);
}

export { _resetD1ShapeUnknownWarnedForTesting };

async function runConditionalUpdate(
  db: D1Database,
  shareId: string,
  nowIso: string,
  windowMs: number,
): Promise<{ written: boolean }> {
  // Lexical-ISO predicate: every production *_at writer goes through
  // `new Date().toISOString()` (fixed-width UTC, ms precision). Avoids
  // `unixepoch()`, which the rest of this codebase does not use.
  //
  // The route-level seam is `computeShareAccessStaleBeforeIso` /
  // `shouldRecordShareAccess`; once the gate has passed, the helper
  // just needs the value, not a second routing through the constant.
  // The test-only override accepts an arbitrary `windowMs` so that
  // boundary tests can pin behavior at `windowMs = 0`.
  const t = Date.parse(nowIso);
  if (!Number.isFinite(t)) {
    throw new Error(`[share-access] invalid nowIso: ${JSON.stringify(nowIso)}`);
  }
  const staleBeforeIso = new Date(t - windowMs).toISOString();
  const sql =
    'UPDATE capsule_share SET last_accessed_at = ? ' +
    'WHERE id = ? AND (last_accessed_at IS NULL OR last_accessed_at < ?)';
  const result = await db.prepare(sql).bind(nowIso, shareId, staleBeforeIso).run();

  // Local structural cast — see header note. The shared shim (./d1-types)
  // intentionally does not declare `meta`.
  const rawMeta = (result as { meta?: { changes?: number } })?.meta;
  if (rawMeta === undefined && !d1ShapeUnknownWarned) {
    d1ShapeUnknownWarned = true;
    console.warn(
      `[share-access] d1-shape-unknown — result missing .meta; written counter will report false`,
    );
  }
  const changes = rawMeta?.changes ?? 0;
  return { written: changes >= 1 };
}
