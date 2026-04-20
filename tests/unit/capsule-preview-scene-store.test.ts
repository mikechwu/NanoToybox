/**
 * Tests for src/share/capsule-preview-scene-store.ts (spec §S1).
 *
 * Covers serialization round-trip, hash determinism, storage-vs-row-payload
 * boundary (bonds stripped when deriving PreviewThumbV1), and the read-path
 * failure modes the account API relies on.
 */

import { describe, it, expect } from 'vitest';
import {
  buildPreviewSceneV1,
  derivePreviewThumbV1,
  parsePreviewSceneV1,
  PREVIEW_SCENE_SCHEMA_VERSION,
  ROW_ATOM_CAP,
  ROW_ATOM_CAP_WITH_BONDS,
  SCENE_ATOM_CAP,
  SCENE_BOND_CAP,
  sceneHash,
  serializePreviewSceneV1,
  type PreviewSceneAtomV1,
} from '../../src/share/capsule-preview-scene-store';
import { sampleEvenly } from '../../src/share/capsule-preview-sampling';
import type { CapsulePreviewRenderScene } from '../../src/share/capsule-preview-project';

function makeRenderScene(n: number): CapsulePreviewRenderScene {
  const atoms = [];
  for (let i = 0; i < n; i++) {
    atoms.push({
      atomId: i,
      x: 100 + i * 10,
      y: 200 + i * 5,
      r: 6,
      colorHex: i % 2 === 0 ? '#222222' : '#3050f8',
      depth: i * 0.1,
    });
  }
  return {
    atoms,
    bounds: { width: 600, height: 500 },
    classification: 'general',
  };
}

describe('buildPreviewSceneV1', () => {
  it('normalizes pixel coordinates into 0..1 storage space', () => {
    const scene = buildPreviewSceneV1(makeRenderScene(3));
    for (const a of scene.atoms) {
      expect(a.x).toBeGreaterThanOrEqual(0);
      expect(a.x).toBeLessThanOrEqual(1);
      expect(a.y).toBeGreaterThanOrEqual(0);
      expect(a.y).toBeLessThanOrEqual(1);
    }
  });

  it('emits the current schema version and an 8-hex hash', () => {
    const scene = buildPreviewSceneV1(makeRenderScene(4));
    expect(scene.v).toBe(PREVIEW_SCENE_SCHEMA_VERSION);
    expect(scene.hash).toMatch(/^[0-9a-f]{8}$/);
  });

  it('is deterministic for the same input', () => {
    const a = buildPreviewSceneV1(makeRenderScene(5));
    const b = buildPreviewSceneV1(makeRenderScene(5));
    expect(a).toEqual(b);
    expect(a.hash).toBe(b.hash);
  });

  it('caps the stored atoms at SCENE_ATOM_CAP', () => {
    const scene = buildPreviewSceneV1(makeRenderScene(SCENE_ATOM_CAP + 10));
    expect(scene.atoms.length).toBe(SCENE_ATOM_CAP);
  });

  it('caps stored bonds at SCENE_BOND_CAP and drops out-of-range endpoints', () => {
    const scene = buildPreviewSceneV1(
      makeRenderScene(4),
      [
        { a: 0, b: 1 },
        { a: 1, b: 2 },
        { a: 2, b: 3 },
        { a: 10, b: 11 }, // out of range — dropped
      ],
    );
    expect(scene.bonds).toBeDefined();
    expect(scene.bonds!.every((b) => b.a < scene.atoms.length && b.b < scene.atoms.length)).toBe(true);
  });

  it('omits the bonds field when every input bond is dropped or empty', () => {
    const none = buildPreviewSceneV1(makeRenderScene(2), []);
    expect(none.bonds).toBeUndefined();
    const allBad = buildPreviewSceneV1(makeRenderScene(2), [{ a: 7, b: 8 }]);
    expect(allBad.bonds).toBeUndefined();
  });

  it('bond-cap is honored when input exceeds SCENE_BOND_CAP', () => {
    const bonds = [];
    for (let i = 0; i < SCENE_BOND_CAP + 10; i++) {
      bonds.push({ a: 0, b: 1 });
    }
    const scene = buildPreviewSceneV1(makeRenderScene(4), bonds);
    expect(scene.bonds!.length).toBe(SCENE_BOND_CAP);
  });
});

describe('serialize/parse round-trip', () => {
  it('is a round-trip identity for well-formed scenes', () => {
    const scene = buildPreviewSceneV1(makeRenderScene(6), [{ a: 0, b: 1 }, { a: 2, b: 3 }]);
    const json = serializePreviewSceneV1(scene);
    const round = parsePreviewSceneV1(json);
    expect(round).not.toBeNull();
    expect(round!.v).toBe(PREVIEW_SCENE_SCHEMA_VERSION);
    expect(round!.atoms).toEqual(scene.atoms);
    expect(round!.bonds).toEqual(scene.bonds);
    expect(round!.hash).toBe(scene.hash);
  });

  it('returns null for empty / null / malformed JSON', () => {
    expect(parsePreviewSceneV1(null)).toBeNull();
    expect(parsePreviewSceneV1('')).toBeNull();
    expect(parsePreviewSceneV1('not-json')).toBeNull();
    expect(parsePreviewSceneV1('{}')).toBeNull();
    expect(parsePreviewSceneV1('{"v":1}')).toBeNull();
  });

  it('rejects unknown schema versions', () => {
    expect(parsePreviewSceneV1('{"v":2,"atoms":[]}')).toBeNull();
  });

  it('parses legacy scenes without a hash field (recomputes from atoms)', () => {
    const raw = JSON.stringify({
      v: 1,
      atoms: [{ x: 0.1, y: 0.2, r: 0.05, c: '#222222' }],
    });
    const parsed = parsePreviewSceneV1(raw);
    expect(parsed).not.toBeNull();
    expect(parsed!.hash).toMatch(/^[0-9a-f]{8}$/);
  });
});

describe('sceneHash', () => {
  it('is deterministic across identical atom arrays', () => {
    const atoms: PreviewSceneAtomV1[] = [
      { x: 0.25, y: 0.5, r: 0.04, c: '#222222' },
      { x: 0.75, y: 0.5, r: 0.04, c: '#3050f8' },
    ];
    expect(sceneHash(atoms)).toBe(sceneHash(atoms));
  });

  it('is bonds-independent', () => {
    const scene = buildPreviewSceneV1(makeRenderScene(4));
    const withBonds = buildPreviewSceneV1(makeRenderScene(4), [{ a: 0, b: 1 }]);
    expect(scene.hash).toBe(withBonds.hash);
  });

  it('changes when a single atom moves', () => {
    const a = buildPreviewSceneV1(makeRenderScene(4));
    const shifted = makeRenderScene(4);
    shifted.atoms[0].x += 50;
    const b = buildPreviewSceneV1(shifted);
    expect(a.hash).not.toBe(b.hash);
  });
});

describe('derivePreviewThumbV1', () => {
  it('returns null for absent / malformed input', () => {
    expect(derivePreviewThumbV1(null)).toBeNull();
    expect(derivePreviewThumbV1('')).toBeNull();
    expect(derivePreviewThumbV1('garbage')).toBeNull();
  });

  it('strips the storage-only hash field and keeps atoms', () => {
    const stored = buildPreviewSceneV1(makeRenderScene(4));
    const json = serializePreviewSceneV1(stored);
    const thumb = derivePreviewThumbV1(json);
    expect(thumb).not.toBeNull();
    expect(thumb!.v).toBe(1);
    expect(thumb!.atoms.length).toBe(stored.atoms.length);
    expect((thumb as any).hash).toBeUndefined();
  });

  it('omits bonds when the source scene has none', () => {
    const stored = buildPreviewSceneV1(makeRenderScene(4));
    const thumb = derivePreviewThumbV1(serializePreviewSceneV1(stored));
    expect(thumb!.bonds).toBeUndefined();
  });

  it('omits bonds on sparse scenes even if storage carries them', () => {
    const stored = buildPreviewSceneV1(
      makeRenderScene(3),
      [{ a: 0, b: 1 }, { a: 1, b: 2 }],
    );
    const thumb = derivePreviewThumbV1(serializePreviewSceneV1(stored));
    // n < 6 → atoms-only budget; bonds would waste DOM slots on a scene
    // that's already legible as dots.
    expect(thumb!.bonds).toBeUndefined();
  });

  it('carries a capped bond subset for dense scenes whose storage has bonds', () => {
    // 16 atoms (≥ BONDS_AWARE_SOURCE_THRESHOLD=14), 20 bonds → crosses
    // the dense-thumb gate; thumb caps bonds at 6. Disable the visible-
    // bond filter so this test exercises the cap contract regardless of
    // how tightly the fixture's atoms cluster in normalized space.
    const bonds = Array.from({ length: 20 }, (_, i) => ({ a: i % 16, b: (i + 1) % 16 }));
    const stored = buildPreviewSceneV1(makeRenderScene(16), bonds);
    const thumb = derivePreviewThumbV1(serializePreviewSceneV1(stored), {
      minVisibleBondViewbox: 0,
      minAcceptableBonds: 0,
    });
    expect(thumb!.bonds).toBeDefined();
    expect(thumb!.bonds!.length).toBeLessThanOrEqual(6);
    // Every bond references a real atom in the thumb payload.
    for (const b of thumb!.bonds!) {
      expect(b.a).toBeGreaterThanOrEqual(0);
      expect(b.a).toBeLessThan(thumb!.atoms.length);
      expect(b.b).toBeGreaterThanOrEqual(0);
      expect(b.b).toBeLessThan(thumb!.atoms.length);
    }
  });

  it('gates bonds mode on source atom count (<14 stays atoms-only even with bonds)', () => {
    // 10 atoms + bonds — below the dense threshold, so the thumb should
    // still use the atoms-only budget with no bonds carried.
    const bonds = Array.from({ length: 8 }, (_, i) => ({ a: i % 10, b: (i + 1) % 10 }));
    const stored = buildPreviewSceneV1(makeRenderScene(10), bonds);
    const thumb = derivePreviewThumbV1(serializePreviewSceneV1(stored));
    expect(thumb!.bonds).toBeUndefined();
    expect(thumb!.atoms.length).toBeLessThanOrEqual(18);
  });

  it('caps per-atom bond degree so one cluster cannot consume the budget', () => {
    // Build a "star" where atom 0 is connected to 1, 2, 3, 4, 5, 6, 7
    // (7 bonds all touching atom 0). With bondMaxDegree=2, only 2 bonds
    // can reach atom 0 — remaining budget spends on other pairs.
    // Disable visibility filter: fixture atoms are tightly spaced in
    // normalized space, so this test asserts the cap contract directly.
    const starBonds = [
      { a: 0, b: 1 }, { a: 0, b: 2 }, { a: 0, b: 3 }, { a: 0, b: 4 },
      { a: 0, b: 5 }, { a: 0, b: 6 }, { a: 0, b: 7 },
      { a: 8, b: 9 }, { a: 10, b: 11 }, { a: 12, b: 13 }, { a: 14, b: 15 },
    ];
    const stored = buildPreviewSceneV1(makeRenderScene(16), starBonds);
    const thumb = derivePreviewThumbV1(serializePreviewSceneV1(stored), {
      minVisibleBondViewbox: 0,
      minAcceptableBonds: 0,
    });
    const degree = new Map<number, number>();
    for (const b of thumb!.bonds ?? []) {
      degree.set(b.a, (degree.get(b.a) ?? 0) + 1);
      degree.set(b.b, (degree.get(b.b) ?? 0) + 1);
    }
    for (const d of degree.values()) expect(d).toBeLessThanOrEqual(2);
  });

  it('refit stretches a shrunken storage layout to fill the thumb (glyph-aware)', () => {
    // Build a storage scene where atoms are clustered in a small 20% box
    // at the center. The refit scales the CENTER-CLOUD to fill the
    // padded cell minus 2×render-margin on each side, so the RENDERED
    // atom glyphs (centers + radius/stroke) reach the padded edge.
    const atoms: PreviewSceneAtomV1[] = [
      { x: 0.45, y: 0.45, r: 0.03, c: '#222222' },
      { x: 0.55, y: 0.45, r: 0.03, c: '#222222' },
      { x: 0.55, y: 0.55, r: 0.03, c: '#222222' },
      { x: 0.45, y: 0.55, r: 0.03, c: '#222222' },
    ];
    const raw = JSON.stringify({ v: 1, atoms, hash: 'deadbeef' });
    const thumb = derivePreviewThumbV1(raw);
    const xs = thumb!.atoms.map((a) => a.x);
    const ys = thumb!.atoms.map((a) => a.y);
    const spanX = Math.max(...xs) - Math.min(...xs);
    const spanY = Math.max(...ys) - Math.min(...ys);
    // Center-span target ≈ 1 - 2 × (padding + renderMargin) ≈ 0.73.
    // Lower bound of 0.7 leaves tolerance for rounding while still
    // catching the "refit did nothing" regression.
    expect(Math.min(spanX, spanY)).toBeGreaterThanOrEqual(0.7);
    // Glyph-aware assertion: including the 0.095 radius margin, the
    // drawn bounding box spans at least 90% of the thumb.
    const RENDER_MARGIN = 0.095;
    expect(Math.min(spanX, spanY) + 2 * RENDER_MARGIN).toBeGreaterThanOrEqual(0.9);
  });

  it('single-atom thumb refits to the center of the box', () => {
    const raw = JSON.stringify({
      v: 1,
      atoms: [{ x: 0.9, y: 0.1, r: 0.03, c: '#222222' }],
      hash: 'deadbeef',
    });
    const thumb = derivePreviewThumbV1(raw);
    expect(thumb!.atoms[0].x).toBeCloseTo(0.5, 3);
    expect(thumb!.atoms[0].y).toBeCloseTo(0.5, 3);
  });

  it('passes small arrays through (no over-eager re-sampling; refit still applied)', () => {
    const stored = buildPreviewSceneV1(makeRenderScene(5));
    const json = serializePreviewSceneV1(stored);
    const thumb = derivePreviewThumbV1(json);
    expect(thumb!.atoms.length).toBe(stored.atoms.length);
  });

  it('caps atoms at the atoms-only budget by default (no bonds in storage)', () => {
    const stored = buildPreviewSceneV1(makeRenderScene(SCENE_ATOM_CAP));
    const thumb = derivePreviewThumbV1(serializePreviewSceneV1(stored), {
      sampler: (items, target) => sampleEvenly(items as any, target) as any,
    });
    expect(thumb!.atoms.length).toBeLessThanOrEqual(ROW_ATOM_CAP);
  });

  // ── Visibility-oriented tests (outcome-level, not contract-level) ─────

  it('falls back to atoms-only when bond visibility would be degenerate', () => {
    // Atoms clustered at a single point (via bounds width), plus chain
    // bonds. Refit centers all atoms within 1 pixel so every bond's
    // visible segment is ≤ 0 viewBox units → visibility filter drops
    // them all → bonded path produces 0 bonds → fallback kicks in.
    const scene: CapsulePreviewRenderScene = {
      atoms: Array.from({ length: 16 }, (_, i) => ({
        atomId: i,
        // Tight cluster: all atoms within 1% of center.
        x: 300 + (i % 4) * 0.5,
        y: 250 + Math.floor(i / 4) * 0.5,
        r: 6,
        colorHex: '#222222',
        depth: 0,
      })),
      bounds: { width: 600, height: 500 },
      classification: 'general',
    };
    const bonds = Array.from({ length: 10 }, (_, i) => ({ a: i % 16, b: (i + 1) % 16 }));
    const stored = buildPreviewSceneV1(scene, bonds);
    const thumb = derivePreviewThumbV1(serializePreviewSceneV1(stored), {
      sampler: sampleEvenly as any,
    });
    // Fallback must either (a) produce ≥ 2 visible bonds, or (b) emit
    // atoms-only at the sparse cap. Never emit < 2 bonds with the dense
    // atom cap.
    if (thumb!.bonds && thumb!.bonds.length > 0) {
      expect(thumb!.bonds.length).toBeGreaterThanOrEqual(2);
    } else {
      expect(thumb!.atoms.length).toBeGreaterThan(ROW_ATOM_CAP_WITH_BONDS);
    }
  });

  it('every rendered bond has enough exposed segment to be perceptible', () => {
    // Construct a scene whose atoms are well-separated so some bonds
    // survive the visibility filter, then assert each kept bond's
    // exposed length (len − 2r) exceeds the rendered-visibility floor.
    const scene: CapsulePreviewRenderScene = {
      atoms: Array.from({ length: 16 }, (_, i) => ({
        atomId: i,
        x: 50 + (i % 4) * 130,
        y: 50 + Math.floor(i / 4) * 100,
        r: 6,
        colorHex: '#222222',
        depth: 0,
      })),
      bounds: { width: 600, height: 500 },
      classification: 'general',
    };
    const bonds = Array.from({ length: 10 }, (_, i) => ({ a: i % 16, b: (i + 1) % 16 }));
    const stored = buildPreviewSceneV1(scene, bonds);
    const thumb = derivePreviewThumbV1(serializePreviewSceneV1(stored));
    if (!thumb?.bonds) return;
    // Bonded atom radius is 2.8 viewBox; the derivation's visibility
    // filter rejects bonds with exposed segment < 3 viewBox.
    const atomR = 2.8;
    for (const b of thumb.bonds) {
      const pa = thumb.atoms[b.a];
      const pb = thumb.atoms[b.b];
      const len = Math.hypot((pb.x - pa.x) * 100, (pb.y - pa.y) * 100);
      const visible = len - 2 * atomR;
      expect(visible).toBeGreaterThanOrEqual(3);
    }
  });

  it('caps atoms at the bonds-aware budget when bonds-mode produces enough visible bonds', () => {
    // Disable the visibility filter so this test covers the cap contract
    // directly. Production uses the filter to fall back to atoms-only
    // when bonds would be invisible — a separate regime with its own tests.
    const bonds = Array.from({ length: 20 }, (_, i) => ({ a: i % 30, b: (i + 1) % 30 }));
    const stored = buildPreviewSceneV1(makeRenderScene(30), bonds);
    const thumb = derivePreviewThumbV1(serializePreviewSceneV1(stored), {
      minVisibleBondViewbox: 0,
      minAcceptableBonds: 0,
    });
    expect(thumb!.atoms.length).toBeLessThanOrEqual(12);
  });
});
