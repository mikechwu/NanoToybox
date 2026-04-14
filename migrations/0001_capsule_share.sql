-- Capsule share: metadata store for published capsules
-- Used by: functions/api/capsules/* (read/write), src/share/publish-core.ts (insert)

CREATE TABLE capsule_share (
  id TEXT PRIMARY KEY,
  share_code TEXT NOT NULL,
  status TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  object_key TEXT NOT NULL,
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

CREATE UNIQUE INDEX idx_share_code ON capsule_share(share_code);
CREATE INDEX idx_status ON capsule_share(status);
CREATE INDEX idx_owner ON capsule_share(owner_user_id);
CREATE INDEX idx_created ON capsule_share(created_at);

-- Auth tables (Phase 0): users, OAuth accounts, sessions

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  display_name TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE oauth_accounts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  provider TEXT NOT NULL,
  provider_account_id TEXT NOT NULL,
  email TEXT,
  email_verified INTEGER NOT NULL DEFAULT 0,
  UNIQUE(provider, provider_account_id)
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);

CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE INDEX idx_sessions_expires ON sessions(expires_at);
