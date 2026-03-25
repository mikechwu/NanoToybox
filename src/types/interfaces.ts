/**
 * Module boundary interfaces for NanoToybox.
 * These define the contracts between subsystems — Milestone C's worker bridge
 * must satisfy IPhysicsEngine, and the renderer adapter must satisfy IRenderer.
 */

import type { AtomXYZ, CameraState } from './domain'

// Re-export domain types for convenience
export type { AtomXYZ, Bond, CameraState } from './domain'

/** Runtime bond representation: [atomIndex_i, atomIndex_j, distance]. */
export type BondTuple = [number, number, number]

/** Physics checkpoint for transaction rollback. */
export interface PhysicsCheckpoint {
  n: number
  pos: Float64Array
  vel: Float64Array
  bonds: BondTuple[]
}

/** Physics engine contract — implemented by PhysicsEngine, consumed by scene/placement/interaction. */
export interface IPhysicsEngine {
  // Core state
  readonly n: number

  // Simulation
  stepOnce(): void

  // Scene mutation
  appendMolecule(atoms: AtomXYZ[], bonds: BondTuple[], offset: number[]): { atomCount: number; atomOffset: number }
  clearScene(): void

  // Checkpoint/restore for rollback
  createCheckpoint(): PhysicsCheckpoint
  restoreCheckpoint(cp: PhysicsCheckpoint): void

  // Forces and interaction
  computeForces(): void
  updateBondList(): void
  rebuildComponents(): void
  updateWallCenter(atoms: AtomXYZ[], offset: number[]): void
  updateWallRadius(): void

  // Debug
  assertPostAppendInvariants(): void

  // Drag/interaction settings
  setDragStrength(val: number): void
  setRotateStrength(val: number): void
  setDamping(val: number): void
  setWallMode(mode: 'contain' | 'remove'): void
}

/** Renderer contract — implemented by Renderer, consumed by scene/placement/main. */
export interface IRenderer {
  // Rendering
  render(): void

  // Scene mutation (split per B.5)
  ensureCapacityForAppend(newAtomCount: number): void
  populateAppendedAtoms(atoms: AtomXYZ[], offsetStart: number): void
  clearAllMeshes(): void
  clearFeedback(): void

  // Snapshot-driven rendering (primary path in Milestone C)
  updateFromSnapshot(positions: Float64Array, n: number, bonds: Int32Array | null, bondCount: number): void

  // Camera
  getCameraState(): CameraState
  resetCamera(): void
  getCanvas(): HTMLCanvasElement | null

  // Theme
  setTheme(theme: 'dark' | 'light'): void

  // Capacity info
  getCapacityInfo(): { atomCount: number; atomCapacity: number; bondActive: number; bondCapacity: number }
}
