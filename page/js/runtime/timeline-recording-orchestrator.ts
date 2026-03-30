/**
 * Timeline recording orchestrator — owns frame/checkpoint recording from
 * authoritative simulation state.
 *
 * IMPORTANT: tick() must be called AFTER snapshot reconciliation has applied
 * the worker snapshot to physics.pos/vel. The stepsReconciled parameter must
 * reflect ACTUALLY COMPLETED steps (from worker snapshot or local stepping),
 * NOT the requested/budgeted substep count. This prevents sim time from
 * advancing faster than positions, which caused frame discontinuities.
 *
 * Does NOT own: review mode, restart flow, UI state, renderer updates.
 */

import type { SimulationTimeline } from './simulation-timeline';
import type { TimelineRecordingPolicy } from './timeline-recording-policy';
import { captureRestartFrameData } from './restart-state-adapter';
import type { PhysicsEngine } from '../physics';
import type { PhysicsCheckpoint } from '../../../src/types/interfaces';

export interface RecordingOrchestratorDeps {
  timeline: SimulationTimeline;
  policy: TimelineRecordingPolicy;
  getPhysics: () => PhysicsEngine;
  syncStoreState: () => void;
  /** Get authoritative timestep in femtoseconds from the engine. */
  getDtFs: () => number;
}

export interface TimelineRecordingOrchestrator {
  /** Call once per frame loop tick AFTER reconciliation.
   *  @param stepsReconciled — actual steps applied this tick (from snapshot or local stepping). */
  tick(stepsReconciled: number): void;
  getSimTimePs(): number;
  setSimTimePs(timePs: number): void;
  reset(): void;
}

export function createRecordingOrchestrator(deps: RecordingOrchestratorDeps): TimelineRecordingOrchestrator {
  let _simTimePs = 0;

  function tick(stepsReconciled: number): void {
    const { timeline, policy } = deps;
    if (!policy.isArmed()) return;
    if (timeline.getState().mode !== 'live') return;

    const physics = deps.getPhysics();
    if (physics.n === 0 || stepsReconciled === 0) return;

    // Design note: sim time only advances while armed. Pre-arming ticks
    // (idle simulation, molecule placements) do not accumulate time, so the
    // first recorded frame reflects only post-interaction physics — not
    // elapsed wall time before the user touched an atom. This is intentional:
    // history begins on the first post-arming simulation step.
    //
    // Advance sim time by ACTUAL completed steps.
    // Each stepOnce() advances by dtFs femtoseconds; convert to picoseconds.
    _simTimePs += stepsReconciled * deps.getDtFs() / 1000;

    if (timeline.shouldRecordFrame()) {
      const rd = captureRestartFrameData(physics);

      timeline.recordFrame({
        timePs: _simTimePs, n: rd.n, positions: rd.positions,
        interaction: rd.interaction, boundary: rd.boundary,
      });

      timeline.recordRestartFrame({
        timePs: _simTimePs, n: rd.n, positions: rd.positions,
        velocities: rd.velocities, bonds: rd.bonds, config: rd.config,
        interaction: rd.interaction, boundary: rd.boundary,
      });

      deps.syncStoreState();
    }

    if (timeline.shouldRecordCheckpoint()) {
      const rd = captureRestartFrameData(physics);
      timeline.recordCheckpoint({
        timePs: _simTimePs,
        physics: physics.createCheckpoint() as PhysicsCheckpoint,
        config: rd.config,
        interaction: rd.interaction,
        boundary: rd.boundary,
      });
    }
  }

  return {
    tick,
    getSimTimePs: () => _simTimePs,
    setSimTimePs: (timePs: number) => { _simTimePs = timePs; },
    reset: () => { _simTimePs = 0; deps.policy.disarm(); },
  };
}
