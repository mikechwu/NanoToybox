/**
 * Direct WorkerBridge tests — exercises the real class with a mock Worker.
 *
 * Unlike worker-bridge.test.ts (logic-mirror tests), these instantiate the
 * actual WorkerBridge class. The mock Worker captures postMessage and lets
 * tests simulate responses via onmessage.
 *
 * E.3 coverage:
 * - #1 requestFrame completion contract (one result per request)
 * - #5 appendMolecule resolves with ack
 * - #6 canSendRequest blocks during outstanding request
 * - #7 Worker ordering invariant (mutation ack gating on real bridge)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { WorkerEvent } from '../../src/types/worker-protocol';

// ─── Mock Worker ──────────────────────────────────────────────────────

let mockWorkerInstance: MockWorker;

class MockWorker {
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: ErrorEvent) => void) | null = null;
  posted: any[] = [];

  constructor(_url: string | URL, _opts?: any) {
    mockWorkerInstance = this;
  }

  postMessage(data: any) {
    this.posted.push(data);
  }

  terminate() {}

  /** Test helper: simulate a worker response. */
  respond(event: WorkerEvent) {
    if (this.onmessage) {
      this.onmessage({ data: event } as MessageEvent);
    }
  }
}

// ─── Setup ────────────────────────────────────────────────────────────

// Stub import.meta.url for the Worker constructor's URL resolution
const originalWorker = globalThis.Worker;

beforeEach(() => {
  (globalThis as any).Worker = MockWorker;
});

afterEach(() => {
  (globalThis as any).Worker = originalWorker;
  mockWorkerInstance = null as any;
});

async function createBridge() {
  const mod = await import('../../lab/js/worker-bridge');
  return new mod.WorkerBridge();
}

// ─── Tests ────────────────────────────────────────────────────────────

describe('Direct WorkerBridge — requestFrame completion', () => {
  it('canSendRequest is false before init', async () => {
    const bridge = await createBridge();
    // State is 'loading' — can't send
    expect(bridge.canSendRequest()).toBe(false);
  });

  it('canSendRequest is true after successful init', async () => {
    const bridge = await createBridge();

    // Start init
    const initP = bridge.init(
      { dt: 0.001, wallRadius: 50, wallMode: 'contain' } as any,
      [], [],
    );

    // Respond with successful initResult
    const initCmd = mockWorkerInstance.posted[0];
    mockWorkerInstance.respond({
      type: 'initResult',
      replyTo: initCmd.commandId,
      ok: true,
      sceneVersion: 1,
      atomCount: 0,
      wasmReady: true,
      kernel: 'wasm',
    });

    await initP;
    expect(bridge.canSendRequest()).toBe(true);
  });

  it('#1 — requestFrame produces exactly one completion (frameResult)', async () => {
    const bridge = await createBridge();

    // Init
    const initP = bridge.init({ dt: 0.001 } as any, [], []);
    const initCmd = mockWorkerInstance.posted[0];
    mockWorkerInstance.respond({
      type: 'initResult', replyTo: initCmd.commandId, ok: true,
      sceneVersion: 1, atomCount: 0, wasmReady: true, kernel: 'wasm',
    });
    await initP;

    // Track frameResult callbacks
    const results: any[] = [];
    bridge.setOnFrameResult((snap) => results.push(snap));

    // Send requestFrame
    bridge.sendRequestFrame(10);
    expect(bridge.canSendRequest()).toBe(false); // outstanding

    // Respond with frameResult
    const reqCmd = mockWorkerInstance.posted[1];
    mockWorkerInstance.respond({
      type: 'frameResult', replyTo: reqCmd.commandId, sceneVersion: 1,
      snapshotVersion: 1, positions: new Float64Array(0), n: 0,
      stepsCompleted: 10, physStepMs: 1.0,
    });

    expect(results.length).toBe(1);
    expect(bridge.canSendRequest()).toBe(true); // cleared
  });

  it('#1 — requestFrame produces exactly one completion (frameSkipped)', async () => {
    const bridge = await createBridge();

    const initP = bridge.init({ dt: 0.001 } as any, [], []);
    const initCmd = mockWorkerInstance.posted[0];
    mockWorkerInstance.respond({
      type: 'initResult', replyTo: initCmd.commandId, ok: true,
      sceneVersion: 1, atomCount: 0, wasmReady: true, kernel: 'wasm',
    });
    await initP;

    const skips: any[] = [];
    bridge.setOnFrameSkipped((info) => skips.push(info));

    bridge.sendRequestFrame(10);
    expect(bridge.canSendRequest()).toBe(false);

    const reqCmd = mockWorkerInstance.posted[1];
    mockWorkerInstance.respond({
      type: 'frameSkipped', replyTo: reqCmd.commandId, sceneVersion: 1,
      stepsCompleted: 0, physStepMs: 0, reason: 'buffer_exhausted',
    });

    expect(skips.length).toBe(1);
    expect(skips[0].reason).toBe('buffer_exhausted');
    expect(bridge.canSendRequest()).toBe(true); // cleared
    expect(bridge.getLatestSnapshot()).toBeNull(); // no snapshot on skip
  });
});

describe('Direct WorkerBridge — #6 one-in-flight enforcement', () => {
  it('blocks second requestFrame while first is outstanding', async () => {
    const bridge = await createBridge();

    const initP = bridge.init({ dt: 0.001 } as any, [], []);
    mockWorkerInstance.respond({
      type: 'initResult', replyTo: mockWorkerInstance.posted[0].commandId, ok: true,
      sceneVersion: 1, atomCount: 0, wasmReady: true, kernel: 'wasm',
    });
    await initP;

    bridge.sendRequestFrame(10);
    expect(bridge.canSendRequest()).toBe(false);

    // Complete the first request
    mockWorkerInstance.respond({
      type: 'frameResult', replyTo: mockWorkerInstance.posted[1].commandId,
      sceneVersion: 1, snapshotVersion: 1, positions: new Float64Array(0),
      n: 0, stepsCompleted: 10, physStepMs: 1.0,
    });

    expect(bridge.canSendRequest()).toBe(true);
  });
});

describe('Direct WorkerBridge — #5 appendMolecule resolves with ack', () => {
  it('appendMolecule resolves on successful appendResult', async () => {
    const bridge = await createBridge();

    // Init first
    const initP = bridge.init({ dt: 0.001 } as any, [], []);
    mockWorkerInstance.respond({
      type: 'initResult', replyTo: mockWorkerInstance.posted[0].commandId, ok: true,
      sceneVersion: 1, atomCount: 0, wasmReady: true, kernel: 'wasm',
    });
    await initP;

    // Append
    const appendP = bridge.appendMolecule(
      [{ x: 0, y: 0, z: 0 }], [], [0, 0, 0],
    );

    const appendCmd = mockWorkerInstance.posted[1];
    expect(appendCmd.type).toBe('appendMolecule');

    mockWorkerInstance.respond({
      type: 'appendResult', replyTo: appendCmd.commandId, ok: true,
      sceneVersion: 2, atomOffset: 0, atomsAppended: 1, totalAtomCount: 1,
    });

    const result = await appendP;
    expect(result.ok).toBe(true);
    expect(result.atomsAppended).toBe(1);
    expect(result.sceneVersion).toBe(2);
  });

  it('appendMolecule resolves on failure with error', async () => {
    const bridge = await createBridge();

    const initP = bridge.init({ dt: 0.001 } as any, [], []);
    mockWorkerInstance.respond({
      type: 'initResult', replyTo: mockWorkerInstance.posted[0].commandId, ok: true,
      sceneVersion: 1, atomCount: 0, wasmReady: true, kernel: 'wasm',
    });
    await initP;

    const appendP = bridge.appendMolecule([{ x: 0, y: 0, z: 0 }], [], [0, 0, 0]);
    const appendCmd = mockWorkerInstance.posted[1];

    mockWorkerInstance.respond({
      type: 'appendResult', replyTo: appendCmd.commandId, ok: false,
      sceneVersion: 1, atomOffset: 0, atomsAppended: 0, totalAtomCount: 0,
      error: 'capacity exceeded',
    });

    const result = await appendP;
    expect(result.ok).toBe(false);
    expect(result.error).toBe('capacity exceeded');
  });
});

describe('Direct WorkerBridge — #7 mutation-aware gating on real bridge', () => {
  it('rejects stale frameResult (sceneVersion < last accepted mutation)', async () => {
    const bridge = await createBridge();

    // Init at sceneVersion 1
    const initP = bridge.init({ dt: 0.001 } as any, [], []);
    mockWorkerInstance.respond({
      type: 'initResult', replyTo: mockWorkerInstance.posted[0].commandId, ok: true,
      sceneVersion: 1, atomCount: 0, wasmReady: true, kernel: 'wasm',
    });
    await initP;

    // Append → sceneVersion advances to 2
    const appendP = bridge.appendMolecule([{ x: 0, y: 0, z: 0 }], [], [0, 0, 0]);
    mockWorkerInstance.respond({
      type: 'appendResult', replyTo: mockWorkerInstance.posted[1].commandId, ok: true,
      sceneVersion: 2, atomOffset: 0, atomsAppended: 1, totalAtomCount: 1,
    });
    await appendP;

    // Send a request frame
    bridge.sendRequestFrame(10);
    const results: any[] = [];
    bridge.setOnFrameResult((snap) => results.push(snap));

    // Simulate a stale frameResult from sceneVersion 1 (pre-append)
    mockWorkerInstance.respond({
      type: 'frameResult', replyTo: mockWorkerInstance.posted[2].commandId,
      sceneVersion: 1, snapshotVersion: 1, positions: new Float64Array(0),
      n: 0, stepsCompleted: 5, physStepMs: 0.5,
    });

    // Should be rejected — stale sceneVersion
    expect(results.length).toBe(0);
    // Snapshot should not be updated by rejected event
    expect(bridge.getLatestSnapshot()).toBeNull();
  });

  it('accepts frameResult at current sceneVersion', async () => {
    const bridge = await createBridge();

    const initP = bridge.init({ dt: 0.001 } as any, [], []);
    mockWorkerInstance.respond({
      type: 'initResult', replyTo: mockWorkerInstance.posted[0].commandId, ok: true,
      sceneVersion: 1, atomCount: 0, wasmReady: true, kernel: 'wasm',
    });
    await initP;

    bridge.sendRequestFrame(10);
    const results: any[] = [];
    bridge.setOnFrameResult((snap) => results.push(snap));

    mockWorkerInstance.respond({
      type: 'frameResult', replyTo: mockWorkerInstance.posted[1].commandId,
      sceneVersion: 1, snapshotVersion: 1, positions: new Float64Array(0),
      n: 0, stepsCompleted: 10, physStepMs: 1.0,
    });

    expect(results.length).toBe(1);
  });
});

describe('Direct WorkerBridge — append snapshot race regression', () => {
  it('clears latestSnapshot when restoreState starts (Watch→Lab hydrate)', async () => {
    // Pins the fix for the 2026-04-16 post-hydrate flash-to-default
    // bug. Before this fix, the pre-restoreState `latestSnapshot`
    // (e.g. C60) was still returned by `getLatestSnapshot()` until
    // the worker emitted its first post-restore `frameResult`. The
    // main-thread frame runtime's reconciler would read that stale
    // snapshot and clobber physics back to the pre-hydrate scene,
    // causing the user to see the hydrated scene for ~0.1 s and then
    // watch it revert to the default C60.
    const bridge = await createBridge();
    const initP = bridge.init({ dt: 0.001 } as any, [], []);
    mockWorkerInstance.respond({
      type: 'initResult', replyTo: mockWorkerInstance.posted[0].commandId, ok: true,
      sceneVersion: 1, atomCount: 60, wasmReady: true, kernel: 'wasm',
    });
    await initP;
    // Seed a pre-mutation snapshot (simulating C60 steady-state frames).
    bridge.sendRequestFrame(1);
    mockWorkerInstance.respond({
      type: 'frameResult', replyTo: mockWorkerInstance.posted[1].commandId,
      sceneVersion: 1, snapshotVersion: 1,
      positions: new Float64Array(180), n: 60,
      stepsCompleted: 1, physStepMs: 1.0,
    });
    expect(bridge.getLatestSnapshot()!.n).toBe(60);
    // Start restoreState — MUST clear the stale snapshot synchronously,
    // not wait for the worker's ack + first post-restore frameResult.
    const restoreP = bridge.restoreState(
      { dt: 0.001, dampingReferenceSteps: 100, damping: 0.1, kDrag: 1, kRotate: 1, wallMode: 'contain', useWasm: true } as any,
      [{ x: 0, y: 0, z: 0 }, { x: 1.42, y: 0, z: 0 }],
      [[0, 1, 1.42]],
      new Float64Array(6),
      undefined,
    );
    expect(bridge.getLatestSnapshot()).toBeNull();
    // The ack arrives but no frameResult yet → still null.
    mockWorkerInstance.respond({
      type: 'restoreStateResult', replyTo: mockWorkerInstance.posted[2].commandId, ok: true,
      sceneVersion: 2, atomCount: 2, wasmReady: true, kernel: 'wasm',
    });
    await restoreP;
    expect(bridge.getLatestSnapshot()).toBeNull();
    // First post-restore frameResult populates the snapshot with seed state.
    bridge.sendRequestFrame(1);
    mockWorkerInstance.respond({
      type: 'frameResult', replyTo: mockWorkerInstance.posted[3].commandId,
      sceneVersion: 2, snapshotVersion: 1,
      positions: new Float64Array(6), n: 2,
      stepsCompleted: 1, physStepMs: 1.0,
    });
    const snap = bridge.getLatestSnapshot();
    expect(snap).not.toBeNull();
    expect(snap!.n).toBe(2);
    expect(snap!.sceneVersion).toBe(2);
  });

  it('clears latestSnapshot when appendMolecule starts', async () => {
    const bridge = await createBridge();

    // Init
    const initP = bridge.init({ dt: 0.001 } as any, [], []);
    mockWorkerInstance.respond({
      type: 'initResult', replyTo: mockWorkerInstance.posted[0].commandId, ok: true,
      sceneVersion: 1, atomCount: 60, wasmReady: true, kernel: 'wasm',
    });
    await initP;

    // Get a frame so latestSnapshot is populated
    bridge.sendRequestFrame(1);
    mockWorkerInstance.respond({
      type: 'frameResult', replyTo: mockWorkerInstance.posted[1].commandId,
      sceneVersion: 1, snapshotVersion: 1,
      positions: new Float64Array(180), n: 60,
      stepsCompleted: 1, physStepMs: 1.0,
    });
    expect(bridge.getLatestSnapshot()).not.toBeNull();
    expect(bridge.getLatestSnapshot()!.n).toBe(60);

    // Start append — latestSnapshot must be cleared immediately
    bridge.appendMolecule([{ x: 0, y: 0, z: 0 }], [], [0, 0, 0]);
    expect(bridge.getLatestSnapshot()).toBeNull();
  });

  it('rejects equal-version frame during pending append', async () => {
    const bridge = await createBridge();

    const initP = bridge.init({ dt: 0.001 } as any, [], []);
    mockWorkerInstance.respond({
      type: 'initResult', replyTo: mockWorkerInstance.posted[0].commandId, ok: true,
      sceneVersion: 1, atomCount: 60, wasmReady: true, kernel: 'wasm',
    });
    await initP;

    // Start append (pending, not yet acked)
    const appendP = bridge.appendMolecule([{ x: 0, y: 0, z: 0 }], [], [0, 0, 0]);

    // Send a request and try to deliver a pre-append frame
    bridge.sendRequestFrame(1);
    const frameResults: any[] = [];
    bridge.setOnFrameResult((snap) => frameResults.push(snap));

    mockWorkerInstance.respond({
      type: 'frameResult', replyTo: mockWorkerInstance.posted[2].commandId,
      sceneVersion: 1, snapshotVersion: 2,
      positions: new Float64Array(180), n: 60,
      stepsCompleted: 1, physStepMs: 1.0,
    });

    // Frame should be rejected — pending mutation blocks all scene-versioned events
    expect(frameResults.length).toBe(0);
    expect(bridge.getLatestSnapshot()).toBeNull();

    // Now ack the append
    mockWorkerInstance.respond({
      type: 'appendResult', replyTo: mockWorkerInstance.posted[1].commandId, ok: true,
      sceneVersion: 2, atomOffset: 60, atomsAppended: 1, totalAtomCount: 61,
    });
    await appendP;

    // Post-append frame with new scene version should be accepted
    bridge.sendRequestFrame(1);
    mockWorkerInstance.respond({
      type: 'frameResult', replyTo: mockWorkerInstance.posted[3].commandId,
      sceneVersion: 2, snapshotVersion: 3,
      positions: new Float64Array(183), n: 61,
      stepsCompleted: 1, physStepMs: 1.0,
    });

    expect(frameResults.length).toBe(1);
    expect(frameResults[0].n).toBe(61);
  });

  it('failed append ack: bridge destroyed becomes inactive', async () => {
    const bridge = await createBridge();

    // Init
    const initP = bridge.init({ dt: 0.001 } as any, [{ x: 0, y: 0, z: 0 }], []);
    mockWorkerInstance.respond({
      type: 'initResult', replyTo: mockWorkerInstance.posted[0].commandId, ok: true,
      sceneVersion: 1, atomCount: 1, wasmReady: true, kernel: 'wasm',
    });
    await initP;
    expect(bridge.canSendRequest()).toBe(true);

    // Start append
    const appendP = bridge.appendMolecule([{ x: 1, y: 0, z: 0 }], [], [0, 0, 0]);

    // Fail the append
    mockWorkerInstance.respond({
      type: 'appendResult', replyTo: mockWorkerInstance.posted[1].commandId, ok: false,
      sceneVersion: 1, atomOffset: 0, atomsAppended: 0, totalAtomCount: 1,
      error: 'capacity exceeded',
    });
    const result = await appendP;
    expect(result.ok).toBe(false);

    // Simulate what scene-runtime does: destroy the bridge
    bridge.destroy();

    // Bridge is now torn down — canSendRequest returns false
    expect(bridge.canSendRequest()).toBe(false);
    expect(bridge.getLatestSnapshot()).toBeNull();
    expect(bridge.getWorkerState()).toBe('crashed');
  });
});

// ─── restoreState behavioral tests ───────────────────────────────────

describe('Direct WorkerBridge — restoreState', () => {
  async function initBridge() {
    const bridge = await createBridge();
    const initP = bridge.init(
      { dt: 0.5, dampingReferenceSteps: 4, damping: 0, kDrag: 2, kRotate: 5, wallMode: 'contain', useWasm: false } as any,
      [{ x: 0, y: 0, z: 0 }], [[0, 1, 1.42] as any],
    );
    const initCmd = mockWorkerInstance.posted[0];
    mockWorkerInstance.respond({
      type: 'initResult', replyTo: initCmd.commandId, ok: true,
      sceneVersion: 1, atomCount: 1, wasmReady: false, kernel: 'js',
    });
    await initP;
    return bridge;
  }

  it('posts a restoreState command with velocities and boundary', async () => {
    const bridge = await initBridge();
    const vel = new Float64Array([0.01, 0.02, 0.03]);
    const boundary = {
      mode: 'contain' as const, wallRadius: 60,
      wallCenter: [1, 2, 3] as [number, number, number],
      wallCenterSet: true, removedCount: 0, damping: 0.1,
    };

    bridge.restoreState(
      { dt: 0.5, dampingReferenceSteps: 4, damping: 0.1, kDrag: 3, kRotate: 7, wallMode: 'contain', useWasm: false },
      [{ x: 10, y: 20, z: 30 }],
      [[0, 1, 1.5] as any],
      vel, boundary,
    );

    // Find the restoreState command (skip init which was posted[0])
    const restoreCmd = mockWorkerInstance.posted.find((c: any) => c.type === 'restoreState');
    expect(restoreCmd).toBeDefined();
    expect(restoreCmd.type).toBe('restoreState');
    expect(restoreCmd.velocities).toBe(vel);
    expect(restoreCmd.boundary.wallRadius).toBe(60);
    expect(restoreCmd.atoms[0].x).toBe(10);
    // No interaction field
    expect('interaction' in restoreCmd).toBe(false);
  });

  it('resolves on restoreStateResult with ok: true', async () => {
    const bridge = await initBridge();
    const vel = new Float64Array(3);
    const boundary = { mode: 'contain' as const, wallRadius: 50, wallCenter: [0, 0, 0] as [number, number, number], wallCenterSet: true, removedCount: 0, damping: 0 };

    const restoreP = bridge.restoreState(
      { dt: 0.5, dampingReferenceSteps: 4, damping: 0, kDrag: 2, kRotate: 5, wallMode: 'contain', useWasm: false },
      [{ x: 0, y: 0, z: 0 }], [], vel, boundary,
    );

    const restoreCmd = mockWorkerInstance.posted.find((c: any) => c.type === 'restoreState');
    mockWorkerInstance.respond({
      type: 'restoreStateResult', replyTo: restoreCmd.commandId, ok: true,
      sceneVersion: 2, atomCount: 1, wasmReady: false, kernel: 'js',
    });

    const result = await restoreP;
    expect(result.ok).toBe(true);
    expect(result.atomCount).toBe(1);
    // Bridge should be in running state after successful restore
    expect(bridge.canSendRequest()).toBe(true);
  });

  it('resolves synthetic failure on worker crash during restoreState', async () => {
    const bridge = await initBridge();
    const vel = new Float64Array(3);
    const boundary = { mode: 'contain' as const, wallRadius: 50, wallCenter: [0, 0, 0] as [number, number, number], wallCenterSet: true, removedCount: 0, damping: 0 };

    const restoreP = bridge.restoreState(
      { dt: 0.5, dampingReferenceSteps: 4, damping: 0, kDrag: 2, kRotate: 5, wallMode: 'contain', useWasm: false },
      [{ x: 0, y: 0, z: 0 }], [], vel, boundary,
    );

    // Simulate worker crash
    if (mockWorkerInstance.onerror) {
      mockWorkerInstance.onerror({ message: 'crash' } as ErrorEvent);
    }

    const result = await restoreP;
    expect(result.ok).toBe(false);
    expect(result.type).toBe('restoreStateResult');
  });
});
