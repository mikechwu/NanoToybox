/**
 * WorkerBridge — main-thread orchestrator for the simulation Web Worker.
 *
 * Manages worker lifecycle, implements the pending-command registry for
 * mutation acks, and provides mutation-aware gating for scene-versioned
 * events.  All public methods are fully typed (no `any`).
 *
 * Milestone C.2
 */

import type {
  PhysicsConfig,
  WorkerCommand,
  WorkerEvent,
  MutationAckEvent,
  SceneVersionedEvent,
  UnversionedEvent,
} from '../../src/types/worker-protocol';
import type { AtomXYZ } from '../../src/types/domain';
import type { BondTuple } from '../../src/types/interfaces';

/** Fire-and-forget interaction/settings command union. */
export type WorkerInteractionCommand =
  | { type: 'startDrag'; atomIndex: number; mode: 'atom' | 'move' | 'rotate' }
  | { type: 'updateDrag'; worldX: number; worldY: number; worldZ: number }
  | { type: 'endDrag' }
  | { type: 'applyImpulse'; atomIndex: number; vx: number; vy: number }
  | { type: 'flick'; atomIndex: number; vx: number; vy: number }
  | { type: 'setDragStrength'; value: number }
  | { type: 'setRotateStrength'; value: number }
  | { type: 'setDamping'; value: number }
  | { type: 'setWallMode'; mode: 'contain' | 'remove' }
  | { type: 'updateWallCenter'; atoms: AtomXYZ[]; offset: [number, number, number] };

// ─── Snapshot type ──────────────────────────────────────────────────────────

export interface FrameSnapshot {
  positions: Float64Array;
  velocities?: Float64Array;
  n: number;
  sceneVersion: number;
  snapshotVersion: number;
  stepsCompleted: number;
  physStepMs: number;
}

/** Completion metadata for frameSkipped (no positions). */
export interface FrameSkipInfo {
  sceneVersion: number;
  stepsCompleted: number;
  physStepMs: number;
  reason: string;
}

// ─── Extract result types from MutationAckEvent ─────────────────────────────

type InitResult = Extract<MutationAckEvent, { type: 'initResult' }>;
type AppendResult = Extract<MutationAckEvent, { type: 'appendResult' }>;
type ClearSceneResult = Extract<MutationAckEvent, { type: 'clearSceneResult' }>;

// ─── Pending mutation record ────────────────────────────────────────────────

interface PendingMutation {
  commandId: number;
  type: string;
}

// ═════════════════════════════════════════════════════════════════════════════

export type WorkerState = 'loading' | 'ready' | 'running' | 'crashed';

export class WorkerBridge {
  private worker: Worker;
  private nextCommandId = 0;

  // Scene version tracking
  private lastKnownSceneVersion = 0;
  private lastAcceptedMutationVersion = 0;
  private hasPendingMutations = false;

  // Pending-command registry
  private pendingMutations: Map<number, PendingMutation> = new Map();

  // Outstanding request tracking
  private outstandingRequestIds: Set<number> = new Set();
  private frameRequestGeneration = 0;
  private requestGenByCommandId: Map<number, number> = new Map();
  private requestSendTs: Map<number, number> = new Map(); // commandId → send timestamp

  // Snapshot timing
  private lastSnapshotTs = 0;
  private _roundTripMs = 0; // EMA of request → response latency

  // Latest snapshot
  private latestSnapshot: FrameSnapshot | null = null;

  // Callbacks
  private onFrameResult: ((snapshot: FrameSnapshot) => void) | null = null;
  private onMutationAck: ((event: MutationAckEvent) => void) | null = null;
  private onReady: (() => void) | null = null;
  private onFrameSkipped: ((info: FrameSkipInfo) => void) | null = null;
  private onCrash: ((reason: string) => void) | null = null;

  // Worker state
  private workerState: WorkerState = 'loading';

  // Promise resolvers for mutation commands
  private pendingResolvers: Map<number, (value: MutationAckEvent) => void> = new Map();

  // ─── Constructor ────────────────────────────────────────────────────────

  constructor() {
    this.worker = new Worker(
      new URL('./simulation-worker', import.meta.url),
      { type: 'module' },
    );
    this.worker.onmessage = (e: MessageEvent<WorkerEvent>) => {
      this._handleMessage(e.data);
    };
    this.worker.onerror = (e) => {
      this._handleCrash(`Worker error: ${e.message || 'unknown'}`);
    };
  }

  // ─── Public API ─────────────────────────────────────────────────────────

  /** Send init command; resolves when the worker replies with initResult. */
  async init(
    config: PhysicsConfig,
    atoms: AtomXYZ[],
    bonds: BondTuple[],
  ): Promise<InitResult> {
    const commandId = this._nextId();
    this._registerMutation(commandId, 'init');

    const promise = new Promise<InitResult>((resolve) => {
      this.pendingResolvers.set(commandId, resolve as (v: MutationAckEvent) => void);
    });

    this._post({
      type: 'init',
      commandId,
      config,
      atoms,
      bonds,
    });

    const result = await promise;
    if (result.ok) {
      this.workerState = 'running';
    }
    return result;
  }

  /** Check if a new requestFrame can be sent (bounded outstanding requests). */
  canSendRequest(): boolean {
    return this.workerState === 'running' && this.outstandingRequestIds.size < 1;
  }

  /** Request a simulation frame from the worker. Caller should check canSendRequest() first. */
  sendRequestFrame(stepsRequested: number): void {
    const commandId = this._nextId();
    this.outstandingRequestIds.add(commandId);
    this.requestGenByCommandId.set(commandId, this.frameRequestGeneration);
    this.requestSendTs.set(commandId, performance.now());

    this._post({
      type: 'requestFrame',
      commandId,
      stepsRequested,
    });
  }

  /** Append a molecule to the running scene. Resolves with the ack. */
  async appendMolecule(
    atoms: AtomXYZ[],
    bonds: BondTuple[],
    offset: [number, number, number],
  ): Promise<AppendResult> {
    const commandId = this._nextId();
    this._registerMutation(commandId, 'appendMolecule');

    // Clear stale snapshot immediately — prevents pre-append frames from
    // rolling back the local renderer atom count before the worker acks.
    this.latestSnapshot = null;

    const promise = new Promise<AppendResult>((resolve) => {
      this.pendingResolvers.set(commandId, resolve as (v: MutationAckEvent) => void);
    });

    this._post({
      type: 'appendMolecule',
      commandId,
      atoms,
      bonds,
      offset,
    });

    return promise;
  }

  /** Clear the scene. Resolves with the ack. */
  async clearScene(): Promise<ClearSceneResult> {
    const commandId = this._nextId();
    this._registerMutation(commandId, 'clearScene');

    const promise = new Promise<ClearSceneResult>((resolve) => {
      this.pendingResolvers.set(commandId, resolve as (v: MutationAckEvent) => void);
    });

    this._post({
      type: 'clearScene',
      commandId,
    });

    return promise;
  }

  /** Fire-and-forget interaction/settings command. */
  sendInteraction(cmd: WorkerInteractionCommand): void {
    const commandId = this._nextId();
    // Build the full WorkerCommand by spreading cmd with commandId
    this._post({ ...cmd, commandId } as WorkerCommand);
  }

  /** Return the latest accepted snapshot, or null if none yet. */
  getLatestSnapshot(): FrameSnapshot | null {
    return this.latestSnapshot;
  }

  /** Bump generation counter — invalidates all outstanding frame requests and clears snapshot. */
  bumpGeneration(): void {
    this.frameRequestGeneration++;
    this.outstandingRequestIds.clear();
    this.requestGenByCommandId.clear();
    this.requestSendTs.clear();
    this.latestSnapshot = null; // plan requires snapshot reset on clear-scene
  }

  /** Terminate the worker and clear all state. */
  destroy(): void {
    this.worker.terminate();
    this.workerState = 'crashed';
    this.pendingMutations.clear();
    this.outstandingRequestIds.clear();
    this.requestGenByCommandId.clear();
    this.pendingResolvers.clear();
    this.latestSnapshot = null;
    this.onFrameResult = null;
    this.onMutationAck = null;
    this.onReady = null;
  }

  // ─── Callback setters ──────────────────────────────────────────────────

  setOnFrameResult(cb: ((snapshot: FrameSnapshot) => void) | null): void {
    this.onFrameResult = cb;
  }

  setOnMutationAck(cb: ((event: MutationAckEvent) => void) | null): void {
    this.onMutationAck = cb;
  }

  setOnReady(cb: (() => void) | null): void {
    this.onReady = cb;
  }

  setOnFrameSkipped(cb: ((info: FrameSkipInfo) => void) | null): void {
    this.onFrameSkipped = cb;
  }

  setOnCrash(cb: ((reason: string) => void) | null): void {
    this.onCrash = cb;
  }

  getWorkerState(): WorkerState {
    return this.workerState;
  }

  /** Number of outstanding (in-flight) requestFrame commands. */
  getOutstandingRequestCount(): number {
    return this.outstandingRequestIds.size;
  }

  /** EMA of request → response round-trip latency in ms. */
  getRoundTripMs(): number {
    return this._roundTripMs;
  }

  /** Time in ms since the last snapshot was received. */
  getSnapshotAge(): number {
    return this.lastSnapshotTs > 0 ? performance.now() - this.lastSnapshotTs : Infinity;
  }

  // ─── Private: message dispatch ─────────────────────────────────────────

  private _handleMessage(event: WorkerEvent): void {
    switch (event.type) {
      // Mutation acks
      case 'initResult':
      case 'appendResult':
      case 'clearSceneResult':
        this._acceptMutationAck(event);
        break;

      // Scene-versioned events
      case 'frameResult':
      case 'frameSkipped':
      case 'bondUpdate':
      case 'wallRemoval':
        this._acceptSceneVersionedEvent(event);
        break;

      // Unversioned events
      case 'ready':
        this._handleReady(event);
        break;
      case 'diagnostics':
        // C.2+ — ignored for now
        break;
    }
  }

  private _handleReady(_event: Extract<UnversionedEvent, { type: 'ready' }>): void {
    if (this.workerState === 'loading') {
      this.workerState = 'ready';
    }
    if (this.onReady) {
      this.onReady();
    }
  }

  // ─── Private: crash handling ───────────────────────────────────────────

  private _handleCrash(reason: string): void {
    if (this.workerState === 'crashed') return; // already crashed
    this.workerState = 'crashed';

    // Reject all pending mutation promises with fully valid typed events
    for (const [id, resolver] of this.pendingResolvers) {
      const pending = this.pendingMutations.get(id);
      if (!pending) continue;

      let failedAck: MutationAckEvent;
      switch (pending.type) {
        case 'init':
          failedAck = { type: 'initResult', replyTo: id, ok: false, sceneVersion: this.lastKnownSceneVersion, atomCount: 0, wasmReady: false, kernel: 'js', error: reason };
          break;
        case 'appendMolecule':
          failedAck = { type: 'appendResult', replyTo: id, ok: false, sceneVersion: this.lastKnownSceneVersion, atomOffset: 0, atomsAppended: 0, totalAtomCount: 0, error: reason };
          break;
        default:
          failedAck = { type: 'clearSceneResult', replyTo: id, ok: false, sceneVersion: this.lastKnownSceneVersion, error: reason };
          break;
      }
      resolver(failedAck);
    }

    // Clear all tracking state
    this.pendingMutations.clear();
    this.pendingResolvers.clear();
    this.outstandingRequestIds.clear();
    this.requestGenByCommandId.clear();
    this.hasPendingMutations = false;
    this.latestSnapshot = null;

    // Notify main
    if (this.onCrash) this.onCrash(reason);
  }

  // ─── Private: mutation ack processing ──────────────────────────────────
  //
  // Accept rules:
  //  1. The commandId must be in the pending registry.
  //  2. Update sceneVersion tracking if the ack advances it.
  // All valid acks are resolved — no silent promise drops.

  private _acceptMutationAck(event: MutationAckEvent): void {
    const commandId = event.replyTo;
    const pending = this.pendingMutations.get(commandId);

    // Must be in the pending registry
    if (!pending) return;

    // Update sceneVersion tracking
    if (event.sceneVersion >= this.lastKnownSceneVersion) {
      this.lastKnownSceneVersion = event.sceneVersion;
      if (event.ok) {
        this.lastAcceptedMutationVersion = event.sceneVersion;
      }
    }

    // Remove from registry
    this.pendingMutations.delete(commandId);
    this._updateHasPendingMutations();

    // Always resolve the promise — never drop it
    const resolver = this.pendingResolvers.get(commandId);
    if (resolver) {
      this.pendingResolvers.delete(commandId);
      resolver(event);
    }

    // Notify callback
    if (this.onMutationAck) {
      this.onMutationAck(event);
    }
  }

  // ─── Private: scene-versioned event gating ─────────────────────────────

  private _acceptSceneVersionedEvent(event: SceneVersionedEvent): void {
    // Reject events older than last accepted mutation
    if (event.sceneVersion < this.lastAcceptedMutationVersion) {
      return; // stale — produced before latest acknowledged mutation
    }

    // If mutations are pending, reject ALL scene-versioned events.
    // This is an intentionally coarse gate that pauses worker frame consumption
    // during the entire mutation window. Pre-append snapshots would roll back
    // local renderer atom count; post-append snapshots belong to an unacknowledged
    // scene version. Resume consuming only after the mutation ack advances
    // lastAcceptedMutationVersion.
    //
    // This is safe because mutations are short (typically <50ms). A future
    // refinement could narrow this to reject only specific event types per
    // mutation kind, but the coarse gate is correct and simple.
    if (this.hasPendingMutations) {
      return;
    }

    // Check generation for frame-related events
    if ('replyTo' in event && this._isRequestStale(event.replyTo)) {
      return;
    }

    // Clean up outstanding tracking and compute round-trip for replied commands
    if ('replyTo' in event) {
      this.outstandingRequestIds.delete(event.replyTo);
      this.requestGenByCommandId.delete(event.replyTo);

      // Compute round-trip latency
      const sendTs = this.requestSendTs.get(event.replyTo);
      if (sendTs !== undefined) {
        const rtt = performance.now() - sendTs;
        const alpha = 0.2; // EMA smoothing
        this._roundTripMs = this._roundTripMs === 0 ? rtt : this._roundTripMs + alpha * (rtt - this._roundTripMs);
        this.requestSendTs.delete(event.replyTo);
      }
    }

    // Update lastKnownSceneVersion
    if (event.sceneVersion > this.lastKnownSceneVersion) {
      this.lastKnownSceneVersion = event.sceneVersion;
    }

    switch (event.type) {
      case 'frameResult': {
        const snapshot: FrameSnapshot = {
          positions: event.positions,
          velocities: event.velocities,
          n: event.n,
          sceneVersion: event.sceneVersion,
          snapshotVersion: event.snapshotVersion,
          stepsCompleted: event.stepsCompleted,
          physStepMs: event.physStepMs,
        };
        this.latestSnapshot = snapshot;
        this.lastSnapshotTs = performance.now();
        if (this.onFrameResult) {
          this.onFrameResult(snapshot);
        }
        break;
      }
      case 'frameSkipped': {
        // No snapshot update, but propagate timing for scheduler
        if (this.onFrameSkipped) {
          this.onFrameSkipped({
            sceneVersion: event.sceneVersion,
            stepsCompleted: event.stepsCompleted,
            physStepMs: event.physStepMs,
            reason: event.reason,
          });
        }
        break;
      }
      case 'bondUpdate':
        // C.2+ — pass through when handler exists
        break;
      case 'wallRemoval':
        // C.2+ — pass through when handler exists
        break;
    }
  }

  // ─── Private: generation staleness check ──────────────────────────────

  private _isRequestStale(replyTo: number): boolean {
    const gen = this.requestGenByCommandId.get(replyTo);
    if (gen === undefined) {
      // Not in the generation map. Two cases:
      // 1. Mutation command (never tracked in genMap) — not stale
      // 2. Pre-bumpGeneration frame request (cleared by bump) — stale
      // Distinguish by checking if it's a known outstanding request.
      // If it's not outstanding AND not in genMap, it predates the current generation.
      return !this.outstandingRequestIds.has(replyTo) && !this.pendingMutations.has(replyTo);
    }
    return gen < this.frameRequestGeneration;
  }

  // ─── Private: helpers ─────────────────────────────────────────────────

  private _nextId(): number {
    return this.nextCommandId++;
  }

  private _post(cmd: WorkerCommand): void {
    this.worker.postMessage(cmd);
  }

  private _registerMutation(commandId: number, type: string): void {
    this.pendingMutations.set(commandId, { commandId, type });
    this.hasPendingMutations = true;
  }

  private _updateHasPendingMutations(): void {
    this.hasPendingMutations = this.pendingMutations.size > 0;
  }
}
