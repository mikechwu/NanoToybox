/**
 * @vitest-environment jsdom
 */
/**
 * Tests for refined worker stall detection.
 *
 * Verifies:
 *   - No outstanding request + no progress → does NOT trigger fatal stall
 *   - Outstanding request old enough → warning state
 *   - Outstanding request beyond fatal threshold → recovery attempt then fallback
 *   - Paused → no stall detection
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

async function createInitedRuntime() {
  const onFailure = vi.fn();
  const onSchedulerTiming = vi.fn();
  const mod = await import('../../page/js/runtime/worker-lifecycle');
  const runtime = mod.createWorkerRuntime({ onSchedulerTiming, onFailure });

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

describe('Worker stall detection — refined logic', () => {
  it('no outstanding request does not trigger stall even with no progress', async () => {
    const { runtime, onFailure } = await createInitedRuntime();
    runtime.setTestStalledThreshold(100);

    // Simulate frozen progress (no completions)
    runtime.simulateStall();

    // Advance past the fatal threshold — but no request is outstanding
    vi.spyOn(performance, 'now').mockReturnValue(performance.now() + 500);

    runtime.checkStalled(false);
    expect(runtime.isStalled()).toBe(false);
    expect(onFailure).not.toHaveBeenCalled();

    vi.restoreAllMocks();
  });

  it('outstanding request past warning threshold sets stalled flag', async () => {
    const { runtime, onFailure } = await createInitedRuntime();
    runtime.setTestStalledThreshold(100);

    // Send a request (creates outstanding request)
    runtime.sendRequestFrame(1);
    const baseNow = performance.now();

    // Advance past warning threshold (100ms) but under fatal (300ms)
    vi.spyOn(performance, 'now').mockReturnValue(baseNow + 150);

    runtime.checkStalled(false);
    expect(runtime.isStalled()).toBe(true);
    expect(onFailure).not.toHaveBeenCalled();

    vi.restoreAllMocks();
  });

  it('outstanding request past fatal threshold triggers recovery then fallback', async () => {
    const { runtime, onFailure } = await createInitedRuntime();
    runtime.setTestStalledThreshold(100);

    // Send a request
    runtime.sendRequestFrame(1);
    const baseNow = performance.now();

    // First check past fatal threshold — should attempt recovery (not onFailure)
    vi.spyOn(performance, 'now').mockReturnValue(baseNow + 350);
    runtime.checkStalled(false);
    expect(runtime.isStalled()).toBe(true);
    expect(onFailure).not.toHaveBeenCalled(); // recovery attempt, not failure

    // Send another request (simulating the pipeline resuming after bump)
    runtime.sendRequestFrame(1);
    const recoveryNow = performance.now();

    // Second check past fatal again — now truly fatal
    vi.spyOn(performance, 'now').mockReturnValue(recoveryNow + 350);
    runtime.checkStalled(false);
    expect(onFailure).toHaveBeenCalledTimes(1);

    vi.restoreAllMocks();
  });

  it('warning then fatal still attempts recovery before teardown', async () => {
    const { runtime, onFailure } = await createInitedRuntime();
    runtime.setTestStalledThreshold(100);

    runtime.sendRequestFrame(1);
    const baseNow = performance.now();

    // Cross warning threshold (100ms) but not fatal (300ms)
    vi.spyOn(performance, 'now').mockReturnValue(baseNow + 150);
    runtime.checkStalled(false);
    expect(runtime.isStalled()).toBe(true);
    expect(onFailure).not.toHaveBeenCalled();

    // Now cross fatal threshold — recovery should be attempted (not immediate teardown)
    vi.spyOn(performance, 'now').mockReturnValue(baseNow + 400);
    runtime.checkStalled(false);
    expect(runtime.isStalled()).toBe(true);
    expect(onFailure).not.toHaveBeenCalled(); // recovery attempt, not failure

    vi.restoreAllMocks();
  });

  it('paused simulation does not trigger stall', async () => {
    const { runtime, onFailure } = await createInitedRuntime();
    runtime.setTestStalledThreshold(100);

    runtime.sendRequestFrame(1);
    const baseNow = performance.now();

    vi.spyOn(performance, 'now').mockReturnValue(baseNow + 500);

    runtime.checkStalled(true); // paused = true
    expect(runtime.isStalled()).toBe(false);
    expect(onFailure).not.toHaveBeenCalled();

    vi.restoreAllMocks();
  });

  it('debug state includes outstanding request diagnostics', async () => {
    const { runtime } = await createInitedRuntime();

    // Before any request
    let debug = runtime.getDebugState();
    expect(debug.hasOutstandingRequest).toBe(false);
    expect(debug.outstandingRequestAgeMs).toBe(-1);

    // After sending request
    runtime.sendRequestFrame(1);
    debug = runtime.getDebugState();
    expect(debug.hasOutstandingRequest).toBe(true);
    expect(debug.outstandingRequestAgeMs).toBeGreaterThanOrEqual(0);
  });

  it('recovery state clears when outstanding requests drain, allowing fresh recovery on next wedge', async () => {
    const { runtime, onFailure } = await createInitedRuntime();
    runtime.setTestStalledThreshold(100);

    // Send a request and trigger recovery (fatal threshold)
    runtime.sendRequestFrame(1);
    const baseNow = performance.now();
    vi.spyOn(performance, 'now').mockReturnValue(baseNow + 350);
    runtime.checkStalled(false);
    expect(runtime.isStalled()).toBe(true);
    expect(onFailure).not.toHaveBeenCalled(); // recovery attempt, not failure

    // After bumpGeneration (inside recovery), outstanding requests are cleared.
    // The next checkStalled should see no outstanding → clear stalled + recovery state.
    vi.restoreAllMocks();
    runtime.checkStalled(false);
    expect(runtime.isStalled()).toBe(false);

    // A new wedge should get a fresh recovery attempt (not immediate teardown)
    runtime.sendRequestFrame(1);
    const newNow = performance.now();
    vi.spyOn(performance, 'now').mockReturnValue(newNow + 350);
    runtime.checkStalled(false);
    expect(runtime.isStalled()).toBe(true);
    expect(onFailure).not.toHaveBeenCalled(); // fresh recovery, not teardown

    vi.restoreAllMocks();
  });
});
