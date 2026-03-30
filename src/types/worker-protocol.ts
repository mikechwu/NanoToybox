/**
 * Worker protocol types for NanoToybox simulation worker.
 *
 * Defines the complete message contract between the main thread and the
 * simulation Web Worker. All types are concrete — no `any`.
 */

import type { AtomXYZ } from './domain'
import type { BondTuple } from './interfaces'

// ═══════════════════════════════════════════════════════════════════════
// Main → Worker commands
// ═══════════════════════════════════════════════════════════════════════

export interface PhysicsConfig {
  /** Timestep in femtoseconds — authoritative engine timing input. */
  dt: number
  /** Damping reference batch size — authoritative engine timing input.
   *  Used only for damping normalization, not for frame-rate control. */
  dampingReferenceSteps: number
  damping: number
  kDrag: number
  kRotate: number
  wallMode: 'contain' | 'remove'
  useWasm: boolean
}

export type WorkerCommand =
  | { type: 'init'; commandId: number; config: PhysicsConfig; atoms: AtomXYZ[]; bonds: BondTuple[] }
  | { type: 'restoreState'; commandId: number; config: PhysicsConfig;
      atoms: AtomXYZ[]; bonds: BondTuple[]; velocities: Float64Array;
      boundary: { mode: 'contain' | 'remove'; wallRadius: number; wallCenter: [number, number, number]; wallCenterSet: boolean; removedCount: number; damping: number };
    }
  | { type: 'appendMolecule'; commandId: number; atoms: AtomXYZ[]; bonds: BondTuple[]; offset: [number, number, number] }
  | { type: 'clearScene'; commandId: number }
  | { type: 'requestFrame'; commandId: number; stepsRequested: number }
  | { type: 'startDrag'; commandId: number; atomIndex: number; mode: 'atom' | 'move' | 'rotate' }
  | { type: 'updateDrag'; commandId: number; worldX: number; worldY: number; worldZ: number }
  | { type: 'endDrag'; commandId: number }
  | { type: 'applyImpulse'; commandId: number; atomIndex: number; vx: number; vy: number }
  | { type: 'flick'; commandId: number; atomIndex: number; vx: number; vy: number }
  | { type: 'setDragStrength'; commandId: number; value: number }
  | { type: 'setRotateStrength'; commandId: number; value: number }
  | { type: 'setDamping'; commandId: number; value: number }
  | { type: 'setWallMode'; commandId: number; mode: 'contain' | 'remove' }
  | { type: 'updateWallCenter'; commandId: number; atoms: AtomXYZ[]; offset: [number, number, number] }

// ═══════════════════════════════════════════════════════════════════════
// Worker → Main events
// ═══════════════════════════════════════════════════════════════════════

/** Scene-mutating acks — processed via pending-command registry. */
export type MutationAckEvent =
  | { type: 'initResult'; replyTo: number; ok: boolean; sceneVersion: number;
      atomCount: number; wasmReady: boolean; kernel: 'wasm' | 'js'; error?: string }
  | { type: 'appendResult'; replyTo: number; ok: boolean; sceneVersion: number;
      atomOffset: number; atomsAppended: number; totalAtomCount: number; error?: string }
  | { type: 'clearSceneResult'; replyTo: number; ok: boolean; sceneVersion: number; error?: string }
  | { type: 'restoreStateResult'; replyTo: number; ok: boolean; sceneVersion: number;
      atomCount: number; wasmReady: boolean; kernel: 'wasm' | 'js'; error?: string }

/** Scene-versioned non-mutating events — processed via acceptSceneVersionedEvent(). */
export type SceneVersionedEvent =
  | { type: 'frameResult'; replyTo: number; sceneVersion: number; snapshotVersion: number;
      positions: Float64Array; velocities?: Float64Array; n: number; stepsCompleted: number; physStepMs: number;
      topologyVersion?: number }
  | { type: 'frameSkipped'; replyTo: number; sceneVersion: number;
      stepsCompleted: number; physStepMs: number; reason: 'buffer_exhausted' | 'not_initialized' }
  /** C.2+ — not emitted by C.1 worker */
  | { type: 'bondUpdate'; sceneVersion: number; bonds: Int32Array; bondCount: number;
      topologyVersion?: number }
  /** C.2+ — not emitted by C.1 worker */
  | { type: 'wallRemoval'; sceneVersion: number; newN: number; removedCount: number;
      topologyVersion: number }

/** Non-versioned events — always accepted, no scene-version gating. */
export type UnversionedEvent =
  | { type: 'ready' }  // Worker script loaded and accepting commands. NOT simulation/Wasm readiness — that comes via initResult.
  /** C.2+ — not emitted by C.1 worker */
  | { type: 'diagnostics'; ke: number; stepCount: number; wallRadius: number;
      skippedFrameCount: number; emergencyAllocCount: number }

export type WorkerEvent = MutationAckEvent | SceneVersionedEvent | UnversionedEvent
