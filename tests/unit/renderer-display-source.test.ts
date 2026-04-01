/**
 * Tests for the renderer display-source contract.
 *
 * Tests the real Renderer prototype methods via structural/prototype-level
 * assertions. No WebGL instantiation needed — Three.js side-effects only
 * fire on `new Renderer(...)`, not on import.
 */
import { describe, it, expect } from 'vitest';

describe('Renderer display-source API (structural)', () => {
  it('exports getDisplayedMoleculeCentroid', async () => {
    const mod = await import('../../page/js/renderer');
    expect(typeof mod.Renderer.prototype.getDisplayedMoleculeCentroid).toBe('function');
  });

  it('exports getDisplayedMoleculeBounds', async () => {
    const mod = await import('../../page/js/renderer');
    expect(typeof mod.Renderer.prototype.getDisplayedMoleculeBounds).toBe('function');
  });

  it('exports isDisplayingReviewFrame', async () => {
    const mod = await import('../../page/js/renderer');
    expect(typeof mod.Renderer.prototype.isDisplayingReviewFrame).toBe('function');
  });

  it('updateReviewFrame exists and accepts (positions, n)', async () => {
    const mod = await import('../../page/js/renderer');
    expect(typeof mod.Renderer.prototype.updateReviewFrame).toBe('function');
    expect(mod.Renderer.prototype.updateReviewFrame.length).toBe(2);
  });
});

describe('Renderer display-source state transitions (prototype-level)', () => {
  /** Create a fake `this` with the private _getDisplayedPositions helper bound. */
  async function makeFakeRenderer(overrides: Partial<{
    displaySource: 'live' | 'review';
    reviewPositions: Float64Array | null;
    reviewAtomCount: number;
    physicsPos: Float64Array;
    physicsN: number;
  }> = {}) {
    const mod = await import('../../page/js/renderer');
    const fake: any = {
      _displaySource: overrides.displaySource ?? 'live',
      _reviewPositions: overrides.reviewPositions ?? null,
      _reviewAtomCount: overrides.reviewAtomCount ?? 0,
      _physicsRef: overrides.physicsPos
        ? { pos: overrides.physicsPos, n: overrides.physicsN ?? 0 }
        : { pos: new Float64Array([1, 2, 3, 4, 5, 6]), n: 2 },
    };
    // Bind prototype methods to fake instance
    fake._getDisplayedPositions = (mod.Renderer.prototype as any)._getDisplayedPositions.bind(fake);
    fake.getDisplayedMoleculeCentroid = mod.Renderer.prototype.getDisplayedMoleculeCentroid.bind(fake);
    fake.getDisplayedMoleculeBounds = mod.Renderer.prototype.getDisplayedMoleculeBounds.bind(fake);
    fake.isDisplayingReviewFrame = mod.Renderer.prototype.isDisplayingReviewFrame.bind(fake);
    return fake;
  }

  it('live mode computes centroid from physics positions', async () => {
    const r = await makeFakeRenderer();
    const result = r.getDisplayedMoleculeCentroid(0, 2);
    expect(result).not.toBeNull();
    expect(result!.x).toBeCloseTo(2.5); // (1+4)/2
    expect(result!.y).toBeCloseTo(3.5); // (2+5)/2
    expect(result!.z).toBeCloseTo(4.5); // (3+6)/2
  });

  it('review mode computes centroid from cached review positions', async () => {
    const r = await makeFakeRenderer({
      displaySource: 'review',
      reviewPositions: new Float64Array([10, 20, 30, 40, 50, 60]),
      reviewAtomCount: 2,
    });
    const result = r.getDisplayedMoleculeCentroid(0, 2);
    expect(result).not.toBeNull();
    expect(result!.x).toBeCloseTo(25); // (10+40)/2
    expect(result!.y).toBeCloseTo(35); // (20+50)/2
  });

  it('isDisplayingReviewFrame returns correct value', async () => {
    const live = await makeFakeRenderer({ displaySource: 'live' });
    expect(live.isDisplayingReviewFrame()).toBe(false);

    const review = await makeFakeRenderer({
      displaySource: 'review',
      reviewPositions: new Float64Array(6),
      reviewAtomCount: 2,
    });
    expect(review.isDisplayingReviewFrame()).toBe(true);
  });

  it('getDisplayedMoleculeBounds returns bounds with radius', async () => {
    const r = await makeFakeRenderer();
    const result = r.getDisplayedMoleculeBounds(0, 2);
    expect(result).not.toBeNull();
    expect(result!.center).toBeDefined();
    expect(result!.radius).toBeGreaterThan(0);
  });
});

describe('Renderer display-source transitions (real methods)', () => {
  it('updateReviewFrame sets review source and caches positions', async () => {
    const mod = await import('../../page/js/renderer');
    const proto = mod.Renderer.prototype;
    const positions = new Float64Array([10, 20, 30]);
    const fake: any = {
      _displaySource: 'live',
      _reviewPositions: null,
      _reviewAtomCount: 0,
      _instancedAtoms: null, // guard: early-return when null
    };
    // updateReviewFrame early-returns if _instancedAtoms is null, but sets state first
    proto.updateReviewFrame.call(fake, positions, 1);
    // With _instancedAtoms=null, the method returns early AFTER setting display source
    expect(fake._displaySource).toBe('review');
    expect(fake._reviewPositions).toBe(positions);
    expect(fake._reviewAtomCount).toBe(1);
  });

  it('updatePositions restores live source and clears cache', async () => {
    const mod = await import('../../page/js/renderer');
    const proto = mod.Renderer.prototype;
    const physics = { n: 1, pos: new Float64Array([1, 2, 3]), getBonds: () => [] };
    const fake: any = {
      _displaySource: 'review',
      _reviewPositions: new Float64Array(3),
      _reviewAtomCount: 1,
      _physicsRef: null,
      _instancedAtoms: null, // guard: skip mesh updates
      _ensureBondCapacity: () => {},
      _updateBondTransformsInstanced: () => {},
      _updateGroupHighlight: () => {},
      _highlightMesh: null,
    };
    proto.updatePositions.call(fake, physics);
    expect(fake._displaySource).toBe('live');
    expect(fake._reviewPositions).toBeNull();
    expect(fake._reviewAtomCount).toBe(0);
    expect(fake._physicsRef).toBe(physics);
  });

  it('updateFromSnapshot restores live source', async () => {
    const mod = await import('../../page/js/renderer');
    const proto = mod.Renderer.prototype;
    const fake: any = {
      _displaySource: 'review',
      _reviewPositions: new Float64Array(3),
      _reviewAtomCount: 1,
      _instancedAtoms: null,
      _physicsRef: null,
    };
    proto.updateFromSnapshot.call(fake, new Float64Array([1, 2, 3]), 1);
    expect(fake._displaySource).toBe('live');
    expect(fake._reviewPositions).toBeNull();
  });
});
