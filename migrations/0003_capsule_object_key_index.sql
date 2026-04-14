-- Phase 5 operational follow-up.
--
-- Add an index on capsule_share.object_key to support the orphan sweeper.
-- Without this, the sweeper does a full table scan per R2 object key it
-- considers (up to 1000 per page). With the index the lookup becomes
-- O(log N) per key — negligible even on 10M+ rows.

CREATE INDEX idx_capsule_object_key ON capsule_share(object_key);
