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
import { errorMessage } from './error-message';

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

/** Module-scope latch: the `d1-shape-unknown` warning fires at most
 *  once per worker isolate. Without this, a sustained binding-shape
 *  regression (older Workers runtime, a misbehaving mock binding)
 *  would spam the warn log once per rebake call — up to 8 times per
 *  account-list response — drowning out real incidents. One log per
 *  isolate is the right cardinality: operators need the signal
 *  exactly once to trigger an investigation. */
let d1ShapeUnknownWarned = false;

export type HealResult =
  | {
      ok: true;
      scene: PreviewSceneV1;
      sceneJson: string;
      /** `true` when the D1 UPDATE resolved without throwing, `false`
       *  when the in-memory rebake succeeded but the persistence write
       *  failed (logged as `[preview-heal] write-failed`). Callers that
       *  batch rebakes use this to distinguish `rebaked` (in-memory
       *  success count) from `persisted` (committed-to-D1 count). */
      persisted: boolean;
    }
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
  let obj: Awaited<ReturnType<HealEnv['R2_BUCKET']['get']>> = null;
  try {
    obj = await env.R2_BUCKET.get(row.object_key);
  } catch (err) {
    // The R2 binding is contracted to return `null` on miss, but the
    // runtime can still throw on network / permission faults. Keep
    // the documented `ok:false` shape so callers (poster route,
    // account-list background batch) never see a thrown R2 error
    // escape from this helper.
    return { ok: false, reason: `blob-fetch-failed:${errorMessage(err)}` };
  }
  if (!obj) return { ok: false, reason: 'blob-missing' };
  let text: string;
  try {
    text = await obj.text();
  } catch (err) {
    return { ok: false, reason: `blob-read-failed:${errorMessage(err)}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return { ok: false, reason: `capsule-parse-failed:${errorMessage(err)}` };
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
  let persisted = false;
  try {
    const sql = opts.overwrite
      ? 'UPDATE capsule_share SET preview_scene_v1 = ? WHERE id = ?'
      : 'UPDATE capsule_share SET preview_scene_v1 = ? WHERE id = ? AND preview_scene_v1 IS NULL';
    const result = await env.DB.prepare(sql).bind(sceneJson, row.id).run();
    // `persisted` must reflect a real D1 mutation, not just a
    // non-throwing call. A zero-row match (row deleted mid-heal, or
    // the `preview_scene_v1 IS NULL` guard failing against a
    // concurrent publish) returns `meta.changes === 0` without
    // throwing. Upstream operators rely on the `rebaked > persisted`
    // divergence for D1-write-pressure alerting; we must not report
    // success when the row wasn't actually written.
    //
    // When the binding returns a shape with no `meta.changes` at all
    // (older Workers runtimes, a mocked binding in tests), log once
    // per isolate — enough to trigger an investigation without
    // spamming the warn stream under sustained degradation.
    const rawMeta = (result as { meta?: { changes?: number } })?.meta;
    if (rawMeta === undefined && !d1ShapeUnknownWarned) {
      d1ShapeUnknownWarned = true;
      console.warn(
        `[preview-heal] d1-shape-unknown — result missing .meta; persisted counter will report false`,
      );
    }
    const changes = rawMeta?.changes ?? 0;
    persisted = changes >= 1;
  } catch (err) {
    console.warn(`[preview-heal] write-failed: ${errorMessage(err)}`);
  }
  return { ok: true, scene, sceneJson, persisted };
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
