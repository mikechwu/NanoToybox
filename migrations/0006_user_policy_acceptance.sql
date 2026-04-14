-- Migration 0006 — user policy acceptance ledger.
--
-- Records each user's acknowledgment of a named policy. Currently the
-- only kind used in code is 'age_13_plus' (the 13+ self-certification
-- at sign-in), but the table is shaped to absorb future kinds
-- (acceptable-use, notification-consent, etc.) without a schema bump.
--
-- Composite PK (user_id, policy_kind) gives UPSERT semantics: a second
-- acceptance of the same policy kind updates policy_version /
-- accepted_at in place, so there is at most one row per (user, kind).
--
-- policy_version records the policy-text version at acceptance time so
-- historical consent can be verified against what the policy actually
-- said when the user clicked through.
CREATE TABLE IF NOT EXISTS user_policy_acceptance (
  user_id        TEXT NOT NULL,
  policy_kind    TEXT NOT NULL,   -- e.g. 'age_13_plus'
  policy_version TEXT NOT NULL,   -- from src/share/constants.ts POLICY_VERSION
  accepted_at    TEXT NOT NULL,   -- ISO-8601
  PRIMARY KEY (user_id, policy_kind)
);

CREATE INDEX IF NOT EXISTS idx_user_policy_acceptance_user
  ON user_policy_acceptance(user_id);
