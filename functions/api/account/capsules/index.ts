/**
 * GET /api/account/capsules — list the signed-in user's capsules.
 *
 * Filters to `owner_user_id = ? AND status != 'deleted'`. Tombstoned
 * rows are retained in D1 for audit integrity but should not surface
 * in the Uploads list.
 *
 * Cursor pagination
 * -----------------
 * Each response carries a `nextCursor` string when more rows exist.
 * The cursor encodes the last row's `(created_at, share_code)` pair
 * (joined with `|`, base64url-encoded) so the next page resumes at the
 * correct point even when many capsules share a created_at second.
 *
 * The composite sort `ORDER BY created_at DESC, share_code DESC` is the
 * stable key that makes the cursor work — both the seek-comparison and
 * the ORDER BY use the same pair, so a row is never visited twice and
 * never skipped.
 *
 * Page size is fixed at PAGE_SIZE per call. The previous implementation
 * silently capped at 500 with no cursor, so power users had invisible
 * uploads — see also `delete-all` which loops on `moreAvailable`.
 *
 * V2 capsule preview (spec §Account Integration, post-launch follow-up):
 * each row carries a `previewThumb` field of type
 * {@link PreviewThumbV1 | null}, derived server-side from the
 * `preview_scene_v1` D1 column. **No R2 access on the hot path.**
 *
 * Downsampling is silhouette-preserving (extrema + farthest-point; see
 * `src/share/capsule-preview-sampling.ts:sampleForSilhouette`), applied
 * here to produce either:
 *   - an atoms-only thumb at `ROW_ATOM_CAP_ATOMS_ONLY` (18) atoms for
 *     scenes with fewer than `BONDS_AWARE_SOURCE_THRESHOLD` (14) source
 *     atoms or no storage bonds, OR
 *   - a bonds-aware thumb at `ROW_ATOM_CAP_WITH_BONDS` (12) atoms plus
 *     up to `ROW_BOND_CAP` (6) coverage-selected `<line>` bonds for
 *     dense scenes whose storage carries connectivity data.
 *
 * This is the single point of downsampling on the read path (spec AC #26);
 * the account client renders `previewThumb` verbatim.
 */

import type { Env } from '../../../env';
import { authenticateRequest } from '../../../auth-middleware';
import { noCacheHeaders, noCacheJson } from '../../../http-cache';
import { b64urlEncode, b64urlDecode } from '../../../../src/share/b64url';
import { errorMessage } from '../../../../src/share/error-message';
import {
  parsePreviewSceneV1,
  type PreviewThumbV1,
} from '../../../../src/share/capsule-preview-scene-store';
import { deriveAccountThumb } from '../../../../src/share/capsule-preview-account-derive';
import {
  healBondlessRow,
  sceneIsBondless,
} from '../../../../src/share/capsule-preview-heal';
import { scheduleBackground } from '../../../_lib/wait-until';

const PAGE_SIZE = 50;

interface CapsuleRow {
  id: number;
  share_code: string;
  created_at: string;
  size_bytes: number;
  frame_count: number;
  atom_count: number;
  title: string | null;
  kind: string;
  status: string;
  preview_status: string;
  preview_scene_v1: string | null;
  object_key: string | null;
}

export interface AccountCapsuleSummary {
  shareCode: string;
  createdAt: string;
  sizeBytes: number;
  frameCount: number;
  atomCount: number;
  title: string | null;
  kind: string;
  status: string;
  previewStatus: string;
  /** Null when the scene column is absent, malformed, or carries zero atoms —
   *  the client renders a neutral placeholder thumb in that case. */
  previewThumb: PreviewThumbV1 | null;
}

/** Encode the keyset cursor. The alphabet is base64url so the value
 *  passes through query strings without escaping. */
function encodeCursor(createdAt: string, shareCode: string): string {
  return b64urlEncode(`${createdAt}|${shareCode}`);
}

function decodeCursor(token: string): { createdAt: string; shareCode: string } | null {
  try {
    const raw = b64urlDecode(token);
    const idx = raw.indexOf('|');
    if (idx < 0) return null;
    return { createdAt: raw.slice(0, idx), shareCode: raw.slice(idx + 1) };
  } catch (err) {
    // Decode failure is expected for malformed input (CDN rewrites,
    // truncated query strings, malicious inputs). Log so ops can spot
    // a real upstream regression — the user-visible 400 is the loud
    // signal at the request level.
    console.warn(`[account.capsules] cursor decode failed: ${errorMessage(err)}`);
    return null;
  }
}

export const onRequestGet: PagesFunction<Env> = async (context) => {
  const userId = await authenticateRequest(context.request, context.env);
  if (!userId) {
    return new Response('Unauthorized', { status: 401, headers: noCacheHeaders() });
  }

  const url = new URL(context.request.url);
  const cursorParam = url.searchParams.get('cursor');
  const cursor = cursorParam ? decodeCursor(cursorParam) : null;
  if (cursorParam && !cursor) {
    return new Response('Invalid cursor', { status: 400, headers: noCacheHeaders() });
  }

  // Fetch PAGE_SIZE + 1 to detect "more available" without a separate count.
  // Keyset seek: `(created_at, share_code) < (?, ?)` for DESC ordering.
  const stmt = cursor
    ? context.env.DB.prepare(
        `SELECT id, share_code, created_at, size_bytes, frame_count,
                atom_count, title, kind, status, preview_status,
                preview_scene_v1, object_key
           FROM capsule_share
          WHERE owner_user_id = ?
            AND status != 'deleted'
            AND (created_at < ? OR (created_at = ? AND share_code < ?))
          ORDER BY created_at DESC, share_code DESC
          LIMIT ?`,
      ).bind(userId, cursor.createdAt, cursor.createdAt, cursor.shareCode, PAGE_SIZE + 1)
    : context.env.DB.prepare(
        `SELECT id, share_code, created_at, size_bytes, frame_count,
                atom_count, title, kind, status, preview_status,
                preview_scene_v1, object_key
           FROM capsule_share
          WHERE owner_user_id = ?
            AND status != 'deleted'
          ORDER BY created_at DESC, share_code DESC
          LIMIT ?`,
      ).bind(userId, PAGE_SIZE + 1);

  const rows = await stmt.all<CapsuleRow>();
  const hasMore = rows.results.length > PAGE_SIZE;
  const page = hasMore ? rows.results.slice(0, PAGE_SIZE) : rows.results;
  const last = page[page.length - 1];

  const capsules: AccountCapsuleSummary[] = page.map((r) => ({
    shareCode: r.share_code,
    createdAt: r.created_at,
    sizeBytes: r.size_bytes,
    frameCount: r.frame_count,
    atomCount: r.atom_count,
    title: r.title,
    kind: r.kind,
    status: r.status,
    previewStatus: r.preview_status,
    // Shared helper — see src/share/capsule-preview-account-derive.ts.
    // The same call powers the audit-page "ACCOUNT FALLBACK" panel so
    // audit and production cannot drift on the stale-row fallback path.
    previewThumb: deriveAccountThumb(r.preview_scene_v1),
  }));

  // Background heal for legacy rows with atoms-only stored scenes.
  // `waitUntil` runs after the response is sent — the user sees the
  // (possibly bondless) current data now, and the row is repaired
  // before the next page load. Capped at 3 rebakes per request to
  // keep R2 traffic bounded when a user's feed contains many
  // broken rows from the same launch period.
  const HEAL_CAP_PER_REQUEST = 3;
  let healStarted = 0;
  for (const r of page) {
    if (healStarted >= HEAL_CAP_PER_REQUEST) break;
    if (!r.object_key || !r.preview_scene_v1) continue;
    const scene = parsePreviewSceneV1(r.preview_scene_v1);
    if (!scene || !sceneIsBondless(scene)) continue;
    healStarted++;
    scheduleBackground(
      context,
      healBondlessRow(context.env, { id: r.id, object_key: r.object_key })
        .then((result) => {
          if (!result.ok) {
            console.warn(
              `[account.capsules] bondless-heal-failed: ${result.reason} share=${r.share_code}`,
            );
          }
        }),
      'account.capsules',
    );
  }

  return noCacheJson({
    capsules,
    pageSize: PAGE_SIZE,
    hasMore,
    nextCursor: hasMore && last ? encodeCursor(last.created_at, last.share_code) : null,
  });
};
