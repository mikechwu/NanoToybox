-- Migration 0011 — Guest Quick Share columns on capsule_share.
--
-- Adds:
--   - owner_user_id becomes NULLABLE (guest rows have no account)
--   - share_mode ('account' | 'guest') with default 'account' for the backfill
--   - expires_at (ISO timestamp) — non-null only for guest rows
--   - CHECK constraint binding share_mode ↔ owner_user_id nullability
--   - partial index on expires_at for the guest-expiry sweep
--
-- SQLite has no ALTER COLUMN / ADD CHECK, so a full table rebuild is
-- required. Template mirrors migration 0008.

PRAGMA foreign_keys = OFF;

CREATE TABLE capsule_share_new (
  id TEXT PRIMARY KEY,
  share_code TEXT NOT NULL,
  status TEXT NOT NULL,
  owner_user_id TEXT,              -- nullable for guest rows
  object_key TEXT,
  format TEXT NOT NULL,
  version INTEGER NOT NULL,
  kind TEXT NOT NULL,
  app_version TEXT NOT NULL,
  sha256 TEXT,
  size_bytes INTEGER,
  frame_count INTEGER,
  atom_count INTEGER,
  max_atom_count INTEGER,
  duration_ps REAL,
  has_appearance INTEGER NOT NULL DEFAULT 0,
  has_interaction INTEGER NOT NULL DEFAULT 0,
  title TEXT,
  preview_status TEXT NOT NULL DEFAULT 'none',
  preview_poster_key TEXT,
  preview_motion_key TEXT,
  created_at TEXT NOT NULL,
  uploaded_at TEXT,
  published_at TEXT,
  last_accessed_at TEXT,
  rejection_reason TEXT,
  preview_scene_v1 TEXT,
  preview_rebake_claimed_at INTEGER,
  share_mode TEXT NOT NULL DEFAULT 'account',
  expires_at TEXT,
  CHECK (
    (share_mode = 'guest'   AND owner_user_id IS NULL)
    OR
    (share_mode = 'account' AND owner_user_id IS NOT NULL)
  )
);

INSERT INTO capsule_share_new (
  id, share_code, status, owner_user_id, object_key,
  format, version, kind, app_version, sha256,
  size_bytes, frame_count, atom_count, max_atom_count, duration_ps,
  has_appearance, has_interaction, title,
  preview_status, preview_poster_key, preview_motion_key,
  created_at, uploaded_at, published_at, last_accessed_at, rejection_reason,
  preview_scene_v1, preview_rebake_claimed_at,
  share_mode, expires_at
)
SELECT
  id, share_code, status, owner_user_id, object_key,
  format, version, kind, app_version, sha256,
  size_bytes, frame_count, atom_count, max_atom_count, duration_ps,
  has_appearance, has_interaction, title,
  preview_status, preview_poster_key, preview_motion_key,
  created_at, uploaded_at, published_at, last_accessed_at, rejection_reason,
  preview_scene_v1, preview_rebake_claimed_at,
  'account', NULL
FROM capsule_share;

DROP TABLE capsule_share;

ALTER TABLE capsule_share_new RENAME TO capsule_share;

CREATE UNIQUE INDEX idx_share_code ON capsule_share(share_code);
CREATE INDEX idx_status ON capsule_share(status);
CREATE INDEX idx_owner ON capsule_share(owner_user_id);
CREATE INDEX idx_created ON capsule_share(created_at);
CREATE INDEX idx_capsule_object_key ON capsule_share(object_key);
CREATE INDEX IF NOT EXISTS idx_capsule_share_rebake_claimed
  ON capsule_share(preview_rebake_claimed_at)
  WHERE preview_rebake_claimed_at IS NOT NULL;
CREATE INDEX idx_capsule_guest_expires
  ON capsule_share(expires_at)
  WHERE share_mode = 'guest' AND status != 'deleted';

PRAGMA foreign_keys = ON;
