/**
 * Renderer-level highlight coexistence tests.
 *
 * Verifies that interaction highlight and panel highlight are separate channels
 * that coexist without clobbering each other's state.
 */
import { describe, it, expect } from 'vitest';

describe('renderer highlight coexistence', () => {
  it('setHighlightedAtoms saves panel state when interaction highlight is active', async () => {
    const mod = await import('../../page/js/renderer');
    const proto = mod.Renderer.prototype;
    const fake: any = {
      _interactionHighlightIndices: [0, 1, 2],
      _panelHighlightIndices: null,
      _panelHighlightIntensity: 'selected',
      _groupHighlightIndices: [0, 1, 2],
    };

    proto.setHighlightedAtoms.call(fake, [10, 11, 12], 'selected');

    expect(fake._panelHighlightIndices).toEqual([10, 11, 12]);
    expect(fake._panelHighlightIntensity).toBe('selected');
    // Group highlight NOT overwritten (interaction is active)
    expect(fake._groupHighlightIndices).toEqual([0, 1, 2]);
  });

  it('clearInteractionHighlight restores panel highlight', async () => {
    const mod = await import('../../page/js/renderer');
    const proto = mod.Renderer.prototype;

    let restoredIndices: any = null;
    const fake: any = {
      _interactionHighlightIndices: [0, 1, 2],
      _panelHighlightIndices: [10, 11],
      _panelHighlightIntensity: 'selected',
      _groupHighlightIndices: [0, 1, 2],
      _groupHighlightIntensity: 'hover',
      _groupHighlightMat: null,
      _groupHighlightMesh: null,
      _groupHighlightCapacity: 0,
      _physicsRef: null,
      _atomGeom: null,
      _applyGroupHighlightStyle: function(i: any) { this._groupHighlightIntensity = i; },
      _updateGroupHighlight: function() { restoredIndices = this._groupHighlightIndices; },
      scene: { remove: () => {} },
    };
    fake._restorePanelHighlight = (proto as any)._restorePanelHighlight.bind(fake);
    fake.setHighlightedAtoms = proto.setHighlightedAtoms.bind(fake);

    proto.clearInteractionHighlight.call(fake);

    expect(fake._interactionHighlightIndices).toBeNull();
    expect(restoredIndices).toEqual([10, 11]);
  });

  it('review-entry cleanup: clearInteractionHighlight + setHighlight(-1) clears all live feedback', async () => {
    const mod = await import('../../page/js/renderer');
    const proto = mod.Renderer.prototype;

    const fake: any = {
      // Simulate active interaction state
      _interactionHighlightIndices: [0, 1, 2],
      _panelHighlightIndices: [10, 11],
      _panelHighlightIntensity: 'selected',
      _groupHighlightIndices: [0, 1, 2],
      _groupHighlightIntensity: 'hover',
      _groupHighlightMat: null,
      _groupHighlightMesh: null,
      _groupHighlightCapacity: 0,
      _highlightMesh: { visible: true, position: { set: () => {} }, scale: { setScalar: () => {} } },
      highlightAtom: 5,
      _physicsRef: null,
      _atomGeom: null,
      scene: { remove: () => {} },
    };
    fake._restorePanelHighlight = (proto as any)._restorePanelHighlight.bind(fake);
    fake.setHighlightedAtoms = proto.setHighlightedAtoms.bind(fake);
    fake.setHighlight = proto.setHighlight.bind(fake);
    fake._applyGroupHighlightStyle = function(i: any) { this._groupHighlightIntensity = i; };
    fake._updateGroupHighlight = function() {};

    // Simulate review-entry cleanup (matches main.ts:1134-1136)
    proto.clearInteractionHighlight.call(fake);
    proto.setHighlight.call(fake, -1);

    expect(fake._interactionHighlightIndices).toBeNull();
    expect(fake.highlightAtom).toBe(-1);
    expect(fake._highlightMesh.visible).toBe(false);
  });

  it('setHighlightedAtoms works normally when no interaction highlight', async () => {
    const mod = await import('../../page/js/renderer');
    const proto = mod.Renderer.prototype;
    const fake: any = {
      _interactionHighlightIndices: null,
      _panelHighlightIndices: null,
      _panelHighlightIntensity: 'selected',
      _groupHighlightIndices: null,
      _groupHighlightIntensity: 'selected',
      _groupHighlightMat: null,
      _groupHighlightMesh: null,
      _groupHighlightCapacity: 0,
      _physicsRef: null,
      _atomGeom: null,
      scene: { remove: () => {} },
    };

    // Should proceed normally (not early-return)
    proto.setHighlightedAtoms.call(fake, null, 'selected');
    expect(fake._panelHighlightIndices).toBeNull();
  });
});
