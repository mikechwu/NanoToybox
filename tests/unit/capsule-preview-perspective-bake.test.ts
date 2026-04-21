/**
 * Perspective-bake invariants for the account-row thumbnail.
 *
 * Path A (publish-time pinhole perspective) must match the audit-
 * page experimental renderer's math so the account thumb is a
 * faithful small-scale preview of what the workbench shows at 800
 * px. This test file locks down three invariants that would drift
 * silently if future renderer work diverges:
 *
 *   1. The `rMin / rMax` ratio of stored per-atom radii equals the
 *      theoretical `K / (K+1) = 0.6` at K=1.5. If someone changes
 *      K upstream without updating the bake, or if the floor kicks
 *      in for a typical scene, this number shifts off 60% and this
 *      test fails loudly.
 *
 *   2. `projectPreviewScenePerspective` and `renderPerspectiveSketch`
 *      (the audit-page renderer) resolve the SAME camera on the
 *      same scene — both go through `deriveMinorAxisCamera`. A
 *      regression to `deriveCanonicalPreviewCamera` (tilted) would
 *      silently misalign thumbs vs the audit-page preview; this
 *      test catches the drift by asserting the per-atom depth
 *      ordering is identical.
 *
 *   3. The orthographic poster path is UNCHANGED — `projectPreviewScene`
 *      still produces uniform atom radii (no perspective bleed into
 *      the 1200×630 OG poster).
 */

import { describe, it, expect } from 'vitest';
import {
  projectPreviewScene,
  projectPreviewScenePerspective,
  PERSPECTIVE_K_DEFAULT,
} from '../../src/share/capsule-preview-project';
import { deriveMinorAxisCamera } from '../../src/share/capsule-preview-camera';
import { buildPreviewSceneFromCapsule } from '../../src/share/capsule-preview-frame';
import { makeC60Capsule, makeCntCapsule } from '../../src/share/__fixtures__/capsule-preview-structures';
import { projectCapsuleToSceneJson } from '../../src/share/publish-core';
import { deriveAccountThumb } from '../../src/share/capsule-preview-account-derive';

describe('perspective-bake invariants', () => {
  it('stored per-atom r ratio matches K/(K+1) = 0.6 at K=1.5', () => {
    // C60 has real depth span and no degenerate-axis pathology, so
    // the theoretical 60% ratio should hold almost exactly.
    const json = projectCapsuleToSceneJson(makeC60Capsule())!;
    const thumb = deriveAccountThumb(json)!;
    const rs = thumb.atoms.map((a) => a.r);
    const rMin = Math.min(...rs);
    const rMax = Math.max(...rs);
    const ratio = rMin / rMax;
    const expected = PERSPECTIVE_K_DEFAULT / (PERSPECTIVE_K_DEFAULT + 1);
    expect(ratio).toBeCloseTo(expected, 2); // ≈ 0.60 at K=1.5
  });

  it('CNT — elongated subject — still shows meaningful depth variance', () => {
    const json = projectCapsuleToSceneJson(makeCntCapsule())!;
    const thumb = deriveAccountThumb(json)!;
    const rs = thumb.atoms.map((a) => a.r);
    const rMin = Math.min(...rs);
    const rMax = Math.max(...rs);
    // For the untilted minor-axis camera, a CNT lying along the
    // principal axis projects with the shorter transverse span as
    // depth. Depth variance isn't guaranteed to reach the
    // theoretical 60% floor (atoms cluster in a narrow z band), but
    // it should be strictly under 1 — otherwise perspective is a
    // no-op and something regressed.
    expect(rMin).toBeLessThan(rMax);
  });

  it('projectPreviewScenePerspective uses the SAME camera as the audit-page renderer', () => {
    // Both must resolve to `deriveMinorAxisCamera`. The audit-page
    // renderer imports that name; the publish helper should too.
    // Assert by calling the production helper with a passed-in
    // untilted camera and confirming the output depth ordering
    // matches what the default call produces.
    const scene = buildPreviewSceneFromCapsule(makeC60Capsule());
    const cam = deriveMinorAxisCamera(scene);
    const withDefault = projectPreviewScenePerspective(scene);
    const withExplicit = projectPreviewScenePerspective(scene, { camera: cam });
    expect(withDefault.atoms.length).toBe(withExplicit.atoms.length);
    for (let i = 0; i < withDefault.atoms.length; i++) {
      expect(withDefault.atoms[i].atomId).toBe(withExplicit.atoms[i].atomId);
      expect(withDefault.atoms[i].depth).toBeCloseTo(withExplicit.atoms[i].depth, 6);
      expect(withDefault.atoms[i].r).toBeCloseTo(withExplicit.atoms[i].r, 6);
    }
  });

  it('projectPreviewScene (orthographic function) emits uniform-radius atoms', () => {
    // Function-level contract: the orthographic projector itself
    // must keep producing uniform radii when called directly. It is
    // no longer the production poster path (as of 2026-04-21 D135
    // follow-up 4 the poster bake uses `projectPreviewScenePerspective`
    // instead), but the helper stays available for any future
    // surface that genuinely wants a structural-diagram shape. If
    // this test ever flips to non-uniform, the function accidentally
    // picked up perspective scaling — investigate before consumers
    // that still rely on "one radius per bake" (none today, but the
    // contract is still worth guarding).
    const scene = buildPreviewSceneFromCapsule(makeC60Capsule());
    const ortho = projectPreviewScene(scene);
    const rs = new Set(ortho.atoms.map((a) => a.r));
    expect(rs.size).toBe(1);
  });

  it('perspective path sorts atoms back-to-front (near painted last)', () => {
    const scene = buildPreviewSceneFromCapsule(makeC60Capsule());
    const persp = projectPreviewScenePerspective(scene);
    // Atoms[] is sorted by depth ascending (far→near) so the renderer
    // can paint in array order and near atoms occlude far atoms.
    for (let i = 1; i < persp.atoms.length; i++) {
      expect(persp.atoms[i].depth).toBeGreaterThanOrEqual(persp.atoms[i - 1].depth);
    }
  });
});
