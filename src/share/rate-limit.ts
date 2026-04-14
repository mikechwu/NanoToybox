/**
 * Publish quota — per-user sliding-window rate limit backed by D1.
 *
 * Model: divide time into coarse fixed-size buckets (WINDOW_BUCKET_SECONDS).
 * For a sliding window of WINDOW_SECONDS, sum counts across the most recent
 * ceil(WINDOW_SECONDS / WINDOW_BUCKET_SECONDS) buckets. This approximates a
 * true sliding window with O(buckets) reads per check — cheap enough for
 * D1 on the publish hot path.
 *
 * Defaults match the plan's "max 10 publishes per day per owner_user_id"
 * guidance. Callers may tune via PublishQuotaConfig.
 *
 * Owns:        window-bucket math, quota check/increment, cleanup
 * Depends on:  src/share/d1-types.ts
 * Called by:   functions/api/capsules/publish.ts (hot path),
 *              functions/api/admin/sweep/* (periodic cleanup)
 */

import type { D1Database } from './d1-types';

export interface PublishQuotaConfig {
  /** Max publishes per user within the sliding window. */
  maxPerWindow: number;
  /** Window length in seconds. */
  windowSeconds: number;
  /** Bucket size in seconds (window is composed of N of these). */
  bucketSeconds: number;
}

export const DEFAULT_PUBLISH_QUOTA: PublishQuotaConfig = {
  maxPerWindow: 10,
  windowSeconds: 24 * 60 * 60, // 24 hours
  bucketSeconds: 60 * 60, // 1 hour buckets → 24 active buckets max
};

export interface QuotaCheckResult {
  allowed: boolean;
  /** Total count across the active window at the time of the check. */
  currentCount: number;
  /** Limit for convenience so callers can surface it in error responses. */
  limit: number;
  /** When the oldest bucket in the active window will expire (unix seconds).
   *  Clients can use this as a Retry-After hint. */
  retryAtSeconds: number;
}

/** Compute the bucket key for a given timestamp + config. */
export function bucketKey(nowSeconds: number, config: PublishQuotaConfig): number {
  return Math.floor(nowSeconds / config.bucketSeconds);
}

/** Compute the list of bucket keys that make up the active sliding window. */
export function activeBuckets(
  nowSeconds: number,
  config: PublishQuotaConfig,
): number[] {
  const current = bucketKey(nowSeconds, config);
  const span = Math.ceil(config.windowSeconds / config.bucketSeconds);
  const keys: number[] = [];
  for (let i = 0; i < span; i++) keys.push(current - i);
  return keys;
}

/**
 * Quota is enforced as a two-phase flow to match the product's "max N
 * SUCCESSFUL publishes per window" policy:
 *
 *   1. `checkPublishQuota()` — read-only. Call BEFORE doing any work.
 *      If `allowed === false`, reject with 429 before reading the body.
 *
 *   2. `consumePublishQuota()` — increments the current bucket. Call
 *      ONLY after the publish has actually succeeded (D1 row persisted).
 *
 * Failed attempts (oversized payload, invalid schema, R2/D1 errors) do
 * NOT call consume, so a user's quota is never spent on a rejection
 * they did not cause.
 *
 * **Concurrency semantics (read this before trusting the limit)**
 *
 * Neither the check nor the commit phase is transactional. The ceiling
 * can be exceeded by two independent failure axes:
 *
 * 1. Concurrent bursts from the same user: several requests each see
 *    `total < maxPerWindow` at check time and each go on to consume.
 *    Overshoot is bounded by in-flight concurrency at the race window
 *    — realistically 2-5 extra publishes under a scripted burst.
 *
 * 2. Consume-write failures (the `publish_quota_accounting_failed`
 *    audit event): when `consumePublishQuota` throws after a successful
 *    persist, the endpoint returns 201 with a warning but the counter
 *    is NOT incremented. Under a persistent D1 outage this overshoot is
 *    UNBOUNDED — the user can keep publishing as long as D1 writes keep
 *    failing. An un-acked `publish_quota_accounting_failed` within the
 *    window means the quota is no longer enforceable for that user.
 *
 * Combined effective ceiling is approximately:
 *
 *     effectiveCeiling ≈ maxPerWindow + concurrency + accountingFailures
 *
 * **Ops action required**: `publish_quota_accounting_failed` events
 * (severity=critical) MUST trigger an alert. A sustained stream is not
 * a "one free publish" — it's an open abuse-control bypass. Until
 * reconciliation is automated, operators must either backfill the
 * counter or temporarily harden the gate (e.g. flip the user's account
 * to require re-auth or admin approval).
 *
 * This is a conscious trade-off for Phase 5. A Durable-Object-backed
 * counter would close the race completely but is out of scope. If the
 * limit is ever treated as a true hard ceiling (billing, legal), the
 * pattern must be upgraded — do not rely on this commentary.
 */
export async function checkPublishQuota(
  db: D1Database,
  userId: string,
  config: PublishQuotaConfig = DEFAULT_PUBLISH_QUOTA,
  now: Date = new Date(),
): Promise<QuotaCheckResult> {
  const nowSeconds = Math.floor(now.getTime() / 1000);
  const keys = activeBuckets(nowSeconds, config);
  const oldestBucket = keys[keys.length - 1];

  // Sum counts across active buckets in one round-trip.
  const placeholders = keys.map(() => '?').join(',');
  const row = await db
    .prepare(
      `SELECT COALESCE(SUM(count), 0) AS total
         FROM publish_quota_window
        WHERE user_id = ? AND window_key IN (${placeholders})`,
    )
    .bind(userId, ...keys)
    .first<{ total: number }>();

  const currentCount = row?.total ?? 0;
  const retryAtSeconds = oldestBucket * config.bucketSeconds + config.windowSeconds;

  return {
    allowed: currentCount < config.maxPerWindow,
    currentCount,
    limit: config.maxPerWindow,
    retryAtSeconds,
  };
}

/**
 * Increment the quota counter for `userId` in the current bucket.
 * Call ONLY after a publish has succeeded (D1 row persisted). Never
 * called from a rejection path — see the split-quota rationale on
 * `checkPublishQuota`.
 *
 * This function has no "allowed" return — it unconditionally consumes.
 * The caller must have already gated on `checkPublishQuota` (and the
 * intervening work must have succeeded) before calling this.
 */
export async function consumePublishQuota(
  db: D1Database,
  userId: string,
  config: PublishQuotaConfig = DEFAULT_PUBLISH_QUOTA,
  now: Date = new Date(),
): Promise<void> {
  const nowSeconds = Math.floor(now.getTime() / 1000);
  const currentBucket = bucketKey(nowSeconds, config);
  await db
    .prepare(
      `INSERT INTO publish_quota_window (user_id, window_key, count)
       VALUES (?, ?, 1)
       ON CONFLICT(user_id, window_key) DO UPDATE SET count = count + 1`,
    )
    .bind(userId, currentBucket)
    .run();
}

/**
 * Drop quota bucket rows older than the active window. Safe to call from
 * the publish hot path (cheap O(log N) with the window_key index) but
 * better run periodically via the sweeper endpoint.
 */
export async function pruneExpiredQuotaBuckets(
  db: D1Database,
  config: PublishQuotaConfig = DEFAULT_PUBLISH_QUOTA,
  now: Date = new Date(),
): Promise<void> {
  const nowSeconds = Math.floor(now.getTime() / 1000);
  const oldest = bucketKey(nowSeconds, config) - Math.ceil(config.windowSeconds / config.bucketSeconds);
  await db
    .prepare('DELETE FROM publish_quota_window WHERE window_key < ?')
    .bind(oldest)
    .run();
}
