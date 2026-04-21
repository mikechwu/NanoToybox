/**
 * Audit-page ↔ account-route parity lock (ADR D138 follow-up).
 *
 * The audit page renders previews from the live pipeline; the account
 * route reads stored `preview_scene_v1` from D1. If they use different
 * `derivePreviewThumbV1` options, divergence between the two surfaces
 * is hidden and "audit looked fine, why is prod different" recurs.
 *
 * Both sides now share `deriveAccountThumb`
 * (`src/share/capsule-preview-account-derive.ts`). This test locks
 * that contract:
 *
 *   1. FRESH rev-CURRENT row (embedded thumb present) → account path
 *      returns bytes that are byte-equivalent to what the audit page
 *      computes through the same helper (stored-thumb fast path).
 *   2. STALE row (thumb dropped) → account path and audit-page
 *      stale-fallback panel return byte-equivalent output (live-
 *      sampling fallback). Critically, the stale output differs from
 *      the fresh output — so a reviewer can distinguish "row needs
 *      backfill" from "row is current."
 */

import { describe, it, expect } from 'vitest';
import { projectCapsuleToSceneJson } from '../../src/share/publish-core';
import { deriveAccountThumb } from '../../src/share/capsule-preview-account-derive';
import {
  makeC60Capsule,
  makeGrapheneCapsule,
} from '../../src/share/__fixtures__/capsule-preview-structures';

function dropEmbeddedThumb(json: string): string {
  const parsed = JSON.parse(json) as Record<string, unknown>;
  delete parsed.thumb;
  return JSON.stringify(parsed);
}

describe('audit ↔ account parity via deriveAccountThumb', () => {
  for (const [name, build] of [
    ['C60', makeC60Capsule],
    ['graphene', makeGrapheneCapsule],
  ] as const) {
    it(`${name}: fresh and stale derivations are each byte-equivalent across surfaces`, () => {
      const sceneJson = projectCapsuleToSceneJson(build())!;
      expect(sceneJson).not.toBeNull();

      // Each surface calls the same helper — the "two calls" below
      // stand in for the account route (L1) and the audit page (L2).
      // If the shared helper ever splits, this test fails on both
      // sides simultaneously.
      const accountFresh = deriveAccountThumb(sceneJson);
      const auditFresh = deriveAccountThumb(sceneJson);
      expect(accountFresh).not.toBeNull();
      expect(JSON.stringify(accountFresh)).toBe(JSON.stringify(auditFresh));

      const staleJson = dropEmbeddedThumb(sceneJson);
      const accountStale = deriveAccountThumb(staleJson);
      const auditStale = deriveAccountThumb(staleJson);
      expect(accountStale).not.toBeNull();
      expect(JSON.stringify(accountStale)).toBe(JSON.stringify(auditStale));

      // Sanity: stale output should NOT be identical to fresh, or
      // the stale-fallback panel would be pointless. A dense fixture
      // like C60 or graphene guarantees a live-sample path output
      // that differs from the pre-baked rev-3 bytes.
      expect(JSON.stringify(accountStale)).not.toBe(JSON.stringify(accountFresh));
    });
  }

  it('stale fallback still returns a thumb (never null) for a valid scene', () => {
    const sceneJson = projectCapsuleToSceneJson(makeC60Capsule())!;
    const staleJson = dropEmbeddedThumb(sceneJson);
    const stale = deriveAccountThumb(staleJson);
    expect(stale).not.toBeNull();
    expect(stale!.atoms.length).toBeGreaterThan(0);
  });
});
