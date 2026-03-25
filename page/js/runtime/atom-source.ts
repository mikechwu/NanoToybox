/**
 * Shared atom-source factory — single source of truth for the
 * renderer-to-input/placement atom picking adapter.
 *
 * Used by input-bindings.ts and PlacementController wiring in main.ts.
 */

import type { Renderer } from '../renderer';

export function createAtomSource(renderer: Renderer) {
  return {
    get count() { return renderer.getAtomCount(); },
    getWorldPosition(i: number, out: import('three').Vector3) { return renderer.getAtomWorldPosition(i, out); },
    get raycastTarget() { return renderer.instancedAtoms; },
  };
}
