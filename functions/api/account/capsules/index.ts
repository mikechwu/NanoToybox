/**
 * GET /api/account/capsules — list the signed-in user's capsules.
 *
 * Filters to `owner_user_id = ? AND status != 'deleted'`. Tombstoned
 * rows are retained in D1 for audit integrity but should not surface
 * in the Uploads list.
 *
 * Cursor pagination
 * -----------------
 * Each response carries a `nextCursor` string when more rows exist.
 * The cursor encodes the last row's `(created_at, share_code)` pair
 * (joined with `|`, base64url-encoded) so the next page resumes at the
 * correct point even when many capsules share a created_at second.
 *
 * The composite sort `ORDER BY created_at DESC, share_code DESC` is the
 * stable key that makes the cursor work — both the seek-comparison and
 * the ORDER BY use the same pair, so a row is never visited twice and
 * never skipped.
 *
 * Page size is fixed at PAGE_SIZE per call. The previous implementation
 * silently capped at 500 with no cursor, so power users had invisible
 * uploads — see also `delete-all` which loops on `moreAvailable`.
 *
 * V2 capsule preview (spec §Account Integration, post-launch follow-up):
 * each row carries a `previewThumb` field of type
 * {@link PreviewThumbV1 | null}, derived server-side from the
 * `preview_scene_v1` D1 column. **No R2 access on the hot path.**
 *
 * Lazy rebake (ADR D135 follow-up, 2026-04-21)
 * --------------------------------------------
 * On every page load the response also carries `previewPending:
 * string[]` — the share codes whose preview_scene_v1 is being
 * opportunistically rebaked in the background for this request.
 * Staleness covers four reason classes, ordered by priority:
 *
 *   1. `missing`       — preview_scene_v1 IS NULL (cold row)
 *   2. `parse-failed`  — non-null but parsePreviewSceneV1 → null
 *   3. `stale-rev`     — thumb.rev < CURRENT_THUMB_REV
 *   4. `bondless`      — legacy scene with atoms but no bonds anywhere
 *
 * Start cap per request: HEAL_START_CAP_FIRST_PAGE (8) on page 1,
 * HEAL_START_CAP_CURSORED (5) on cursor-paged requests. Cross-request
 * and cross-tab dedup via a 90 s TTL lease on
 * `capsule_share.preview_rebake_claimed_at` — an atomic UPDATE whose
 * `changes === 1` gate is the only mutation point, so two concurrent
 * tabs can never double-heal the same row. See
 * `migrations/0010_capsule_share_preview_rebake_claim.sql`.
 *
 * The batch itself runs via `scheduleBackground` (`ctx.waitUntil`) with
 * a worker pool of HEAL_CONCURRENCY and a HEAL_BUDGET_MS deadline —
 * rows the pool didn't get to before the deadline are logged as
 * `deadlined`. Persistence is tracked separately from in-memory rebake:
 * `rebaked` counts the in-memory projections, `persisted` counts the
 * ones whose D1 UPDATE committed (see `HealResult.persisted`).
 */

import type { Env } from '../../../env';
import { authenticateRequest } from '../../../auth-middleware';
import { noCacheHeaders, noCacheJson } from '../../../http-cache';
import { b64urlEncode, b64urlDecode } from '../../../../src/share/b64url';
import { errorMessage } from '../../../../src/share/error-message';
import {
  parsePreviewSceneV1,
  CURRENT_THUMB_REV,
  type PreviewThumbV1,
} from '../../../../src/share/capsule-preview-scene-store';
import { deriveAccountThumb } from '../../../../src/share/capsule-preview-account-derive';
import {
  rebakeSceneFromR2,
  sceneIsBondless,
} from '../../../../src/share/capsule-preview-heal';
import { scheduleBackground } from '../../../_lib/wait-until';

const PAGE_SIZE = 50;

// Lazy-rebake tunables. See top-of-file docstring + ADR D135 follow-up
// (`docs/decisions.md`). Changing any of these is a user-facing change
// (convergence rate, D1 write volume, worker-time budget).
const HEAL_START_CAP_FIRST_PAGE = 8;
const HEAL_START_CAP_CURSORED = 5;
// Separate caps bound **attempt** cost on the hot path. Without these
// the request would keep issuing lease UPDATEs for every eligible row
// whenever earlier candidates are already lease-held by another tab
// — D1 write volume would scale with the full eligible set, not with
// the advertised start cap. Headroom of 2× gives a little resilience
// against concurrent tabs without ballooning worst-case write cost.
const HEAL_CLAIM_ATTEMPT_CAP_FIRST_PAGE = HEAL_START_CAP_FIRST_PAGE * 2;
const HEAL_CLAIM_ATTEMPT_CAP_CURSORED = HEAL_START_CAP_CURSORED * 2;
const HEAL_CONCURRENCY = 2;
const HEAL_BUDGET_MS = 25_000;
const HEAL_LEASE_TTL_MS = 90_000;

type HealReason = 'missing' | 'parse-failed' | 'stale-rev' | 'bondless';

/** Single row nominated for lazy rebake. Priority orders the claim
 *  queue — lower numbers claim first so cold rows and malformed
 *  blobs drain before cosmetic stale-rev / bondless rebakes. */
interface HealCandidate {
  readonly id: number;
  readonly shareCode: string;
  readonly objectKey: string;
  readonly reason: HealReason;
  readonly priority: number;
}

interface CapsuleRow {
  id: number;
  share_code: string;
  created_at: string;
  size_bytes: number;
  frame_count: number;
  atom_count: number;
  title: string | null;
  kind: string;
  status: string;
  preview_status: string;
  preview_scene_v1: string | null;
  object_key: string | null;
  preview_rebake_claimed_at: number | null;
}

export interface AccountCapsuleSummary {
  shareCode: string;
  createdAt: string;
  sizeBytes: number;
  frameCount: number;
  atomCount: number;
  title: string | null;
  kind: string;
  status: string;
  previewStatus: string;
  /** Null when the scene column is absent, malformed, or carries zero atoms —
   *  the client renders a neutral placeholder thumb in that case. */
  previewThumb: PreviewThumbV1 | null;
}

/** Encode the keyset cursor. The alphabet is base64url so the value
 *  passes through query strings without escaping. */
function encodeCursor(createdAt: string, shareCode: string): string {
  return b64urlEncode(`${createdAt}|${shareCode}`);
}

function decodeCursor(token: string): { createdAt: string; shareCode: string } | null {
  try {
    const raw = b64urlDecode(token);
    const idx = raw.indexOf('|');
    if (idx < 0) return null;
    return { createdAt: raw.slice(0, idx), shareCode: raw.slice(idx + 1) };
  } catch (err) {
    // Decode failure is expected for malformed input (CDN rewrites,
    // truncated query strings, malicious inputs). Log so ops can spot
    // a real upstream regression — the user-visible 400 is the loud
    // signal at the request level.
    console.warn(`[account.capsules] cursor decode failed: ${errorMessage(err)}`);
    return null;
  }
}

/** Classify a row's rebake eligibility. Returns null when the row is
 *  fresh (no work to do), the row has no `object_key` (publish-time
 *  issue — can't rebake from R2), or the classifier itself threw on
 *  a malformed row. The try/catch is load-bearing for the endpoint's
 *  "lazy rebake must NEVER fail the account-list response" contract:
 *  a single poisoned row (e.g. a scene whose parse path throws) must
 *  NOT turn a `GET /api/account/capsules` into a 500. */
function classifyRow(row: CapsuleRow): HealCandidate | null {
  try {
    if (!row.object_key) return null;
    if (row.preview_scene_v1 == null) {
      return { id: row.id, shareCode: row.share_code, objectKey: row.object_key, reason: 'missing', priority: 1 };
    }
    const scene = parsePreviewSceneV1(row.preview_scene_v1);
    if (!scene) {
      return { id: row.id, shareCode: row.share_code, objectKey: row.object_key, reason: 'parse-failed', priority: 2 };
    }
    const storedRev = scene.thumb?.rev ?? 0;
    if (storedRev < CURRENT_THUMB_REV) {
      return { id: row.id, shareCode: row.share_code, objectKey: row.object_key, reason: 'stale-rev', priority: 3 };
    }
    if (sceneIsBondless(scene)) {
      return { id: row.id, shareCode: row.share_code, objectKey: row.object_key, reason: 'bondless', priority: 4 };
    }
    return null;
  } catch (err) {
    console.warn(`[account.capsules] classify-failed share=${row.share_code} error=${errorMessage(err)}`);
    return null;
  }
}

type ClaimOutcome = 'claimed' | 'held' | 'error';

/** Atomic claim: mark the row's lease as held if it is currently
 *  NULL or older than `HEAL_LEASE_TTL_MS`. Returns `'claimed'` only
 *  when the UPDATE resolved with exactly one changed row, `'held'`
 *  when a concurrent tab owns the lease, and `'error'` when the
 *  UPDATE itself threw. Callers must degrade gracefully on `'error'`
 *  — the lazy rebake is opportunistic and must NEVER fail the
 *  account-list response. */
async function tryClaimLease(
  env: Env,
  id: number,
  shareCode: string,
  nowMs: number,
): Promise<ClaimOutcome> {
  const expiredBefore = nowMs - HEAL_LEASE_TTL_MS;
  try {
    const result = await env.DB.prepare(
      `UPDATE capsule_share
          SET preview_rebake_claimed_at = ?
        WHERE id = ?
          AND (preview_rebake_claimed_at IS NULL OR preview_rebake_claimed_at < ?)`,
    )
      .bind(nowMs, id, expiredBefore)
      .run();
    const changes = (result as { meta?: { changes?: number } }).meta?.changes ?? 0;
    return changes === 1 ? 'claimed' : 'held';
  } catch (err) {
    console.warn(`[account.capsules] heal-claim-failed share=${shareCode} error=${errorMessage(err)}`);
    return 'error';
  }
}

interface BatchCounters {
  started: number;
  rebaked: number;
  persisted: number;
  failed: number;
}

/** Worker-pool rebake driver. Concurrency=HEAL_CONCURRENCY and a
 *  HEAL_BUDGET_MS wall-clock deadline bound the per-request work so a
 *  user with 80 stale rows doesn't turn a single page load into a
 *  30-second R2 storm. Unstarted rows at deadline become `deadlined`
 *  (computed once after the pool drains). */
async function runBoundedHealBatch(
  env: Env,
  candidates: readonly HealCandidate[],
  startedAt: number,
  userId: string,
): Promise<void> {
  const counters: BatchCounters = { started: 0, rebaked: 0, persisted: 0, failed: 0 };
  let cursor = 0;

  const worker = async (): Promise<void> => {
    while (cursor < candidates.length) {
      if (Date.now() - startedAt >= HEAL_BUDGET_MS) return;
      const idx = cursor++;
      const c = candidates[idx];
      counters.started++;
      // Outer try/catch is load-bearing: `rebakeSceneFromR2` is
      // contracted to return `{ok:false,reason}` on failure, but
      // a runtime throw (e.g., an R2 binding exception outside the
      // helper's internal catches) would otherwise propagate out of
      // the `while` loop, reject the enclosing `Promise.all(pool)`,
      // and skip the terminal `heal-batch-done` summary log. We
      // prefer logging the row-level failure and continuing.
      try {
        const result = await rebakeSceneFromR2(
          env,
          { id: c.id, object_key: c.objectKey },
          { overwrite: true },
        );
        if (result.ok === true) {
          counters.rebaked++;
          if (result.persisted) {
            counters.persisted++;
          } else {
            console.warn(`[account.capsules] heal-not-persisted share=${c.shareCode}`);
          }
        } else {
          const failed = result as { ok: false; reason: string };
          counters.failed++;
          console.warn(
            `[account.capsules] heal-failed: ${failed.reason} share=${c.shareCode}`,
          );
        }
      } catch (err) {
        counters.failed++;
        console.warn(
          `[account.capsules] heal-worker-exception share=${c.shareCode} error=${errorMessage(err)}`,
        );
      }
    }
  };

  const pool = Array.from(
    { length: Math.min(HEAL_CONCURRENCY, candidates.length) },
    () => worker(),
  );
  await Promise.all(pool);

  const deadlined = Math.max(0, candidates.length - counters.started);
  const elapsed = Date.now() - startedAt;
  console.log(
    `[account.capsules] heal-batch-done user=${userId} rebaked=${counters.rebaked}` +
      ` persisted=${counters.persisted} failed=${counters.failed}` +
      ` deadlined=${deadlined} elapsed=${elapsed}ms`,
  );
}

export const onRequestGet: PagesFunction<Env> = async (context) => {
  const userId = await authenticateRequest(context.request, context.env);
  if (!userId) {
    return new Response('Unauthorized', { status: 401, headers: noCacheHeaders() });
  }

  const url = new URL(context.request.url);
  const cursorParam = url.searchParams.get('cursor');
  const cursor = cursorParam ? decodeCursor(cursorParam) : null;
  if (cursorParam && !cursor) {
    return new Response('Invalid cursor', { status: 400, headers: noCacheHeaders() });
  }
  const isFirstPage = cursor === null;

  // Fetch PAGE_SIZE + 1 to detect "more available" without a separate count.
  // Keyset seek: `(created_at, share_code) < (?, ?)` for DESC ordering.
  const stmt = cursor
    ? context.env.DB.prepare(
        `SELECT id, share_code, created_at, size_bytes, frame_count,
                atom_count, title, kind, status, preview_status,
                preview_scene_v1, object_key, preview_rebake_claimed_at
           FROM capsule_share
          WHERE owner_user_id = ?
            AND status != 'deleted'
            AND (created_at < ? OR (created_at = ? AND share_code < ?))
          ORDER BY created_at DESC, share_code DESC
          LIMIT ?`,
      ).bind(userId, cursor.createdAt, cursor.createdAt, cursor.shareCode, PAGE_SIZE + 1)
    : context.env.DB.prepare(
        `SELECT id, share_code, created_at, size_bytes, frame_count,
                atom_count, title, kind, status, preview_status,
                preview_scene_v1, object_key, preview_rebake_claimed_at
           FROM capsule_share
          WHERE owner_user_id = ?
            AND status != 'deleted'
          ORDER BY created_at DESC, share_code DESC
          LIMIT ?`,
      ).bind(userId, PAGE_SIZE + 1);

  const rows = await stmt.all<CapsuleRow>();
  const hasMore = rows.results.length > PAGE_SIZE;
  const page = hasMore ? rows.results.slice(0, PAGE_SIZE) : rows.results;
  const last = page[page.length - 1];

  const capsules: AccountCapsuleSummary[] = page.map((r) => ({
    shareCode: r.share_code,
    createdAt: r.created_at,
    sizeBytes: r.size_bytes,
    frameCount: r.frame_count,
    atomCount: r.atom_count,
    title: r.title,
    kind: r.kind,
    status: r.status,
    previewStatus: r.preview_status,
    // Shared helper — see src/share/capsule-preview-account-derive.ts.
    // The same call powers the audit-page "ACCOUNT FALLBACK" panel so
    // audit and production cannot drift on the stale-row fallback path.
    previewThumb: deriveAccountThumb(r.preview_scene_v1),
  }));

  // Lazy-rebake nomination. Classify rows into priority buckets, sort,
  // then walk in priority order claiming leases atomically until the
  // start cap is hit. Only claimed rows are handed to the batch —
  // unclaimed rows are either fresh or held by a concurrent tab.
  const eligible: HealCandidate[] = [];
  const reasonCounts: Record<HealReason, number> = {
    missing: 0,
    'parse-failed': 0,
    'stale-rev': 0,
    bondless: 0,
  };
  for (const r of page) {
    const candidate = classifyRow(r);
    if (!candidate) continue;
    eligible.push(candidate);
    reasonCounts[candidate.reason]++;
  }
  eligible.sort((a, b) => a.priority - b.priority);

  const startCap = isFirstPage ? HEAL_START_CAP_FIRST_PAGE : HEAL_START_CAP_CURSORED;
  const claimAttemptCap = isFirstPage
    ? HEAL_CLAIM_ATTEMPT_CAP_FIRST_PAGE
    : HEAL_CLAIM_ATTEMPT_CAP_CURSORED;
  const nowMs = Date.now();
  const toStart: HealCandidate[] = [];
  let claimAttempts = 0;
  let claimErrors = 0;
  // Bound BOTH the successful-start count AND the claim-attempt count.
  // Without the second bound, a page full of already-held leases would
  // cause one D1 UPDATE per eligible row — breaking the "bounded hot
  // path" property the feature depends on.
  for (const c of eligible) {
    if (toStart.length >= startCap) break;
    if (claimAttempts >= claimAttemptCap) break;
    claimAttempts++;
    const outcome = await tryClaimLease(context.env, c.id, c.shareCode, nowMs);
    if (outcome === 'claimed') toStart.push(c);
    else if (outcome === 'error') claimErrors++;
    // On 'error' we continue with the next candidate — one row's
    // write-failure should not taint the rest of the nomination loop.
  }

  const previewPending = toStart.map((c) => c.shareCode);

  console.log(
    `[account.capsules] heal-scheduled user=${userId} started=${toStart.length}` +
      ` claim-attempts=${claimAttempts} claim-errors=${claimErrors}` +
      ` eligible=${eligible.length} first-page=${isFirstPage} cap=${startCap}` +
      ` attempt-cap=${claimAttemptCap}` +
      ` missing=${reasonCounts.missing} parse-failed=${reasonCounts['parse-failed']}` +
      ` stale-rev=${reasonCounts['stale-rev']} bondless=${reasonCounts.bondless}`,
  );

  if (toStart.length > 0) {
    scheduleBackground(
      context,
      runBoundedHealBatch(context.env, toStart, nowMs, userId),
      'account.capsules',
    );
  }

  return noCacheJson({
    capsules,
    pageSize: PAGE_SIZE,
    hasMore,
    nextCursor: hasMore && last ? encodeCursor(last.created_at, last.share_code) : null,
    previewPending,
  });
};
