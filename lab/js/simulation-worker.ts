/**
 * NanoToybox simulation worker — runs PhysicsEngine off the main thread.
 *
 * Invariants:
 * 1. Mutation commands (init, restoreState, appendMolecule, clearScene) always produce an ack.
 * 2. requestFrame always produces exactly one completion (frameResult or frameSkipped).
 * 3. Init/restoreState are transactional — commands queue during setup.
 * 4. Commands sent when uninitialized get typed error responses.
 * 5. Failed init discards queued commands with error acks.
 */
/// <reference lib="webworker" />
declare const self: DedicatedWorkerGlobalScope;

import { PhysicsEngine } from './physics';
import type {
  WorkerCommand,
  WorkerEvent,
  PhysicsConfig,
} from '../../src/types/worker-protocol';
import type { AtomXYZ } from '../../src/types/domain';
import type { BondTuple } from '../../src/types/interfaces';

// ─── Global state ──────────────────────────────────────────────────────────
let engine: PhysicsEngine | null = null;
let sceneVersion = 0;
let snapshotVersion = 0;

// Init transaction tracking
let initInFlight = false;
let initEpoch = 0;
let currentInitQueue: WorkerCommand[] = [];

// ─── Emit helpers ──────────────────────────────────────────────────────────
function emit(event: WorkerEvent): void { self.postMessage(event); }
function emitNotReady(cmd: WorkerCommand, reason: string): void {
  if ('commandId' in cmd) {
    if (cmd.type === 'init') {
      emit({ type: 'initResult', replyTo: cmd.commandId, ok: false, sceneVersion, atomCount: 0, wasmReady: false, kernel: 'js', error: reason });
    } else if (cmd.type === 'restoreState') {
      emit({ type: 'restoreStateResult', replyTo: cmd.commandId, ok: false, sceneVersion, atomCount: 0, wasmReady: false, kernel: 'js', error: reason });
    } else if (cmd.type === 'appendMolecule') {
      emit({ type: 'appendResult', replyTo: cmd.commandId, ok: false, sceneVersion, atomOffset: 0, atomsAppended: 0, totalAtomCount: 0, error: reason });
    } else if (cmd.type === 'requestFrame') {
      emit({ type: 'frameSkipped', replyTo: cmd.commandId, sceneVersion, stepsCompleted: 0, physStepMs: 0, reason: 'not_initialized' });
    } else if (cmd.type === 'clearScene') {
      emit({ type: 'clearSceneResult', replyTo: cmd.commandId, ok: false, sceneVersion, error: reason });
    }
  }
}

// ─── Shared worker transaction helper ──────────────────────────────────────
// Factors the common pattern: build candidate → apply state → init wasm →
// commit or fail. Used by both handleInit and handleRestoreState.

type AckType = 'initResult' | 'restoreStateResult';

function operationName(ackType: AckType): string {
  return ackType === 'initResult' ? 'Init' : 'Restore state';
}

async function workerTransaction(
  commandId: number,
  config: PhysicsConfig,
  ackType: AckType,
  applyState: (candidate: PhysicsEngine) => void,
): Promise<void> {
  initInFlight = true;
  const thisEpoch = ++initEpoch;
  currentInitQueue = [];

  try {
    const candidate = new PhysicsEngine({ skipWasmInit: true });

    // Apply timing config so engine uses protocol dt/dampingReferenceSteps, not defaults.
    candidate.setTimeConfig(config.dt, config.dampingReferenceSteps);
    // Apply shared config FIRST so caller-specific state (e.g. restoreBoundarySnapshot)
    // can override wallMode and damping if it has authoritative values.
    candidate.setDamping(config.damping);
    candidate.setDragStrength(config.kDrag);
    candidate.setRotateStrength(config.kRotate);
    candidate.setWallMode(config.wallMode);

    // Apply caller-specific state (may override config values with authoritative state)
    applyState(candidate);

    // Wasm
    let wasmReady = false;
    if (config.useWasm) {
      const { initWasm, isReady } = await import('./tersoff-wasm');
      await initWasm();
      wasmReady = isReady();
      candidate.setWasmReady(wasmReady);
    } else {
      candidate.setWasmReady(false);
    }

    if (thisEpoch !== initEpoch) return; // superseded

    // Commit
    engine = candidate;
    sceneVersion += 1;
    snapshotVersion = 0;

    emit({
      type: ackType,
      replyTo: commandId,
      ok: true,
      sceneVersion,
      atomCount: engine.n,
      wasmReady,
      kernel: engine.getActiveKernel(),
    });

    initInFlight = false;
    const queue = currentInitQueue;
    currentInitQueue = [];
    for (const qcmd of queue) dispatch(qcmd);
  } catch (err) {
    if (thisEpoch !== initEpoch) return;
    emit({
      type: ackType,
      replyTo: commandId,
      ok: false,
      sceneVersion,
      atomCount: 0,
      wasmReady: false,
      kernel: 'js',
      error: String(err),
    });
    initInFlight = false;
    const failedQueue = currentInitQueue;
    currentInitQueue = [];
    for (const qcmd of failedQueue) emitNotReady(qcmd, `${operationName(ackType)} failed`);
  }
}

// ─── Init (fresh scene) ────────────────────────────────────────────────────
async function handleInit(cmd: Extract<WorkerCommand, { type: 'init' }>): Promise<void> {
  await workerTransaction(cmd.commandId, cmd.config, 'initResult', (candidate) => {
    candidate.init(cmd.atoms, cmd.bonds);
    if (cmd.atoms.length > 0) {
      candidate.updateWallCenter(cmd.atoms, [0, 0, 0]);
      candidate.updateWallRadius();
    }
  });
}

// ─── Restore state (restart from timeline) ─────────────────────────────────
async function handleRestoreState(cmd: Extract<WorkerCommand, { type: 'restoreState' }>): Promise<void> {
  await workerTransaction(cmd.commandId, cmd.config, 'restoreStateResult', (candidate) => {
    candidate.init(cmd.atoms, cmd.bonds);
    // Overlay restart-grade dynamic state
    const copyLen = Math.min(cmd.velocities.length, candidate.vel.length);
    candidate.vel.set(cmd.velocities.subarray(0, copyLen));
    candidate.restoreBoundarySnapshot(cmd.boundary);
    // Do NOT restore interaction state — that creates phantom spring forces
    // without a matching user pointer input. The user's current pointer
    // state drives interaction after restart.
  });
}

// ─── Append molecule ───────────────────────────────────────────────────────
function handleAppendMolecule(cmd: Extract<WorkerCommand, { type: 'appendMolecule' }>): void {
  if (!engine) { emitNotReady(cmd, 'Engine not initialized'); return; }
  try {
    const result = engine.appendMolecule(cmd.atoms, cmd.bonds, cmd.offset);
    engine.updateWallCenter(cmd.atoms, cmd.offset);
    engine.updateWallRadius();
    sceneVersion += 1;
    emit({
      type: 'appendResult',
      replyTo: cmd.commandId,
      ok: true,
      sceneVersion,
      atomOffset: result.atomOffset,
      atomsAppended: result.atomCount,
      totalAtomCount: engine.n,
    });
  } catch (err) {
    emit({
      type: 'appendResult',
      replyTo: cmd.commandId,
      ok: false,
      sceneVersion,
      atomOffset: 0,
      atomsAppended: 0,
      totalAtomCount: engine.n,
      error: String(err),
    });
  }
}

// ─── Clear scene ───────────────────────────────────────────────────────────
function handleClearScene(cmd: Extract<WorkerCommand, { type: 'clearScene' }>): void {
  if (!engine) { emitNotReady(cmd, 'Engine not initialized'); return; }
  engine.clearScene();
  sceneVersion += 1;
  snapshotVersion = 0;
  emit({
    type: 'clearSceneResult',
    replyTo: cmd.commandId,
    ok: true,
    sceneVersion,
  });
}

// ─── Request frame ─────────────────────────────────────────────────────────
function handleRequestFrame(cmd: Extract<WorkerCommand, { type: 'requestFrame' }>): void {
  if (!engine) {
    emit({ type: 'frameSkipped', replyTo: cmd.commandId, sceneVersion, stepsCompleted: 0, physStepMs: 0, reason: 'not_initialized' });
    return;
  }

  const t0 = performance.now();
  const steps = cmd.stepsRequested;
  if (engine.n > 0) {
    for (let s = 0; s < steps; s++) engine.stepOnce();
    engine.applySafetyControls();
  }
  const physStepMs = performance.now() - t0;

  snapshotVersion++;
  const positions = new Float64Array(engine.pos.subarray(0, engine.n * 3));
  const velocities = new Float64Array(engine.vel.subarray(0, engine.n * 3));

  emit({
    type: 'frameResult',
    replyTo: cmd.commandId,
    sceneVersion,
    snapshotVersion,
    positions,
    velocities,
    n: engine.n,
    stepsCompleted: steps,
    physStepMs,
  });
}

// ─── Interaction commands ──────────────────────────────────────────────────
function handleStartDrag(cmd: Extract<WorkerCommand, { type: 'startDrag' }>): void {
  if (!engine) return;
  if (cmd.mode === 'atom') engine.startDrag(cmd.atomIndex);
  else if (cmd.mode === 'move') engine.startTranslate(cmd.atomIndex);
  else if (cmd.mode === 'rotate') engine.startRotateDrag(cmd.atomIndex);
}

function handleUpdateDrag(cmd: Extract<WorkerCommand, { type: 'updateDrag' }>): void {
  if (!engine) return;
  engine.updateDrag(cmd.worldX, cmd.worldY, cmd.worldZ);
}

function handleEndDrag(_cmd: Extract<WorkerCommand, { type: 'endDrag' }>): void {
  if (!engine) return;
  engine.endDrag();
}

function handleApplyImpulse(cmd: Extract<WorkerCommand, { type: 'applyImpulse' }>): void {
  if (!engine) return;
  engine.applyImpulse(cmd.atomIndex, cmd.vx, cmd.vy);
}

function handleFlick(cmd: Extract<WorkerCommand, { type: 'flick' }>): void {
  if (!engine) return;
  engine.endDrag();
  engine.applyImpulse(cmd.atomIndex, cmd.vx, cmd.vy);
}

// ─── Settings commands ─────────────────────────────────────────────────────
function handleSetDragStrength(cmd: Extract<WorkerCommand, { type: 'setDragStrength' }>): void { if (engine) engine.setDragStrength(cmd.value); }
function handleSetRotateStrength(cmd: Extract<WorkerCommand, { type: 'setRotateStrength' }>): void { if (engine) engine.setRotateStrength(cmd.value); }
function handleSetDamping(cmd: Extract<WorkerCommand, { type: 'setDamping' }>): void { if (engine) engine.setDamping(cmd.value); }
function handleSetWallMode(cmd: Extract<WorkerCommand, { type: 'setWallMode' }>): void { if (engine) engine.setWallMode(cmd.mode); }
function handleUpdateWallCenter(cmd: Extract<WorkerCommand, { type: 'updateWallCenter' }>): void {
  if (engine) {
    engine.updateWallCenter(cmd.atoms, cmd.offset);
    engine.updateWallRadius();
  }
}

// ─── Centralized dispatcher ────────────────────────────────────────────────
function dispatch(cmd: WorkerCommand): void {
  switch (cmd.type) {
    case 'init':              handleInit(cmd); break;
    case 'restoreState':      handleRestoreState(cmd); break;
    case 'appendMolecule':    handleAppendMolecule(cmd); break;
    case 'clearScene':        handleClearScene(cmd); break;
    case 'requestFrame':      handleRequestFrame(cmd); break;
    case 'startDrag':         handleStartDrag(cmd); break;
    case 'updateDrag':        handleUpdateDrag(cmd); break;
    case 'endDrag':           handleEndDrag(cmd); break;
    case 'applyImpulse':      handleApplyImpulse(cmd); break;
    case 'flick':             handleFlick(cmd); break;
    case 'setDragStrength':   handleSetDragStrength(cmd); break;
    case 'setRotateStrength': handleSetRotateStrength(cmd); break;
    case 'setDamping':        handleSetDamping(cmd); break;
    case 'setWallMode':       handleSetWallMode(cmd); break;
    case 'updateWallCenter':  handleUpdateWallCenter(cmd); break;
  }
}

self.onmessage = (e: MessageEvent<WorkerCommand>): void => {
  const cmd = e.data;
  if (initInFlight) {
    currentInitQueue.push(cmd);
    return;
  }
  dispatch(cmd);
};

emit({ type: 'ready' });
