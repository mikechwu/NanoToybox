/**
 * Timeline subsystem factory — single entry point for the replay/restart feature.
 *
 * Exposes a high-level interface that main.ts wires into the frame loop and
 * UI callbacks. Internal modules (orchestrator, coordinator, policy, storage)
 * are hidden behind this boundary.
 */

import { createSimulationTimeline } from './simulation-timeline';
import { createTimelineRecordingPolicy } from './timeline-recording-policy';
import { createRecordingOrchestrator } from './timeline-recording-orchestrator';
import { createTimelineCoordinator, type TimelineCoordinatorDeps } from './simulation-timeline-coordinator';
import { useAppStore } from '../store/app-store';

export interface TimelineSubsystemDeps {
  getPhysics: TimelineCoordinatorDeps['getPhysics'];
  getRenderer: TimelineCoordinatorDeps['getRenderer'];
  pause: TimelineCoordinatorDeps['pause'];
  resume: TimelineCoordinatorDeps['resume'];
  isPaused: TimelineCoordinatorDeps['isPaused'];
  reinitWorker: TimelineCoordinatorDeps['reinitWorker'];
  isWorkerActive: TimelineCoordinatorDeps['isWorkerActive'];
  forceRender: TimelineCoordinatorDeps['forceRender'];
  clearBondedGroupHighlight: TimelineCoordinatorDeps['clearBondedGroupHighlight'];
  clearRendererFeedback: TimelineCoordinatorDeps['clearRendererFeedback'];
}

/** High-level subsystem handle — main.ts should only use these methods. */
export interface TimelineSubsystem {
  /** Arm recording on first user interaction. Idempotent. */
  markUserEngaged(): void;
  /** Record after reconciliation. Pass actual completed steps, not budgeted. */
  recordAfterReconciliation(stepsReconciled: number): void;
  /** Is the simulation in review mode? */
  isInReview(): boolean;
  /** Handle scrub from UI. */
  handleScrub(timePs: number): void;
  /** Return to live from review. */
  returnToLive(): void;
  /** Restart from nearest saved state. */
  restartFromHere(): Promise<void>;
  /** Clear history and disarm recording (e.g. on playground clear). */
  clearAndDisarm(): void;
  /** Full teardown — clear, disarm, null store state. */
  teardown(): void;
  /** Register timeline callbacks in the store. */
  installStoreCallbacks(): void;
}

export function createTimelineSubsystem(deps: TimelineSubsystemDeps): TimelineSubsystem {
  const timeline = createSimulationTimeline();
  const policy = createTimelineRecordingPolicy();

  const syncStoreState = () => {
    useAppStore.getState().updateTimelineState(timeline.getState());
  };

  const orchestrator = createRecordingOrchestrator({
    timeline,
    policy,
    getPhysics: deps.getPhysics,
    syncStoreState,
    getDtFs: () => deps.getPhysics().getDtFs(),
  });

  const coordinator = createTimelineCoordinator({
    timeline,
    getPhysics: deps.getPhysics,
    getRenderer: deps.getRenderer,
    pause: deps.pause,
    resume: deps.resume,
    isPaused: deps.isPaused,
    reinitWorker: deps.reinitWorker,
    isWorkerActive: deps.isWorkerActive,
    forceRender: deps.forceRender,
    setSimTimePs: (timePs) => orchestrator.setSimTimePs(timePs),
    clearBondedGroupHighlight: deps.clearBondedGroupHighlight,
    clearRendererFeedback: deps.clearRendererFeedback,
    syncStoreState,
  });

  return {
    markUserEngaged: () => policy.markUserEngaged(),
    recordAfterReconciliation: (steps) => orchestrator.tick(steps),
    isInReview: () => timeline.getState().mode === 'review',
    handleScrub: (timePs) => coordinator.handleScrub(timePs),
    returnToLive: () => coordinator.returnToLive(),
    restartFromHere: () => coordinator.restartFromHere(),
    clearAndDisarm: () => {
      timeline.clear();
      orchestrator.reset();
      syncStoreState();
    },
    teardown: () => {
      timeline.clear();
      orchestrator.reset();
      useAppStore.getState().setTimelineCallbacks(null);
      useAppStore.getState().updateTimelineState({
        mode: 'live', currentTimePs: 0, reviewTimePs: null,
        rangePs: null, canReturnToLive: false, canRestart: false, restartTargetPs: null,
      });
    },
    installStoreCallbacks: () => {
      useAppStore.getState().setTimelineCallbacks({
        onScrub: (timePs: number) => coordinator.handleScrub(timePs),
        onReturnToLive: () => coordinator.returnToLive(),
        onRestartFromHere: () => { coordinator.restartFromHere(); },
      });
    },
  };
}
