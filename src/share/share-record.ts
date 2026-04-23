/**
 * Share-record status types, preview status, and accessibility predicates.
 *
 * Single source of truth for the record lifecycle state machine.
 * Used by both backend (Pages Functions) and frontend (Watch remote-open).
 *
 * Owns:        status enums, accessibility predicates
 * Depends on:  nothing (pure types + functions)
 * Called by:    functions/api/capsules/* (status checks),
 *              watch/js/app/watch-controller.ts (error mapping)
 */

export type ShareRecordStatus =
  | 'pending_upload'
  | 'ready_pending_preview'
  | 'ready'
  | 'rejected'
  | 'deleted';

export type PreviewStatus = 'pending' | 'ready' | 'none';

/** Publish mode — 'account' = authenticated permanent share, 'guest' =
 *  anonymous Quick Share with a 72h TTL (§Guest Publish Row Semantics). */
export type ShareMode = 'account' | 'guest';

/**
 * Returns true if the record is publicly accessible — status is a live one
 * AND, for guest rows, the expiry window has not elapsed. `now` is an ISO
 * timestamp; lexical comparison is safe because every writer goes through
 * `new Date().toISOString()` (fixed-width `YYYY-MM-DDTHH:mm:ss.sssZ`, UTC).
 *
 * Replaces the pre-guest `isAccessibleStatus(status)` predicate. Callers
 * must widen their SELECT to include `expires_at` before calling.
 */
export function isAccessibleShare(
  row: Pick<CapsuleShareRow, 'status' | 'expires_at'>,
  now: string,
): boolean {
  return (row.status === 'ready' || row.status === 'ready_pending_preview')
    && (row.expires_at === null || row.expires_at > now);
}

/** SQL predicate matching {@link isAccessibleShare}. Bind one ISO-timestamp
 *  parameter (the current time) at the `?` placeholder. Exported so
 *  account-list/public-read queries cannot drift from the TS predicate. */
export const accessibleShareSqlFragment =
  "status IN ('ready','ready_pending_preview') AND (expires_at IS NULL OR expires_at > ?)";

/**
 * D1 row shape for capsule_share table.
 * Used by publish-core.ts and read endpoints.
 */
export interface CapsuleShareRow {
  id: string;
  share_code: string;
  status: ShareRecordStatus;
  /** NULL for guest rows (share_mode='guest'). CHECK constraint enforces
   *  the invariant: account ⇒ owner id present; guest ⇒ owner id null. */
  owner_user_id: string | null;
  object_key: string;
  format: string;
  version: number;
  kind: string;
  app_version: string;
  sha256: string;
  size_bytes: number;
  frame_count: number;
  atom_count: number;
  max_atom_count: number;
  duration_ps: number;
  has_appearance: number;
  has_interaction: number;
  title: string | null;
  preview_status: PreviewStatus;
  preview_poster_key: string | null;
  preview_motion_key: string | null;
  created_at: string;
  uploaded_at: string | null;
  published_at: string | null;
  last_accessed_at: string | null;
  rejection_reason: string | null;
  /** V2 capsule preview — compact JSON of the publish-time-projected scene
   *  (PreviewSceneV1). Populated by preparePublishRecord; lazy-backfilled by
   *  the poster route on pre-V2 rows. NULL on rows that have not been
   *  rendered under V2 yet (account list endpoint emits previewThumb: null
   *  for those rows, driving the placeholder thumbnail). */
  preview_scene_v1: string | null;
  /** 'account' for the existing authenticated publish path, 'guest' for
   *  the Quick Share path. Default 'account' at migration time for
   *  backfilled rows. */
  share_mode: ShareMode;
  /** ISO timestamp (UTC) after which a guest row is no longer accessible.
   *  NULL for account rows (permanent). */
  expires_at: string | null;
}

import { TEMPLATE_VERSION, fnv1a32Hex } from './capsule-preview';

/**
 * Public metadata returned by GET /api/capsules/:code.
 *
 * **Semantics note (April 2026 — capsule-preview V1):** `preview.posterUrl`
 * being present means a poster **endpoint** is available for this capsule
 * (either a stored R2 asset or the dynamically-generated V1 fallback). For
 * "stored rich asset exists," consumers should branch on
 * `previewStatus === 'ready'`. Pre-V1, the field was present only when a
 * stored asset existed; this flipped with the V1 release. See spec §8.
 */
export interface ShareMetadataResponse {
  shareCode: string;
  kind: string;
  version: number;
  sizeBytes: number;
  frameCount: number;
  atomCount: number;
  maxAtomCount: number;
  durationPs: number;
  hasAppearance: boolean;
  hasInteraction: boolean;
  previewStatus: PreviewStatus;
  preview?: {
    /** Poster endpoint URL — stored or dynamically generated. */
    posterUrl: string;
    /** Literal — matches the PNG the route produces. */
    width: 1200;
    /** Literal — matches the PNG the route produces. */
    height: 630;
  };
}

export interface ToMetadataOptions {
  /**
   * Mirrors the `CAPSULE_PREVIEW_DYNAMIC_FALLBACK` env flag (spec §7).
   * When true, every accessible row gets `preview.posterUrl` (stored or
   * dynamic). When false (or omitted), behavior matches pre-V1 (stored-only).
   */
  dynamicFallbackEnabled?: boolean;
}

function posterUrlFor(shareCode: string, isStored: boolean, storedKey: string | null): string {
  // Cache-key versioning (spec §12): two independent axes.
  // - dynamic posters bust on TEMPLATE_VERSION bump
  // - stored posters bust on first-8-hex of preview_poster_key
  // Spec §12: per-stored-asset version is the first 8 hex of the poster key.
  // Stored keys today take the form `capsules/<id>/preview-poster.png`, where
  // the leading path segments are not guaranteed hex. Deriving the cache key
  // from a deterministic 8-hex hash of the FULL storedKey gives the same
  // bust-on-content-change semantics with full key entropy and no parsing
  // assumption about future storage layouts.
  const v = isStored && storedKey
    ? `p${fnv1a32Hex(storedKey)}`
    : `t${TEMPLATE_VERSION}`;
  return `/api/capsules/${shareCode}/preview/poster?v=${v}`;
}

/** Map a D1 row to the public metadata response. */
export function toMetadataResponse(
  row: CapsuleShareRow,
  options: ToMetadataOptions = {},
): ShareMetadataResponse {
  const response: ShareMetadataResponse = {
    shareCode: row.share_code,
    kind: row.kind,
    version: row.version,
    sizeBytes: row.size_bytes,
    frameCount: row.frame_count,
    atomCount: row.atom_count,
    maxAtomCount: row.max_atom_count,
    durationPs: row.duration_ps,
    hasAppearance: row.has_appearance === 1,
    hasInteraction: row.has_interaction === 1,
    previewStatus: row.preview_status,
  };

  const hasStored = row.preview_status === 'ready' && !!row.preview_poster_key;
  const accessible = isAccessibleShare(row, new Date().toISOString());

  if (hasStored) {
    response.preview = {
      posterUrl: posterUrlFor(row.share_code, true, row.preview_poster_key),
      width: 1200,
      height: 630,
    };
  } else if (accessible && options.dynamicFallbackEnabled) {
    response.preview = {
      posterUrl: posterUrlFor(row.share_code, false, null),
      width: 1200,
      height: 630,
    };
  }

  return response;
}

/**
 * Read the V1 dynamic-fallback flag from env (default: on). Spec §7.
 *
 * Allowlist semantics: only the explicit truthy strings `"on"`, `"true"`, `"1"`
 * enable the flag. Anything else (`"off"`, `"disabled"`, `"no"`, typos, the
 * empty string, etc.) disables it. This avoids the prior denylist footgun
 * where `CAPSULE_PREVIEW_DYNAMIC_FALLBACK=disabled` silently kept the flag on.
 * Unset is treated as `"on"` to preserve the V1 default behavior.
 */
export function isDynamicPreviewFallbackEnabled(env: {
  CAPSULE_PREVIEW_DYNAMIC_FALLBACK?: string;
}): boolean {
  const raw = env.CAPSULE_PREVIEW_DYNAMIC_FALLBACK;
  if (raw == null) return true;
  const v = raw.trim().toLowerCase();
  return v === 'on' || v === 'true' || v === '1';
}
