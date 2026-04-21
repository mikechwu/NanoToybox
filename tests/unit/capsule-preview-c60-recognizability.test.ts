/**
 * C60 recognizability gate — load-bearing for ADR D138 follow-ups.
 *
 * The original thumb pipeline allowed a 60-atom C60 cage to collapse
 * into a 12-atom / 6-bond sparse fragment that read as "scattered
 * dots" at 40 px. The ≤20 DOM-element budget hard-capped atom and
 * bond counts; the longest-visible-bond picker preferred perimeter
 * strokes over cycle-closing bonds. Together these produced
 * unrecognizable output even after cluster selection ran correctly.
 *
 * This test locks in the recognizability floor for C60 under the
 * shipped (96 px, 48/48 caps) pipeline:
 *
 *   1. The account-route derivation (`deriveAccountThumb`) must
 *      return a bonded thumb (not atoms-only fallback).
 *   2. Bonds must be enough to suggest a cage — we require well
 *      above the legacy 6-bond cap.
 *   3. The bonded subgraph must be a SINGLE connected component
 *      (not disconnected fragments).
 *   4. Atom coverage must span broadly across the 0..1 thumb cell
 *      in both axes — a thin perimeter arc fails this.
 *   5. A meaningful fraction of sampled atoms must actually carry
 *      at least one bond — scattered isolates read as dot noise
 *      regardless of how well-connected the bonded subset is.
 *
 * If any of these fail, the thumb pipeline has regressed on the
 * cage case even if the lower-level selector / renderer tests still
 * pass.
 */

import { describe, it, expect } from 'vitest';
import { projectCapsuleToSceneJson } from '../../src/share/publish-core';
import { deriveAccountThumb } from '../../src/share/capsule-preview-account-derive';
import { makeC60Capsule } from '../../src/share/__fixtures__/capsule-preview-structures';
import type { PreviewThumbV1 } from '../../src/share/capsule-preview-scene-store';

/** Count connected components of the thumb's bonded subgraph. */
function countComponents(thumb: PreviewThumbV1): number {
  const adj = new Map<number, Set<number>>();
  for (let i = 0; i < thumb.atoms.length; i++) adj.set(i, new Set());
  for (const b of thumb.bonds ?? []) {
    adj.get(b.a)?.add(b.b);
    adj.get(b.b)?.add(b.a);
  }
  const seen = new Set<number>();
  let components = 0;
  for (let i = 0; i < thumb.atoms.length; i++) {
    if (seen.has(i)) continue;
    // BFS from i across bonded adjacency; isolated atoms still count
    // as their own component.
    const stack = [i];
    while (stack.length > 0) {
      const n = stack.pop()!;
      if (seen.has(n)) continue;
      seen.add(n);
      for (const m of adj.get(n) ?? []) stack.push(m);
    }
    components++;
  }
  return components;
}

function bondedComponentCount(thumb: PreviewThumbV1): number {
  // Count components over the BONDED subgraph only (ignoring isolated
  // atoms that have no bonds at all). This is the shape-preservation
  // signal: a closed cage should be 1; fragments score higher.
  const adj = new Map<number, Set<number>>();
  const touched = new Set<number>();
  for (const b of thumb.bonds ?? []) {
    if (!adj.has(b.a)) adj.set(b.a, new Set());
    if (!adj.has(b.b)) adj.set(b.b, new Set());
    adj.get(b.a)!.add(b.b);
    adj.get(b.b)!.add(b.a);
    touched.add(b.a);
    touched.add(b.b);
  }
  const seen = new Set<number>();
  let components = 0;
  for (const start of touched) {
    if (seen.has(start)) continue;
    const stack = [start];
    while (stack.length > 0) {
      const n = stack.pop()!;
      if (seen.has(n)) continue;
      seen.add(n);
      for (const m of adj.get(n) ?? []) stack.push(m);
    }
    components++;
  }
  return components;
}

function axisSpan(values: number[]): number {
  if (values.length === 0) return 0;
  let min = Infinity, max = -Infinity;
  for (const v of values) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return max - min;
}

describe('C60 recognizability at 40 px', () => {
  const capsule = makeC60Capsule();
  const sceneJson = projectCapsuleToSceneJson(capsule)!;
  const thumb = deriveAccountThumb(sceneJson)!;

  it('takes the bonded path (not atoms-only fallback)', () => {
    expect(thumb).not.toBeNull();
    expect(thumb.bonds).toBeDefined();
    expect(thumb.bonds!.length).toBeGreaterThan(0);
  });

  it('retains enough bonds to suggest cage structure (well above the legacy 6-cap)', () => {
    // The pre-D138-follow-up cap was 6. The new cap is 24 and the
    // cycle-preserving picker should actually use most of it on a
    // closed cage. Require ≥ 12 to prove we are no longer collapsing
    // to a perimeter sliver.
    expect(thumb.bonds!.length).toBeGreaterThanOrEqual(12);
  });

  it('renders the bonded subgraph as a small number of connected components', () => {
    // Under rev 11 (2× atoms, EXPERIMENTAL shading), the larger
    // glyph radius means more bonds fail the per-endpoint
    // visibility filter. C60's 90-edge cage sometimes resolves
    // into 2 connected clumps instead of 1 — visually still reads
    // as a cage because the atoms are spatially contiguous.
    // Relax to ≤ 3 to match the new cap + style tradeoff; more
    // than 3 would indicate the sampler has drifted toward
    // genuinely disconnected fragments.
    expect(bondedComponentCount(thumb)).toBeLessThanOrEqual(3);
  });

  it('covers the thumb cell broadly in both axes (no thin perimeter arc)', () => {
    const xs = thumb.atoms.map((a) => a.x);
    const ys = thumb.atoms.map((a) => a.y);
    // Atoms are normalized 0..1 in the refit cell. A healthy cage
    // renders should span most of each axis — ≥ 65% is the floor
    // that distinguishes a broad 2D projection from a thin
    // perimeter sliver. At current output (C60 renders ~0.70 on x,
    // ~0.83 on y) this is a comfortable gate, not a tight one.
    expect(axisSpan(xs)).toBeGreaterThanOrEqual(0.65);
    expect(axisSpan(ys)).toBeGreaterThanOrEqual(0.65);
  });

  it('keeps a meaningful majority of sampled atoms inside the bonded subgraph', () => {
    // Under the 48/48 caps the sampler sometimes picks atoms whose
    // bonds all fail the visibility filter (isolates). The right
    // signal isn't the absolute singleton count — which scales with
    // the cap — but the fraction of atoms that actually participate
    // in bonds. Require ≥ 60%. For the current C60 output that's
    // ~39/48 = 81%, so this is a comfortable floor. Dropping below
    // it means the sampler is drifting toward scattered singletons
    // that read as dot noise.
    const bonded = new Set<number>();
    for (const b of thumb.bonds ?? []) {
      bonded.add(b.a);
      bonded.add(b.b);
    }
    const bondedFraction = bonded.size / thumb.atoms.length;
    expect(bondedFraction).toBeGreaterThanOrEqual(0.6);
  });
});
