-- Migration 0008 — Make capsule_share.object_key nullable.
--
-- Fixes the production DELETE /api/account/capsules/:code 500 caused by
-- the delete core's tombstone step (SET object_key = NULL) hitting a
-- NOT NULL constraint that 0004's comment falsely claimed was already
-- relaxed. SQLite has no ALTER COLUMN — full table rebuild required.

PRAGMA foreign_keys = OFF;

CREATE TABLE capsule_share_new (
  id TEXT PRIMARY KEY,
  share_code TEXT NOT NULL,
  status TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  object_key TEXT,                -- was TEXT NOT NULL; now nullable for tombstone
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
  rejection_reason TEXT
);

INSERT INTO capsule_share_new
  SELECT id, share_code, status, owner_user_id, object_key,
         format, version, kind, app_version, sha256,
         size_bytes, frame_count, atom_count, max_atom_count,
         duration_ps, has_appearance, has_interaction, title,
         preview_status, preview_poster_key, preview_motion_key,
         created_at, uploaded_at, published_at, last_accessed_at,
         rejection_reason
  FROM capsule_share;

DROP TABLE capsule_share;

ALTER TABLE capsule_share_new RENAME TO capsule_share;

-- Recreate all indexes (dropped with the original table).
CREATE UNIQUE INDEX idx_share_code ON capsule_share(share_code);
CREATE INDEX idx_status ON capsule_share(status);
CREATE INDEX idx_owner ON capsule_share(owner_user_id);
CREATE INDEX idx_created ON capsule_share(created_at);
CREATE INDEX idx_capsule_object_key ON capsule_share(object_key);

PRAGMA foreign_keys = ON;
