-- Migration 0007 — privacy contact channel: requests + per-IP rate limit.
--
-- Backs the `/privacy-request` route (Phase 7 Option B). The form is
-- public so a user who has been locked out or never signed in can
-- still file a request; signed-in submissions also record the
-- session's `user_id` for operator context.
--
-- privacy_requests
--   id              UUID, primary key
--   created_at      unix seconds
--   user_id         FK users.id when signed in, NULL otherwise
--   contact_value   email/handle the requester wants us to reply to
--   request_type    enum: 'access' | 'deletion' | 'correction'
--                       | 'under_13_remediation' | 'other'
--   message         free text, length-capped server-side
--   client_ip_hash  HMAC(SESSION_SECRET, CF-Connecting-IP); raw IP
--                   is never stored
--   status          'pending' | 'in_progress' | 'resolved' | 'rejected'
--   resolved_at     unix seconds; NULL until resolved/rejected
--   resolver_note   operator-visible; never shown to requester
--
-- privacy_request_quota_window
--   Per-IP sliding window for layer-2 (D1) rate limiting. Mirrors the
--   shape of publish_quota_window so the bucket-math helpers are
--   reusable, but keyed on ip_hash instead of user_id (anonymous form
--   submissions have no user_id).
CREATE TABLE IF NOT EXISTS privacy_requests (
  id              TEXT PRIMARY KEY,
  created_at      INTEGER NOT NULL,
  user_id         TEXT,
  contact_value   TEXT NOT NULL,
  request_type    TEXT NOT NULL,
  message         TEXT NOT NULL,
  client_ip_hash  TEXT,
  status          TEXT NOT NULL DEFAULT 'pending',
  resolved_at     INTEGER,
  resolver_note   TEXT
);

CREATE INDEX IF NOT EXISTS idx_privacy_requests_status_created
  ON privacy_requests(status, created_at);
CREATE INDEX IF NOT EXISTS idx_privacy_requests_user
  ON privacy_requests(user_id) WHERE user_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS privacy_request_quota_window (
  ip_hash       TEXT NOT NULL,
  bucket_start  INTEGER NOT NULL,
  count         INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (ip_hash, bucket_start)
);
CREATE INDEX IF NOT EXISTS idx_privacy_request_quota_bucket
  ON privacy_request_quota_window(bucket_start);
