/**
 * Canonical domain types for NanoToybox.
 *
 * Referenced from .js files via JSDoc:
 *   /** @typedef {import('../../src/types/domain').AtomXYZ} AtomXYZ *​/
 */

/** A single atom with 3D coordinates. */
export interface AtomXYZ {
  x: number
  y: number
  z: number
}

/** A bond between two atoms, identified by index. */
export interface Bond {
  i: number
  j: number
}

/** A loaded structure: atoms and their bond topology. */
export interface Structure {
  atoms: AtomXYZ[]
  bonds: Bond[]
}

/** Manifest entry for a structure in the library. */
export interface ManifestEntry {
  filename: string
  key: string
  label: string
  atomCount: number
  energy?: number
  fmax?: number
  method?: string
}

/** Camera state snapshot for placement/interaction. */
export interface CameraState {
  position: [number, number, number]
  direction: [number, number, number]
  up: [number, number, number]
}
