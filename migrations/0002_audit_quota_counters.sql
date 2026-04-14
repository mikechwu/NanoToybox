-- Phase 5 — Abuse controls and operations.
--
-- Adds three tables:
--   capsule_share_audit    — audit trail of abuse reports, moderation, and
--                            publish-related events (failures, quotas hit).
--   publish_quota_window   — per-user sliding-window counter state for the
--                            publish rate limit.
--   usage_counter          — day-bucketed event counts (publishes, resolves)
--                            for basic usage metrics without PII.

-- Audit trail for moderation + abuse reports + security events.
-- rows are append-only from a product perspective; pruning is operational.
CREATE TABLE capsule_share_audit (
  id TEXT PRIMARY KEY,
  share_id TEXT,                    -- nullable: pre-insert validation rejects have no share yet
  share_code TEXT,                  -- denormalized for fast code-based lookup
  event_type TEXT NOT NULL,         -- 'abuse_report' | 'moderation_delete' | 'publish_rejected_quota' | ...
  actor TEXT,                       -- user_id for authenticated actions, 'anonymous' for public reports
  severity TEXT NOT NULL DEFAULT 'info',   -- 'info' | 'warning' | 'critical'
  reason TEXT,                      -- free-form human explanation (abuse reason, rejection detail)
  ip_hash TEXT,                     -- SHA-256 of reporter IP (de-dup key; never the raw IP)
  user_agent TEXT,                  -- optional UA string (truncated)
  created_at TEXT NOT NULL,
  details_json TEXT                 -- optional structured payload (stringified JSON)
);

CREATE INDEX idx_audit_share ON capsule_share_audit(share_id);
CREATE INDEX idx_audit_share_code ON capsule_share_audit(share_code);
CREATE INDEX idx_audit_event_type ON capsule_share_audit(event_type);
CREATE INDEX idx_audit_created ON capsule_share_audit(created_at);

-- Per-user sliding-window counter for the publish quota.
-- One row per (user, window_key) where window_key is a coarse bucket
-- (e.g., floor(unix_ts / WINDOW_SECONDS)). Older rows are pruned by the
-- quota helper as it inserts. Keeps the window cost O(active_buckets).
CREATE TABLE publish_quota_window (
  user_id TEXT NOT NULL,
  window_key INTEGER NOT NULL,      -- integer bucket (unix_seconds / WINDOW_SECONDS)
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, window_key)
);

CREATE INDEX idx_quota_window ON publish_quota_window(window_key);

-- Day-bucketed counters for basic usage metrics (no PII).
-- Rows are keyed by (metric, day) where day is YYYY-MM-DD UTC.
-- Used for "publishes/day", "resolves/day", etc. Kept lean — no per-user
-- or per-IP dimensions here; PII-adjacent breakdowns live in the audit
-- table when they exist at all.
CREATE TABLE usage_counter (
  metric TEXT NOT NULL,
  day TEXT NOT NULL,                -- 'YYYY-MM-DD' UTC
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (metric, day)
);

CREATE INDEX idx_usage_day ON usage_counter(day);
