-- Migration 0009 — Add capsule_share.preview_scene_v1 TEXT NULLABLE.
--
-- V2 capsule preview (ADR D135): stores the publish-time-projected preview
-- scene (PreviewSceneV1 JSON) so the dynamic poster route and the account
-- list endpoint can serve a real-frame-derived preview without fetching the
-- capsule blob from R2 on every request. Additive and reversible: NULL for
-- pre-V2 rows; the poster route lazy-backfills on first miss, and the
-- account list endpoint renders a neutral placeholder when NULL.

ALTER TABLE capsule_share ADD COLUMN preview_scene_v1 TEXT;
