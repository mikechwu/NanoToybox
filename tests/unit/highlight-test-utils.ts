/**
 * Shared test utilities for highlight renderer tests.
 * Centralizes fake renderer construction and standard assertions
 * so highlight tests focus on behavior, not context setup.
 */
import * as THREE from 'three';

/** Build a minimal state-only fake renderer for channel-state tests.
 *  No real meshes — _physicsRef and _atomGeom are null, so _applyHighlightLayer
 *  early-returns. Good for testing state flow without mesh creation. */
export async function makeStateFake(overrides: Record<string, any> = {}) {
  const mod = await import('../../page/js/renderer');
  const proto = mod.Renderer.prototype;
  const fake: any = {
    _panelHighlightMesh: null,
    _panelHighlightMat: null,
    _panelHighlightIndices: null,
    _panelHighlightIntensity: 'selected',
    _panelHighlightCapacity: 0,
    _interactionHighlightMesh: null,
    _interactionHighlightMat: null,
    _interactionHighlightIndices: null,
    _interactionHighlightIntensity: 'hover',
    _interactionHighlightCapacity: 0,
    _physicsRef: null,
    _atomGeom: null,
    _dummyObj: {
      position: { set: () => {} },
      scale: { setScalar: () => {} },
      quaternion: { identity: () => {} },
      updateMatrix: () => {},
      matrix: {},
    },
    scene: { add: () => {}, remove: () => {} },
    ...overrides,
  };
  fake._applyHighlightLayer = (proto as any)._applyHighlightLayer.bind(fake);
  fake._updateGroupHighlight = (proto as any)._updateGroupHighlight.bind(fake);
  return { fake, proto };
}

/** Build a real-mesh renderer context with THREE geometry.
 *  Creates actual InstancedMesh objects for testing mesh behavior. */
export async function makeRealMeshCtx(atomCount = 5) {
  const { Renderer } = await import('../../page/js/renderer');
  const atomGeom = new THREE.SphereGeometry(0.35, 4, 4);
  const dummyObj = new THREE.Object3D();
  const scene = new THREE.Scene();
  const pos = new Float64Array(atomCount * 3);
  for (let i = 0; i < atomCount; i++) { pos[i * 3] = i * 2; }
  const proto = Renderer.prototype;
  const ctx: any = {
    _panelHighlightMesh: null,
    _panelHighlightMat: null,
    _panelHighlightIndices: null,
    _panelHighlightIntensity: 'selected',
    _panelHighlightCapacity: 0,
    _interactionHighlightMesh: null,
    _interactionHighlightMat: null,
    _interactionHighlightIndices: null,
    _interactionHighlightIntensity: 'hover',
    _interactionHighlightCapacity: 0,
    _physicsRef: { pos, n: atomCount },
    _atomGeom: atomGeom,
    _dummyObj: dummyObj,
    scene,
  };
  ctx._applyHighlightLayer = (proto as any)._applyHighlightLayer.bind(ctx);
  ctx._updateGroupHighlight = (proto as any)._updateGroupHighlight.bind(ctx);
  ctx._disposeHighlightLayers = (proto as any)._disposeHighlightLayers.bind(ctx);
  ctx.setHighlightedAtoms = proto.setHighlightedAtoms.bind(ctx);
  ctx.setInteractionHighlightedAtoms = proto.setInteractionHighlightedAtoms.bind(ctx);
  ctx.clearInteractionHighlight = proto.clearInteractionHighlight.bind(ctx);
  return { ctx, atomGeom, pos };
}
