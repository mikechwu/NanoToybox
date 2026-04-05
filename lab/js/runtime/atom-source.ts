/**
 * Shared atom-source factory — renderer-to-input/placement atom picking adapter.
 *
 * Owns: read-only adapter surface (count, world position, raycast target).
 * Depends on: Renderer (delegates all reads).
 * Called by: input-bindings.ts, PlacementController wiring in main.ts.
 * Teardown: stateless factory — no teardown needed. Lifetime tied to Renderer.
 */

import type { Renderer } from '../renderer';

export function createAtomSource(renderer: Renderer) {
  return {
    get count() { return renderer.getAtomCount(); },
    getWorldPosition(i: number, out: import('three').Vector3) { return renderer.getAtomWorldPosition(i, out); },
    get raycastTarget() { return renderer.instancedAtoms; },
  };
}
