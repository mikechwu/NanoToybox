/**
 * Share-record status types, preview status, and accessibility predicates.
 *
 * Single source of truth for the record lifecycle state machine.
 * Used by both backend (Pages Functions) and frontend (Watch remote-open).
 *
 * Owns:        status enums, accessibility predicates
 * Depends on:  nothing (pure types + functions)
 * Called by:    functions/api/capsules/* (status checks),
 *              watch/js/watch-controller.ts (error mapping)
 */

export type ShareRecordStatus =
  | 'pending_upload'
  | 'ready_pending_preview'
  | 'ready'
  | 'rejected'
  | 'deleted';

export type PreviewStatus = 'pending' | 'ready' | 'none';

/** Returns true if the record is publicly accessible (metadata + blob endpoints return 200). */
export function isAccessibleStatus(status: ShareRecordStatus): boolean {
  return status === 'ready' || status === 'ready_pending_preview';
}

/**
 * D1 row shape for capsule_share table.
 * Used by publish-core.ts and read endpoints.
 */
export interface CapsuleShareRow {
  id: string;
  share_code: string;
  status: ShareRecordStatus;
  owner_user_id: string;
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
}

/** Public metadata returned by GET /api/capsules/:code */
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
    posterUrl: string;
  };
}

/** Map a D1 row to the public metadata response. */
export function toMetadataResponse(row: CapsuleShareRow): ShareMetadataResponse {
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

  // Only include preview.posterUrl when the poster is actually ready
  if (row.preview_status === 'ready' && row.preview_poster_key) {
    response.preview = {
      posterUrl: `/api/capsules/${row.share_code}/preview/poster`,
    };
  }

  return response;
}
