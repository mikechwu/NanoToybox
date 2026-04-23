-- Migration 0012 — Per-IP guest publish quota window.
--
-- Backs the guest Quick Share publish path (anonymous, no user_id).
-- Kept in a dedicated table (not merged into privacy_request_quota_window
-- or publish_quota_window) so the three flows' very different abuse
-- profiles cannot collide in operator debug queries.
--
-- Bucket math is identical to privacy_request_quota_window; consumed by
-- the helpers in src/share/rate-limit.ts.

CREATE TABLE IF NOT EXISTS guest_publish_quota_window (
  ip_hash       TEXT NOT NULL,
  bucket_start  INTEGER NOT NULL,
  count         INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (ip_hash, bucket_start)
);

CREATE INDEX IF NOT EXISTS idx_guest_publish_quota_bucket
  ON guest_publish_quota_window(bucket_start);
