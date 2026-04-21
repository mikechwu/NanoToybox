/**
 * Shared lazy-heal for legacy preview_scene_v1 rows that have atoms
 * but no bonds.
 *
 * Background
 * ----------
 * Early publish-time bakes ran a visibility filter that discarded
 * bonds for dense 3D clusters (back-hemisphere atoms projected onto
 * front-hemisphere atoms → "occluded" → dropped) and an atom-count
 * gate that skipped bonds for small clusters (n < 14). Those rows
 * sit in D1 with `preview_scene_v1` populated but `scene.bonds` +
 * `scene.thumb.bonds` both empty. The current publish path
 * (`projectCapsuleToSceneJson`) uses the 3D lab-rule topology
 * (`buildBondTopologyFromAtoms`) and preserves every bond — so a
 * rebake from the original R2 blob produces a complete scene.
 *
 * The two read paths consume this helper differently:
 *   - Poster route uses it SYNCHRONOUSLY — render must wait so the
 *     returned poster carries bonds.
 *   - Account API uses it via `ctx.waitUntil` BACKGROUND — response
 *     returns immediately with the current (possibly bondless) data;
 *     the next page load reflects the healed row.
 *
 * Both modes share this single implementation so D1 rewrites stay
 * consistent and deterministic.
 */

import {
  parsePreviewSceneV1,
  type PreviewSceneV1,
} from './capsule-preview-scene-store';
import { projectCapsuleToSceneJson } from './publish-core';
import {
  validateCapsuleFile,
  type AtomDojoPlaybackCapsuleFileV1,
} from '../history/history-file-v1';

/** Minimal binding surface shared by the poster + account API
 *  function contexts. Keeping this narrow avoids a hard dep on the
 *  full `Env` interface from `functions/env.ts`, which lives in a
 *  different tsconfig project. */
export interface HealEnv {
  DB: {
    prepare(query: string): {
      bind(...binds: unknown[]): { run(): Promise<unknown> };
    };
  };
  R2_BUCKET: {
    get(key: string): Promise<{ text(): Promise<string> } | null>;
  };
}

export type HealResult =
  | { ok: true; scene: PreviewSceneV1; sceneJson: string }
  | { ok: false; reason: string };

/** Returns true when neither the stored scene bonds nor the thumb
 *  bonds carry any entries — the "legacy bondless" shape this
 *  helper is designed to repair. */
export function sceneIsBondless(scene: PreviewSceneV1): boolean {
  const sceneHasBonds = !!(scene.bonds && scene.bonds.length > 0);
  const thumbHasBonds = !!(scene.thumb?.bonds && scene.thumb.bonds.length > 0);
  return !sceneHasBonds && !thumbHasBonds;
}

/** Options governing the D1 UPDATE semantics of {@link rebakeSceneFromR2}. */
export interface RebakeOptions {
  /** When `true`, UPDATE the row regardless of its current
   *  `preview_scene_v1` contents — used by {@link healBondlessRow}
   *  to overwrite legacy atoms-only scenes with a fresh 3D-bonded
   *  one. Deterministic rebake output makes this safe under
   *  concurrent fresh publishes.
   *
   *  When `false` (default), the UPDATE is gated by
   *  `preview_scene_v1 IS NULL` — used on the classic pre-V2
   *  cold-row path so a concurrent publish can't be trampled by a
   *  stale lazy backfill. */
  overwrite?: boolean;
}

/** Shared R2-to-D1 rebake. Caller-chosen UPDATE semantics via
 *  `overwrite` (see {@link RebakeOptions}). Returns the in-memory
 *  scene on success so the caller can render immediately; D1 write
 *  failures are logged but do NOT flip `ok` to false — the render
 *  is already computed in memory, and the next request retries the
 *  write. */
export async function rebakeSceneFromR2(
  env: HealEnv,
  row: { id: string | number; object_key: string | null },
  opts: RebakeOptions = {},
): Promise<HealResult> {
  if (!row.object_key) return { ok: false, reason: 'blob-missing' };
  const obj = await env.R2_BUCKET.get(row.object_key);
  if (!obj) return { ok: false, reason: 'blob-missing' };
  let text: string;
  try {
    text = await obj.text();
  } catch (err) {
    return { ok: false, reason: `blob-read-failed:${err instanceof Error ? err.message : String(err)}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return { ok: false, reason: `capsule-parse-failed:${err instanceof Error ? err.message : String(err)}` };
  }
  const errors = validateCapsuleFile(parsed);
  if (errors.length > 0) {
    return { ok: false, reason: `capsule-parse-failed:${errors[0]}` };
  }
  const capsule = parsed as AtomDojoPlaybackCapsuleFileV1;
  const sceneJson = projectCapsuleToSceneJson(capsule);
  if (!sceneJson) return { ok: false, reason: 'no-dense-frames' };
  const scene = parsePreviewSceneV1(sceneJson);
  if (!scene || scene.atoms.length === 0) return { ok: false, reason: 'scene-empty' };
  try {
    const sql = opts.overwrite
      ? 'UPDATE capsule_share SET preview_scene_v1 = ? WHERE id = ?'
      : 'UPDATE capsule_share SET preview_scene_v1 = ? WHERE id = ? AND preview_scene_v1 IS NULL';
    await env.DB.prepare(sql).bind(sceneJson, row.id).run();
  } catch (err) {
    console.warn(`[preview-heal] write-failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  return { ok: true, scene, sceneJson };
}

/** Heal a bondless legacy row by rebaking from R2 with an
 *  unconditional overwrite. Convenience wrapper over
 *  {@link rebakeSceneFromR2}. */
export function healBondlessRow(
  env: HealEnv,
  row: { id: string | number; object_key: string | null },
): Promise<HealResult> {
  return rebakeSceneFromR2(env, row, { overwrite: true });
}
