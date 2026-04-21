-- 0010: Preview-scene rebake lease.
-- Unix-ms timestamp marking the most recent account-page lazy-heal
-- claim. Dedups work across concurrent tabs / rapid reloads.
-- NULL = unclaimed. TTL lives in application code (HEAL_LEASE_TTL_MS).
ALTER TABLE capsule_share ADD COLUMN preview_rebake_claimed_at INTEGER;
CREATE INDEX IF NOT EXISTS idx_capsule_share_rebake_claimed
  ON capsule_share(preview_rebake_claimed_at)
  WHERE preview_rebake_claimed_at IS NOT NULL;
