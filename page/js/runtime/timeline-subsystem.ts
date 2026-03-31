/**
 * Timeline subsystem factory — single entry point for the replay/restart feature.
 *
 * Exposes a high-level interface that main.ts wires into the frame loop and
 * UI callbacks. Internal modules (orchestrator, coordinator, policy, storage)
 * are hidden behind this boundary.
 *
 * Two enable paths:
 *   - installAndEnable() — passive startup: enters ready, auto-arms on first atom interaction
 *   - startRecordingNow() — explicit button: enters active immediately with a seed frame
 */

import { createSimulationTimeline } from './simulation-timeline';
import { createTimelineRecordingPolicy, type RecordingMode } from './timeline-recording-policy';
import { createRecordingOrchestrator } from './timeline-recording-orchestrator';
import { createTimelineCoordinator, type TimelineCoordinatorDeps } from './simulation-timeline-coordinator';
import { captureRestartFrameData } from './restart-state-adapter';
import { useAppStore } from '../store/app-store';
import type { PhysicsCheckpoint } from '../../../src/types/interfaces';

export type { RecordingMode } from './timeline-recording-policy';

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
  /** Explicit enable — enters active immediately, seeds first frame from current physics.
   *  This is the user-facing "Start Recording" action. */
  startRecordingNow(): void;
  /** Disable recording — clears history, exits review, enters off state. */
  turnRecordingOff(): void;
  /** Current recording mode (off/ready/active). */
  getRecordingMode(): RecordingMode;
  /** Auto-arm on atom interaction. ready → active; no-op from off/active.
   *  Placement-only actions must NOT call this. */
  markAtomInteractionStarted(): void;
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
  /** Clear history and turn recording off (e.g. on playground clear). */
  clearAndDisarm(): void;
  /** Clear history but remain passively armed (ready). Used by scene clear
   *  so the user doesn't have to manually re-enable recording. */
  resetToPassiveReady(): void;
  /** Full teardown — clear, turn off, null store state. */
  teardown(): void;
  /** Install callbacks + enter ready state atomically (no transient off flash). */
  installAndEnable(): void;
}

export function createTimelineSubsystem(deps: TimelineSubsystemDeps): TimelineSubsystem {
  const timeline = createSimulationTimeline();
  const policy = createTimelineRecordingPolicy();

  const syncRecordingMode = () => {
    useAppStore.getState().setTimelineRecordingMode(policy.getMode());
  };

  const syncStoreState = () => {
    useAppStore.getState().updateTimelineState(timeline.getState());
    syncRecordingMode();
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

  // ── Internal helpers ──

  /** Clear timeline buffers and reset orchestrator (sim time + policy → off). */
  function resetRuntime() {
    timeline.clear();
    orchestrator.reset();
  }

  /** Publish the canonical "off / empty" store state.
   *  All off-transitions (turnOff, clearAndDisarm, teardown) converge here. */
  function publishOffState(opts: { uninstall?: boolean } = {}) {
    if (opts.uninstall) {
      useAppStore.getState().uninstallTimelineUI();
    } else {
      useAppStore.getState().setTimelineRecordingMode('off');
      useAppStore.getState().updateTimelineState({
        mode: 'live', currentTimePs: 0, reviewTimePs: null,
        rangePs: null, canReturnToLive: false, canRestart: false, restartTargetPs: null,
      });
    }
  }

  /** Seed one immediate frame + restart frame + checkpoint from current physics at time 0. */
  function seedInitialFrame() {
    const physics = deps.getPhysics();
    if (physics.n === 0) return;
    orchestrator.setSimTimePs(0);
    const rd = captureRestartFrameData(physics);
    const timePs = 0;
    timeline.recordFrame({
      timePs, n: rd.n, positions: rd.positions,
      interaction: rd.interaction, boundary: rd.boundary,
    });
    timeline.recordRestartFrame({
      timePs, n: rd.n, positions: rd.positions,
      velocities: rd.velocities, bonds: rd.bonds, config: rd.config,
      interaction: rd.interaction, boundary: rd.boundary,
    });
    timeline.recordCheckpoint({
      timePs,
      physics: physics.createCheckpoint() as PhysicsCheckpoint,
      config: rd.config,
      interaction: rd.interaction,
      boundary: rd.boundary,
    });
    syncStoreState();
  }

  /** Internal: passive enable for app startup. Not exposed as public API. */
  function enablePassiveRecording() {
    policy.turnOn();
    syncRecordingMode();
  }

  function startRecordingNow() {
    if (policy.getMode() !== 'off') return;
    policy.startNow();
    seedInitialFrame();
  }

  function turnRecordingOff() {
    if (timeline.getState().mode === 'review') coordinator.returnToLive();
    policy.turnOff();
    resetRuntime();
    publishOffState();
  }

  return {
    startRecordingNow,
    turnRecordingOff,
    getRecordingMode: () => policy.getMode(),
    markAtomInteractionStarted: () => {
      const wasBefore = policy.getMode();
      policy.markAtomInteractionStarted();
      if (wasBefore !== policy.getMode()) syncRecordingMode();
    },
    recordAfterReconciliation: (steps) => orchestrator.tick(steps),
    isInReview: () => timeline.getState().mode === 'review',
    handleScrub: (timePs) => coordinator.handleScrub(timePs),
    returnToLive: () => coordinator.returnToLive(),
    restartFromHere: () => coordinator.restartFromHere(),
    clearAndDisarm: () => {
      if (timeline.getState().mode === 'review') coordinator.returnToLive();
      resetRuntime();
      publishOffState();
    },
    resetToPassiveReady: () => {
      if (timeline.getState().mode === 'review') coordinator.returnToLive();
      resetRuntime();
      policy.turnOn();
      const store = useAppStore.getState();
      store.setTimelineRecordingMode('ready');
      store.updateTimelineState({
        mode: 'live', currentTimePs: 0, reviewTimePs: null,
        rangePs: null, canReturnToLive: false, canRestart: false, restartTargetPs: null,
      });
    },
    teardown: () => {
      resetRuntime();
      publishOffState({ uninstall: true });
    },
    installAndEnable: () => {
      policy.turnOn();
      useAppStore.getState().installTimelineUI({
        onScrub: (timePs: number) => coordinator.handleScrub(timePs),
        onReturnToLive: () => coordinator.returnToLive(),
        onRestartFromHere: () => { coordinator.restartFromHere(); },
        onStartRecordingNow: () => startRecordingNow(),
        onTurnRecordingOff: () => turnRecordingOff(),
      }, 'ready');
    },
  };
}
