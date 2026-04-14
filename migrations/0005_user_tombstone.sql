-- Migration 0005 — user tombstone.
--
-- Account deletion does not hard-delete the users row. Instead:
--   - display_name is NULLed
--   - deleted_at is stamped with the delete time
--   - oauth_accounts / sessions / quota_window rows are row-deleted
--   - capsule_share rows owned by the user are tombstoned (status=deleted)
--
-- This preserves referential meaning for audit rows (actor=user_id) and
-- for capsule_share.owner_user_id (no FK declared), while making the
-- user effectively absent to the auth middleware — a tombstoned user
-- row is treated like "user row missing" via the LEFT JOIN ON condition.
ALTER TABLE users ADD COLUMN deleted_at TEXT;
CREATE INDEX IF NOT EXISTS idx_users_deleted_at ON users(deleted_at);
