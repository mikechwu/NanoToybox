/**
 * NanoToybox simulation Web Worker (Milestone C.1).
 *
 * Runs PhysicsEngine on a dedicated thread, communicating with the main
 * thread via the WorkerCommand / WorkerEvent protocol.
 *
 * Protocol guarantees:
 * - Mutation commands (init, appendMolecule, clearScene) always produce an ack
 * - requestFrame always produces exactly one completion (frameResult or frameSkipped)
 * - Init is transactional and serialized: all commands are queued during init
 * - Commands sent when uninitialized get typed error responses (no silent drops)
 * - Failed init discards its queued commands with error acks (no stale-scene drain)
 */

import { PhysicsEngine } from './physics';
import type {
  WorkerCommand,
  WorkerEvent,
} from '../../src/types/worker-protocol';

// ─── Worker state ───────────────────────────────────────────────────────────

let engine: PhysicsEngine | null = null;
let sceneVersion = 0;
let snapshotVersion = 0;
let initInFlight = false;
let initEpoch = 0;          // incremented per init attempt
let currentInitQueue: WorkerCommand[] = [];

// ─── Emit helper ────────────────────────────────────────────────────────────

function emit(event: WorkerEvent): void {
  self.postMessage(event);
}

// ─── Error responses for commands when engine is not ready ──────────────────

function emitNotReady(cmd: WorkerCommand, reason: string): void {
  switch (cmd.type) {
    case 'init':
      emit({ type: 'initResult', replyTo: cmd.commandId, ok: false, sceneVersion, atomCount: 0, wasmReady: false, kernel: 'js', error: reason });
      break;
    case 'appendMolecule':
      emit({ type: 'appendResult', replyTo: cmd.commandId, ok: false, sceneVersion, atomOffset: 0, atomsAppended: 0, totalAtomCount: engine ? engine.n : 0, error: reason });
      break;
    case 'clearScene':
      emit({ type: 'clearSceneResult', replyTo: cmd.commandId, ok: false, sceneVersion, error: reason });
      break;
    case 'requestFrame':
      // Use frameSkipped with reason to distinguish from valid empty scene
      emit({ type: 'frameSkipped', replyTo: cmd.commandId, sceneVersion, stepsCompleted: 0, physStepMs: 0, reason: 'not_initialized' });
      break;
    // Interactive/settings commands are fire-and-forget — no ack required
    default:
      break;
  }
}

// ─── Command handlers ───────────────────────────────────────────────────────

async function handleInit(cmd: Extract<WorkerCommand, { type: 'init' }>): Promise<void> {
  initInFlight = true;
  const thisEpoch = ++initEpoch;
  currentInitQueue = [];

  try {
    // Build candidate engine without assigning to global (transactional)
    const candidate = new PhysicsEngine({ skipWasmInit: true });
    candidate.init(cmd.atoms, cmd.bonds);

    // Apply config
    candidate.setDamping(cmd.config.damping);
    candidate.setDragStrength(cmd.config.kDrag);
    candidate.setRotateStrength(cmd.config.kRotate);
    candidate.setWallMode(cmd.config.wallMode);

    // Initialize wall from current atoms (wall needs center + radius to function)
    if (cmd.atoms.length > 0) {
      candidate.updateWallCenter(cmd.atoms, [0, 0, 0]);
      candidate.updateWallRadius();
    }

    // Wasm: explicit, worker-authoritative
    let wasmReady = false;
    if (cmd.config.useWasm) {
      const { initWasm, isReady } = await import('./tersoff-wasm');
      await initWasm();
      wasmReady = isReady();
      candidate.setWasmReady(wasmReady);
    } else {
      candidate.setWasmReady(false);
    }

    // Check if this init was superseded by a newer one
    if (thisEpoch !== initEpoch) return; // a newer init took over

    // Commit
    engine = candidate;
    sceneVersion += 1;
    snapshotVersion = 0;

    emit({
      type: 'initResult',
      replyTo: cmd.commandId,
      ok: true,
      sceneVersion,
      atomCount: engine.n,
      wasmReady,
      kernel: engine.getActiveKernel(),
    });

    // Drain queued commands from THIS init epoch
    initInFlight = false;
    const queue = currentInitQueue;
    currentInitQueue = [];
    for (const qcmd of queue) {
      dispatch(qcmd);
    }
  } catch (err) {
    // Check if superseded
    if (thisEpoch !== initEpoch) return;

    // Failed init: engine stays as-is (null or previous)
    emit({
      type: 'initResult',
      replyTo: cmd.commandId,
      ok: false,
      sceneVersion,
      atomCount: 0,
      wasmReady: false,
      kernel: 'js',
      error: String(err),
    });

    // Discard queued commands with error acks (they were meant for the failed scene)
    initInFlight = false;
    const failedQueue = currentInitQueue;
    currentInitQueue = [];
    for (const qcmd of failedQueue) {
      emitNotReady(qcmd, 'Init failed; queued command discarded');
    }
  }
}

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

function handleClearScene(cmd: Extract<WorkerCommand, { type: 'clearScene' }>): void {
  if (!engine) { emitNotReady(cmd, 'Engine not initialized'); return; }
  engine.clearScene();
  sceneVersion += 1;
  snapshotVersion = 0;
  emit({ type: 'clearSceneResult', replyTo: cmd.commandId, ok: true, sceneVersion });
}

function handleRequestFrame(cmd: Extract<WorkerCommand, { type: 'requestFrame' }>): void {
  if (!engine) {
    // Typed failure completion — not a valid empty scene
    emit({ type: 'frameSkipped', replyTo: cmd.commandId, sceneVersion, stepsCompleted: 0, physStepMs: 0, reason: 'not_initialized' });
    return;
  }

  const t0 = performance.now();
  const steps = cmd.stepsRequested;
  if (engine.n > 0) {
    for (let s = 0; s < steps; s++) {
      engine.stepOnce();
    }
    engine.applySafetyControls();
  }
  const physStepMs = performance.now() - t0;
  snapshotVersion += 1;

  const n = engine.n;
  const positions = new Float64Array(n * 3);
  if (n > 0) positions.set(engine.pos.subarray(0, n * 3));

  emit({
    type: 'frameResult',
    replyTo: cmd.commandId,
    sceneVersion,
    snapshotVersion,
    positions,
    n,
    stepsCompleted: steps,
    physStepMs,
  });
}

// Interactive commands — fire-and-forget
function handleStartDrag(cmd: Extract<WorkerCommand, { type: 'startDrag' }>): void {
  if (!engine) return;
  switch (cmd.mode) {
    case 'atom': engine.startDrag(cmd.atomIndex); break;
    case 'move': engine.startTranslate(cmd.atomIndex); break;
    case 'rotate': engine.startRotateDrag(cmd.atomIndex); break;
  }
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

// Settings commands — fire-and-forget
function handleSetDragStrength(cmd: Extract<WorkerCommand, { type: 'setDragStrength' }>): void { if (engine) engine.setDragStrength(cmd.value); }
function handleSetRotateStrength(cmd: Extract<WorkerCommand, { type: 'setRotateStrength' }>): void { if (engine) engine.setRotateStrength(cmd.value); }
function handleSetDamping(cmd: Extract<WorkerCommand, { type: 'setDamping' }>): void { if (engine) engine.setDamping(cmd.value); }
function handleSetWallMode(cmd: Extract<WorkerCommand, { type: 'setWallMode' }>): void { if (engine) engine.setWallMode(cmd.mode); }
function handleUpdateWallCenter(cmd: Extract<WorkerCommand, { type: 'updateWallCenter' }>): void {
  if (engine) {
    engine.updateWallCenter(cmd.atoms, cmd.offset);
    engine.updateWallRadius(); // Wall radius depends on atom count + density; must update after center
  }
}

// ─── Centralized dispatcher ────────────────────────────────────────────────

function dispatch(cmd: WorkerCommand): void {
  switch (cmd.type) {
    case 'init':              handleInit(cmd); break;
    case 'appendMolecule':    handleAppendMolecule(cmd); break;
    case 'clearScene':        handleClearScene(cmd); break;
    case 'requestFrame':      handleRequestFrame(cmd); break;
    case 'startDrag':         handleStartDrag(cmd); break;
    case 'updateDrag':        handleUpdateDrag(cmd); break;
    case 'endDrag':           handleEndDrag(cmd); break;
    case 'applyImpulse':      handleApplyImpulse(cmd); break;
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
    // ALL commands are queued during init (including a second init)
    currentInitQueue.push(cmd);
    return;
  }
  dispatch(cmd);
};

// ─── Signal readiness ───────────────────────────────────────────────────────
// 'ready' means "worker script loaded and accepting commands."
// Simulation/Wasm readiness comes via initResult after an init command.

emit({ type: 'ready' });
