/**
 * Worker lifecycle runtime — owns worker bridge creation, init, progress
 * tracking, stall detection, transport, and teardown.
 *
 * Does NOT own:
 * - _buildWorkerConfig() — composition-root knowledge (physics getters + CONFIG)
 * - Local-physics recovery after failure — main.ts owns recoverLocalPhysicsAfterWorkerFailure()
 * - Debug/test hooks on window — main.ts wires getDebugState() onto window
 * - Scene serialization — _collectSceneAtoms/Bonds stay in main.ts
 * - Bond refresh counter — render-side reconciliation, stays in frame loop
 *
 * Does NOT attach global listeners or write to window.
 */

import { WorkerBridge, type WorkerInteractionCommand } from '../worker-bridge';
import type { PhysicsConfig } from '../../../src/types/worker-protocol';
import type { AtomXYZ } from '../../../src/types/domain';
import type { BondTuple } from '../../../src/types/interfaces';

export interface WorkerRuntime {
  /** Initialize with a pre-built config from main.ts. */
  init(config: PhysicsConfig, atoms: AtomXYZ[], bonds: BondTuple[]): Promise<void>;
  /** Tear down worker transport. Does NOT recover local physics. */
  destroy(): void;
  isActive(): boolean;
  isStalled(): boolean;
  canSendRequest(): boolean;
  sendRequestFrame(steps: number): void;
  getLatestSnapshot(): { positions: Float64Array; velocities?: Float64Array; n: number } | null;
  getSnapshotAge(): number;
  /** Request a zero-step authoritative state sync and resolve when the snapshot arrives. */
  syncStateNow(): Promise<void>;
  appendMolecule(atoms: AtomXYZ[], bonds: BondTuple[], offset: [number, number, number]): Promise<{ ok: boolean }>;
  bumpGeneration(): void;
  clearScene(): Promise<{ ok: boolean }>;
  sendInteraction(cmd: WorkerInteractionCommand): void;
  /** Check for stall condition. Call every frame (NOT throttled to status tick). */
  checkStalled(paused: boolean): void;
  /** Return debug state for main.ts to wire onto window. Does NOT write to window. */
  getDebugState(): Record<string, unknown>;
  /** Test-only: freeze progress timestamp to simulate stall. */
  simulateStall(): void;
  /** Test-only: override stall threshold. */
  setTestStalledThreshold(ms: number): void;
}

export function createWorkerRuntime(deps: {
  onSchedulerTiming: (physStepMs: number, stepsCompleted: number) => void;
  onFailure: (reason: string) => void;
}): WorkerRuntime {
  let _bridge: WorkerBridge | null = null;
  let _initialized = false;
  let _progressTs = 0;
  let _stalled = false;
  let _testFreezeProgress = false;
  let _testStalledThresholdMs = 0;

  function _teardown() {
    if (_bridge) {
      try { _bridge.destroy(); } catch (_) { /* ignore */ }
    }
    _bridge = null;
    _initialized = false;
    _stalled = false;
    _progressTs = 0;
  }

  return {
    async init(config: PhysicsConfig, atoms: AtomXYZ[], bonds: BondTuple[]) {
      let bridge: WorkerBridge;
      try {
        bridge = new WorkerBridge();
      } catch (e) {
        console.warn('[worker] failed to create WorkerBridge, falling back to sync physics:', e);
        return;
      }
      _bridge = bridge;

      bridge.setOnFrameResult((snapshot) => {
        if (!_testFreezeProgress) {
          _progressTs = performance.now();
          if (_stalled) _stalled = false;
        }
        if (snapshot.stepsCompleted > 0) {
          deps.onSchedulerTiming(snapshot.physStepMs / snapshot.stepsCompleted, snapshot.stepsCompleted);
        }
      });

      bridge.setOnFrameSkipped((info) => {
        if (!_testFreezeProgress) _progressTs = performance.now();
        if (info.stepsCompleted > 0) {
          deps.onSchedulerTiming(info.physStepMs / info.stepsCompleted, info.stepsCompleted);
        }
      });

      bridge.setOnCrash((reason) => {
        _teardown();
        deps.onFailure(reason);
      });

      if (atoms.length > 0) {
        try {
          const result = await bridge.init(config, atoms, bonds);
          // Guard: if destroy() was called during the await, abandon
          if (_bridge !== bridge) return;
          if (result.ok) {
            _initialized = true;
            _progressTs = performance.now();
            _stalled = false;
          } else {
            console.warn('[worker] init failed:', result.error);
            _teardown();
            deps.onFailure('Worker init failed: ' + (result.error || 'unknown'));
          }
        } catch (e) {
          if (_bridge !== bridge) return; // destroyed mid-flight
          console.warn('[worker] init error:', e);
          _teardown();
          deps.onFailure('Worker init error');
        }
      }
    },

    destroy() { _teardown(); },
    isActive() { return !!(_bridge && _initialized); },
    isStalled() { return _stalled; },

    canSendRequest() {
      return !!(_bridge && _initialized && _bridge.canSendRequest());
    },

    sendRequestFrame(steps: number) {
      if (_bridge && _initialized) {
        _bridge.sendRequestFrame(steps);
      }
    },

    getLatestSnapshot() {
      return _bridge && _initialized ? _bridge.getLatestSnapshot() : null;
    },

    getSnapshotAge() {
      return _bridge && _initialized ? _bridge.getSnapshotAge() : Infinity;
    },

    async syncStateNow(): Promise<void> {
      if (!_bridge || !_initialized) return;
      // Clear outstanding requests (invalidates pre-bump snapshots) and send
      // a zero-step frame. After bumpGeneration(), latestSnapshot is null and
      // only the zero-step response can pass the generation gate — so the next
      // non-null snapshot is provably the requested authoritative state.
      _bridge.bumpGeneration();
      _bridge.sendRequestFrame(0);
      // Wait for the specific post-bump snapshot to arrive
      const start = performance.now();
      const timeout = 2000;
      while (performance.now() - start < timeout) {
        const snap = _bridge.getLatestSnapshot();
        if (snap) return; // Post-bump snapshot arrived (generation-verified by bridge)
        await new Promise(r => setTimeout(r, 10));
      }
      // Timeout: worker is unresponsive. Tear down and throw so the caller
      // can abort the placement commit rather than continue with stale state.
      console.warn('[worker] syncStateNow timed out — tearing down worker');
      _teardown();
      deps.onFailure('syncStateNow timeout — worker unresponsive during paused placement');
      throw new Error('Worker state sync timed out');
    },

    async appendMolecule(atoms, bonds, offset) {
      if (!_bridge || !_initialized) return { ok: false };
      try {
        return await _bridge.appendMolecule(atoms, bonds, offset);
      } catch (e) {
        console.warn('[worker] appendMolecule error:', e);
        _teardown();
        deps.onFailure('appendMolecule transport failure');
        return { ok: false };
      }
    },

    bumpGeneration() {
      if (_bridge) _bridge.bumpGeneration();
    },

    async clearScene() {
      if (!_bridge || !_initialized) return { ok: false };
      try {
        return await _bridge.clearScene();
      } catch (e) {
        console.warn('[worker] clearScene error:', e);
        _teardown();
        deps.onFailure('clearScene transport failure');
        return { ok: false };
      }
    },

    sendInteraction(cmd: WorkerInteractionCommand) {
      if (_bridge && _initialized) {
        _bridge.sendInteraction(cmd);
      }
    },

    checkStalled(paused: boolean) {
      if (!_bridge || !_initialized || _progressTs <= 0) return;
      if (paused) return; // don't stall-detect while simulation is paused
      const timeSinceProgress = performance.now() - _progressTs;
      const stalledThresholdMs = _testStalledThresholdMs > 0 ? _testStalledThresholdMs : 5000;
      const fatalThresholdMs = stalledThresholdMs * 3;
      if (timeSinceProgress > fatalThresholdMs) {
        console.warn(`[worker] stalled (no progress for ${(fatalThresholdMs / 1000).toFixed(0)}s) — falling back to sync physics`);
        _teardown();
        deps.onFailure(`Worker stalled (no progress for ${(fatalThresholdMs / 1000).toFixed(0)}+ seconds)`);
      } else if (timeSinceProgress > stalledThresholdMs) {
        _stalled = true;
      }
    },

    getDebugState() {
      return {
        workerActive: !!(_bridge && _initialized),
        workerState: _bridge ? _bridge.getWorkerState() : null,
        workerStalled: _stalled,
        outstandingRequests: _bridge ? _bridge.getOutstandingRequestCount() : -1,
        hasSnapshot: _bridge ? _bridge.getLatestSnapshot() !== null : false,
        roundTripMs: _bridge ? _bridge.getRoundTripMs() : -1,
        snapshotAgeMs: _bridge ? _bridge.getSnapshotAge() : -1,
        timeSinceProgress: _progressTs > 0 ? performance.now() - _progressTs : -1,
      };
    },

    simulateStall() {
      _testFreezeProgress = true;
      _progressTs = performance.now();
    },

    setTestStalledThreshold(ms: number) {
      _testStalledThresholdMs = ms;
    },
  };
}
