/**
 * Renderer-level highlight composition tests.
 *
 * Verifies that panel and interaction highlights are truly independent layers
 * that coexist concurrently — not a save/restore priority system.
 *
 * Regression guard: the old bug was "interaction highlight visually replaced
 * persistent bonded-group highlight via single shared mesh."
 */
import { describe, it, expect } from 'vitest';
import { makeStateFake, makeRealMeshCtx } from './highlight-test-utils';

// ── State-level channel tests ──

describe('renderer highlight composition', () => {
  it('panel highlight stays visible when interaction highlight is set', async () => {
    const { fake, proto } = await makeStateFake();
    proto.setHighlightedAtoms.call(fake, [10, 11, 12], 'selected');
    expect(fake._panelHighlightIndices).toEqual([10, 11, 12]);

    proto.setInteractionHighlightedAtoms.call(fake, [0, 1, 2], 'active');
    expect(fake._interactionHighlightIndices).toEqual([0, 1, 2]);
    expect(fake._panelHighlightIndices).toEqual([10, 11, 12]);
  });

  it('panel and interaction use separate state channels', async () => {
    const { fake, proto } = await makeStateFake();
    proto.setHighlightedAtoms.call(fake, [0, 1], 'selected');
    proto.setInteractionHighlightedAtoms.call(fake, [2, 3], 'active');

    expect(fake._panelHighlightIndices).toEqual([0, 1]);
    expect(fake._interactionHighlightIndices).toEqual([2, 3]);
    expect(fake._panelHighlightIntensity).toBe('selected');
    expect(fake._interactionHighlightIntensity).toBe('active');
  });

  it('clearInteractionHighlight does not affect panel highlight', async () => {
    const { fake, proto } = await makeStateFake({
      _panelHighlightIndices: [10, 11],
      _interactionHighlightIndices: [0, 1, 2],
    });
    proto.clearInteractionHighlight.call(fake);
    expect(fake._interactionHighlightIndices).toBeNull();
    expect(fake._panelHighlightIndices).toEqual([10, 11]);
  });

  it('setHighlightedAtoms updates panel state during active interaction', async () => {
    const { fake, proto } = await makeStateFake({
      _panelHighlightIndices: [10, 11],
      _interactionHighlightIndices: [0, 1, 2],
      _interactionHighlightIntensity: 'active',
    });
    proto.setHighlightedAtoms.call(fake, [20, 21, 22], 'hover');
    expect(fake._panelHighlightIndices).toEqual([20, 21, 22]);
    expect(fake._panelHighlightIntensity).toBe('hover');
    expect(fake._interactionHighlightIndices).toEqual([0, 1, 2]);
  });

  it('review-entry cleanup: clears both channels', async () => {
    const { fake, proto } = await makeStateFake({
      _panelHighlightIndices: [10, 11],
      _interactionHighlightIndices: [0, 1, 2],
      _highlightMesh: { visible: true, position: { set: () => {} }, scale: { setScalar: () => {} } },
      highlightAtom: 5,
    });
    fake.setHighlight = proto.setHighlight.bind(fake);

    proto.clearInteractionHighlight.call(fake);
    proto.setHighlight.call(fake, -1);

    expect(fake._interactionHighlightIndices).toBeNull();
    expect(fake.highlightAtom).toBe(-1);
    expect(fake._highlightMesh.visible).toBe(false);
  });

  it('clearing null interaction is a no-op', async () => {
    const { fake, proto } = await makeStateFake({
      _panelHighlightIndices: [5, 6],
    });
    proto.clearInteractionHighlight.call(fake);
    expect(fake._interactionHighlightIndices).toBeNull();
    expect(fake._panelHighlightIndices).toEqual([5, 6]);
  });
});

// ── Real-mesh tests (with THREE geometry) ──

describe('renderer highlight: real mesh behavior', () => {
  it('both meshes exist with nonzero count when both channels active', async () => {
    const { ctx, atomGeom } = await makeRealMeshCtx();
    ctx.setHighlightedAtoms([0, 1], 'selected');
    ctx.setInteractionHighlightedAtoms([3, 4], 'active');

    expect(ctx._panelHighlightMesh).toBeTruthy();
    expect(ctx._interactionHighlightMesh).toBeTruthy();
    expect(ctx._panelHighlightMesh.count).toBe(2);
    expect(ctx._interactionHighlightMesh.count).toBe(2);
    expect(ctx._panelHighlightMesh).not.toBe(ctx._interactionHighlightMesh);
    atomGeom.dispose();
  });

  it('review hide then live update restores visibility', async () => {
    const { ctx, atomGeom } = await makeRealMeshCtx();
    ctx.setHighlightedAtoms([0, 1], 'selected');
    ctx.setInteractionHighlightedAtoms([2, 3], 'active');

    // Simulate review mode hide
    ctx._panelHighlightMesh.visible = false;
    ctx._interactionHighlightMesh.visible = false;

    // Resume live — compositor restores visibility
    ctx._updateGroupHighlight();
    expect(ctx._panelHighlightMesh.visible).toBe(true);
    expect(ctx._interactionHighlightMesh.visible).toBe(true);
    atomGeom.dispose();
  });

  it('partial overlap: overlap atom rendered on BOTH layers', async () => {
    const { ctx, atomGeom } = await makeRealMeshCtx();
    ctx.setHighlightedAtoms([0, 1, 2], 'selected');
    ctx.setInteractionHighlightedAtoms([1, 3], 'active');
    ctx._updateGroupHighlight();

    // Panel: panelOnly (0, 2) + overlap (1) = 3
    expect(ctx._panelHighlightMesh.count).toBe(3);
    // Interaction: interactionOnly (3) + overlap (1) = 2
    expect(ctx._interactionHighlightMesh.count).toBe(2);
    atomGeom.dispose();
  });

  it('full overlap: all panel atoms also in interaction', async () => {
    const { ctx, atomGeom } = await makeRealMeshCtx();
    ctx.setHighlightedAtoms([1, 2], 'selected');
    ctx.setInteractionHighlightedAtoms([1, 2, 3], 'active');
    ctx._updateGroupHighlight();

    expect(ctx._panelHighlightMesh.count).toBe(2);
    expect(ctx._interactionHighlightMesh.count).toBe(3);
    atomGeom.dispose();
  });

  it('disposeHighlightLayers cleans up both layers and resets intensities', async () => {
    const { ctx, atomGeom } = await makeRealMeshCtx();
    ctx.setHighlightedAtoms([0, 1], 'hover');
    ctx.setInteractionHighlightedAtoms([2, 3], 'active');

    ctx._disposeHighlightLayers();

    expect(ctx._panelHighlightMesh).toBeNull();
    expect(ctx._panelHighlightMat).toBeNull();
    expect(ctx._panelHighlightIndices).toBeNull();
    expect(ctx._panelHighlightIntensity).toBe('selected'); // reset to default
    expect(ctx._panelHighlightCapacity).toBe(0);
    expect(ctx._interactionHighlightMesh).toBeNull();
    expect(ctx._interactionHighlightMat).toBeNull();
    expect(ctx._interactionHighlightIndices).toBeNull();
    expect(ctx._interactionHighlightIntensity).toBe('hover'); // reset to default
    expect(ctx._interactionHighlightCapacity).toBe(0);
    atomGeom.dispose();
  });
});

// ── Integration regression: the original user bug ──

describe('integration regression: multi-molecule highlight coexistence', () => {
  it('bonded-group selection + move/rotate on different molecules both visible', async () => {
    const { ctx, atomGeom } = await makeRealMeshCtx(10);

    // Step 1: User selects bonded group on molecule A (atoms 0-4)
    ctx.setHighlightedAtoms([0, 1, 2, 3, 4], 'selected');
    expect(ctx._panelHighlightMesh).toBeTruthy();
    expect(ctx._panelHighlightMesh.count).toBe(5);

    // Step 2: User starts rotating molecule B (atoms 5-9)
    ctx.setInteractionHighlightedAtoms([5, 6, 7, 8, 9], 'active');

    // REGRESSION CHECK: molecule A's panel highlight must still be visible
    expect(ctx._panelHighlightMesh.count).toBe(5);
    expect(ctx._panelHighlightMesh.visible).toBe(true);

    // Molecule B's interaction highlight must also be visible
    expect(ctx._interactionHighlightMesh).toBeTruthy();
    expect(ctx._interactionHighlightMesh.count).toBe(5);
    expect(ctx._interactionHighlightMesh.visible).toBe(true);

    // Step 3: User finishes rotating — interaction clears
    ctx.clearInteractionHighlight();

    // Panel highlight must still be there (no restore needed)
    expect(ctx._panelHighlightMesh.count).toBe(5);
    expect(ctx._panelHighlightMesh.visible).toBe(true);
    expect(ctx._interactionHighlightIndices).toBeNull();

    atomGeom.dispose();
  });
});
