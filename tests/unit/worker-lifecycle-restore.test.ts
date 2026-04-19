/**
 * Behavioral tests for WorkerRuntime.restoreState() lifecycle.
 *
 * Uses the same MockWorker pattern as worker-bridge-direct.test.ts.
 * Tests the runtime layer's response to restore success, failure ack,
 * and thrown errors — the layer main.ts depends on.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { WorkerEvent } from '../../src/types/worker-protocol';

// ─── Mock Worker ──────────────────────────────────────────────────────

let mockWorkerInstance: MockWorker;

class MockWorker {
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: ErrorEvent) => void) | null = null;
  posted: any[] = [];
  constructor(_url: string | URL, _opts?: any) { mockWorkerInstance = this; }
  postMessage(data: any) { this.posted.push(data); }
  terminate() {}
  respond(event: WorkerEvent) {
    if (this.onmessage) this.onmessage({ data: event } as MessageEvent);
  }
}

const originalWorker = globalThis.Worker;

beforeEach(() => { (globalThis as any).Worker = MockWorker; });
afterEach(() => { (globalThis as any).Worker = originalWorker; mockWorkerInstance = null as any; });

// ─── Helpers ──────────────────────────────────────────────────────────

const dummyConfig = {
  dt: 0.5, dampingReferenceSteps: 4, damping: 0, kDrag: 2, kRotate: 5,
  wallMode: 'contain' as const, useWasm: false,
};
const dummyBoundary = {
  mode: 'contain' as const, wallRadius: 50,
  wallCenter: [0, 0, 0] as [number, number, number],
  wallCenterSet: true, removedCount: 0, damping: 0,
};

async function createInitedRuntime() {
  const onFailure = vi.fn();
  const onSchedulerTiming = vi.fn();
  const mod = await import('../../lab/js/runtime/worker/worker-lifecycle');
  const runtime = mod.createWorkerRuntime({ onSchedulerTiming, onFailure });

  // Init with one atom so the bridge actually sends init
  const initP = runtime.init(dummyConfig, [{ x: 0, y: 0, z: 0 }], [[0, 1, 1.42] as any]);
  const initCmd = mockWorkerInstance.posted[0];
  mockWorkerInstance.respond({
    type: 'initResult', replyTo: initCmd.commandId, ok: true,
    sceneVersion: 1, atomCount: 1, wasmReady: false, kernel: 'js',
  });
  await initP;

  return { runtime, onFailure, onSchedulerTiming };
}

// ─── Tests ────────────────────────────────────────────────────────────

describe('WorkerRuntime.restoreState — success', () => {
  it('reactivates runtime on successful restore', async () => {
    const { runtime, onFailure } = await createInitedRuntime();
    expect(runtime.isActive()).toBe(true);

    // Start restore
    const restoreP = runtime.restoreState(
      dummyConfig, [{ x: 1, y: 2, z: 3 }], [], new Float64Array(3), dummyBoundary,
    );

    // Find and respond to the restoreState command
    const restoreCmd = mockWorkerInstance.posted.find((c: any) => c.type === 'restoreState');
    expect(restoreCmd).toBeDefined();
    mockWorkerInstance.respond({
      type: 'restoreStateResult', replyTo: restoreCmd.commandId, ok: true,
      sceneVersion: 2, atomCount: 1, wasmReady: false, kernel: 'js',
    });
    await restoreP;

    // Runtime should be active and not stalled
    expect(runtime.isActive()).toBe(true);
    expect(runtime.isStalled()).toBe(false);
    expect(onFailure).not.toHaveBeenCalled();
  });
});

describe('WorkerRuntime.restoreState — failure ack', () => {
  it('tears down and calls onFailure on failure ack', async () => {
    const { runtime, onFailure } = await createInitedRuntime();

    const restoreP = runtime.restoreState(
      dummyConfig, [{ x: 0, y: 0, z: 0 }], [], new Float64Array(3), dummyBoundary,
    );

    const restoreCmd = mockWorkerInstance.posted.find((c: any) => c.type === 'restoreState');
    mockWorkerInstance.respond({
      type: 'restoreStateResult', replyTo: restoreCmd.commandId, ok: false,
      sceneVersion: 1, atomCount: 0, wasmReady: false, kernel: 'js', error: 'test failure',
    });
    await restoreP;

    // Runtime should be inactive and onFailure called
    expect(runtime.isActive()).toBe(false);
    expect(onFailure).toHaveBeenCalledTimes(1);
    expect(onFailure.mock.calls[0][0]).toContain('restoreState failed');
  });
});

describe('WorkerRuntime.restoreState — thrown error', () => {
  it('tears down and calls onFailure on bridge error', async () => {
    const { runtime, onFailure } = await createInitedRuntime();

    // Make the next postMessage throw to simulate bridge error
    mockWorkerInstance.postMessage = () => { throw new Error('bridge exploded'); };

    await runtime.restoreState(
      dummyConfig, [{ x: 0, y: 0, z: 0 }], [], new Float64Array(3), dummyBoundary,
    );

    expect(runtime.isActive()).toBe(false);
    expect(onFailure).toHaveBeenCalledTimes(1);
    expect(onFailure.mock.calls[0][0]).toContain('restoreState error');
  });
});
