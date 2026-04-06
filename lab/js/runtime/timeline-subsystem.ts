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
 *
 * Owns:        SimulationTimeline instance, TimelineRecordingPolicy instance,
 *              RecordingOrchestrator instance, TimelineCoordinator instance,
 *              store sync helpers (syncStoreState, publishOffState),
 *              installAndEnable / teardown lifecycle.
 * Depends on:  simulation-timeline (frame storage), timeline-recording-policy,
 *              timeline-recording-orchestrator, simulation-timeline-coordinator,
 *              restart-state-adapter (captureRestartFrameData for seed frames),
 *              app-store (timeline UI state, recording mode, install/uninstall).
 * Called by:   main.ts (creates subsystem, wires into UI events);
 *              app/frame-runtime.ts (recordAfterReconciliation, isInReview, per-frame).
 *              Tests: timeline-subsystem.test.ts, store-callbacks-arming.test.ts,
 *              timeline-arming-wiring.test.ts.
 * Teardown:    teardown() — clears timeline buffers, resets orchestrator,
 *              uninstalls timeline UI from store.
 */

import { createSimulationTimeline } from './simulation-timeline';
import { createTimelineRecordingPolicy, type RecordingMode } from './timeline-recording-policy';
import { createRecordingOrchestrator } from './timeline-recording-orchestrator';
import { createTimelineCoordinator, type TimelineCoordinatorDeps } from './simulation-timeline-coordinator';
import { captureRestartFrameData } from './restart-state-adapter';
import { createTimelineAtomIdentityTracker } from './timeline-atom-identity';
import { createAtomMetadataRegistry } from './atom-metadata-registry';
import { useAppStore } from '../store/app-store';
import type { PhysicsCheckpoint } from '../../../src/types/interfaces';

export type { RecordingMode } from './timeline-recording-policy';

/** Narrow molecule shape the subsystem needs for export atom-state rehydration. */
export interface TimelineSceneMolecule {
  atomOffset: number;
  atomCount: number;
  localAtoms: { element: string }[];
  structureFile: string;
  name: string;
}

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
  syncBondedGroupsForDisplayFrame: TimelineCoordinatorDeps['syncBondedGroupsForDisplayFrame'];
  /** Current scene molecules — for rebuilding export atom state on recording restart. */
  getSceneMolecules: () => TimelineSceneMolecule[];
  /** Export dependency — only injected when export is implemented. */
  exportHistory?: (kind: 'replay' | 'full') => Promise<void> | void;
  exportCapabilities?: { replay: boolean; full: boolean };
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
  /** Compute connected components from historical bond topology at the review time. */
  getReviewBondedGroupComponents(timePs: number): { atomCount: number; components: { atoms: number[]; size: number }[] } | null;
  /** Get bonded-group components for the current review frame (from internal timeline state, not store).
   *  Returns null when not in review mode. */
  getCurrentReviewBondedGroupComponents(): { atomCount: number; components: { atoms: number[]; size: number }[] } | null;
  /** Atom identity tracker — for scene-runtime append hooks and export. */
  getAtomIdentityTracker(): import('./timeline-atom-identity').TimelineAtomIdentityTracker;
  /** Atom metadata registry — for export. */
  getAtomMetadataRegistry(): import('./atom-metadata-registry').AtomMetadataRegistry;
  /** Export snapshot of the timeline — cloned, safe to serialize. */
  getTimelineExportSnapshot(): ReturnType<import('./simulation-timeline').SimulationTimeline['getExportSnapshot']>;
  /** Mark atom identity as potentially stale (worker compaction without keep[] mapping).
   *  Disables export capability until a clean reset. */
  markIdentityStale(): void;
  /** Check if atom identity may be stale (worker compaction without keep[] mapping). */
  isIdentityStale(): boolean;
}

export function createTimelineSubsystem(deps: TimelineSubsystemDeps): TimelineSubsystem {
  const timeline = createSimulationTimeline();
  const policy = createTimelineRecordingPolicy();

  // ── Export capability lifecycle ──
  // Single source of truth: derived from deps + staleness flag.
  let _identityMayBeStale = false;

  function currentExportCapability() {
    const hasExport = !!(deps.exportHistory && deps.exportCapabilities);
    return hasExport && !_identityMayBeStale ? deps.exportCapabilities! : null;
  }

  function syncExportCapability() {
    useAppStore.getState().setTimelineExportCapabilities(currentExportCapability());
  }

  function setIdentityStale() {
    _identityMayBeStale = true;
    syncExportCapability();
  }

  function clearIdentityStaleness() {
    _identityMayBeStale = false;
    // Does NOT call syncExportCapability — caller decides when to restore.
  }

  const syncRecordingMode = () => {
    useAppStore.getState().setTimelineRecordingMode(policy.getMode());
  };

  const syncStoreState = () => {
    useAppStore.getState().updateTimelineState(timeline.getState());
    syncRecordingMode();
  };

  // Atom identity tracking for export
  const atomIdentityTracker = createTimelineAtomIdentityTracker();
  const atomMetadataRegistry = createAtomMetadataRegistry();

  // Wire compaction listener from physics to identity tracker
  const physics = deps.getPhysics();
  if (typeof (physics as any).setCompactionListener === 'function') {
    (physics as any).setCompactionListener((keep: number[]) => {
      atomIdentityTracker.handleCompaction(keep);
    });
  }

  const orchestrator = createRecordingOrchestrator({
    timeline,
    policy,
    getPhysics: deps.getPhysics,
    syncStoreState,
    getDtFs: () => deps.getPhysics().getDtFs(),
    captureAtomIds: (n: number) => atomIdentityTracker.captureForCurrentState(n),
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
    syncBondedGroupsForDisplayFrame: deps.syncBondedGroupsForDisplayFrame,
    syncStoreState,
  });

  // ── Internal helpers ──

  /** Clear timeline buffers and reset orchestrator (sim time + policy → off). */
  function resetRuntime() {
    timeline.clear();
    orchestrator.reset();
    atomIdentityTracker.reset();
    atomMetadataRegistry.reset();
    clearIdentityStaleness();
  }

  /** Rebuild identity tracker + metadata registry from current scene molecules.
   *  Must be called as a pair — never rebuild one without the other.
   *  Asserts dense-prefix layout: contiguous offsets, atomCount === localAtoms.length. */
  function rebuildExportAtomState() {
    atomIdentityTracker.reset();
    atomMetadataRegistry.reset();
    const sorted = [...deps.getSceneMolecules()].sort((a, b) => a.atomOffset - b.atomOffset);
    let expectedOffset = 0;
    for (const mol of sorted) {
      if (mol.atomOffset !== expectedOffset) {
        throw new Error(`rebuildExportAtomState: non-contiguous offset at "${mol.name}" (expected ${expectedOffset}, got ${mol.atomOffset})`);
      }
      if (mol.localAtoms.length !== mol.atomCount) {
        throw new Error(`rebuildExportAtomState: atomCount mismatch for "${mol.name}" (atomCount=${mol.atomCount}, localAtoms.length=${mol.localAtoms.length})`);
      }
      const ids = atomIdentityTracker.handleAppend(mol.atomOffset, mol.atomCount);
      atomMetadataRegistry.registerAppendedAtoms(
        ids,
        mol.localAtoms.map(a => ({ element: a.element })),
        { file: mol.structureFile, label: mol.name },
      );
      expectedOffset += mol.atomCount;
    }
  }

  /** Publish the canonical "off / empty" store state.
   *  All off-transitions (turnOff, clearAndDisarm, teardown) converge here. */
  function publishOffState(opts: { uninstall?: boolean } = {}) {
    if (opts.uninstall) {
      useAppStore.getState().uninstallTimelineUI();
    } else {
      useAppStore.getState().publishTimelineOffState();
    }
  }

  /** Seed one immediate frame + restart frame + checkpoint from current physics at time 0. */
  function seedInitialFrame() {
    const physics = deps.getPhysics();
    if (physics.n === 0) return;
    orchestrator.setSimTimePs(0);
    const rd = captureRestartFrameData(physics);
    const timePs = 0;
    const atomIds = atomIdentityTracker.captureForCurrentState(rd.n);
    timeline.recordFrame({
      timePs, n: rd.n, atomIds: atomIds.slice(), positions: rd.positions,
      interaction: rd.interaction, boundary: rd.boundary,
    });
    timeline.recordRestartFrame({
      timePs, n: rd.n, atomIds: atomIds.slice(), positions: rd.positions,
      velocities: rd.velocities, bonds: rd.bonds, config: rd.config,
      interaction: rd.interaction, boundary: rd.boundary,
    });
    timeline.recordCheckpoint({
      timePs, atomIds: atomIds.slice(),
      physics: physics.createCheckpoint() as PhysicsCheckpoint,
      config: rd.config,
      interaction: rd.interaction,
      boundary: rd.boundary,
    });
    syncStoreState();
  }

  /** Try to rebuild export atom state; on failure, reset to clean empty state
   *  and mark stale to durably disable export. */
  function tryRebuildExportAtomState() {
    try {
      rebuildExportAtomState();
    } catch (err) {
      console.error('[timeline-subsystem] export atom state rebuild failed:', err);
      // Restore clean state — partial rebuild left tracker/registry inconsistent
      atomIdentityTracker.reset();
      atomMetadataRegistry.reset();
      setIdentityStale();
      useAppStore.getState().setStatusText('Export disabled: scene atom metadata is inconsistent.');
    }
  }

  function startRecordingNow() {
    if (policy.getMode() !== 'off') return;
    tryRebuildExportAtomState();
    policy.startNow();
    seedInitialFrame();
    syncExportCapability();
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
      if (wasBefore !== policy.getMode()) {
        // ready → active: rebuild export atom state for existing scene atoms
        if (wasBefore === 'ready') tryRebuildExportAtomState();
        syncRecordingMode();
        syncExportCapability();
      }
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
      useAppStore.getState().publishTimelineReadyState();
      syncExportCapability();
    },
    teardown: () => {
      resetRuntime();
      publishOffState({ uninstall: true });
    },
    installAndEnable: () => {
      policy.turnOn();
      const hasExport = !!(deps.exportHistory && deps.exportCapabilities);
      useAppStore.getState().installTimelineUI({
        onScrub: (timePs: number) => coordinator.handleScrub(timePs),
        onReturnToLive: () => coordinator.returnToLive(),
        onEnterReview: () => coordinator.enterReviewAtCurrentTime(),
        onRestartFromHere: () => { coordinator.restartFromHere(); },
        onStartRecordingNow: () => startRecordingNow(),
        onTurnRecordingOff: () => turnRecordingOff(),
        ...(hasExport ? { onExportHistory: (kind: 'replay' | 'full') => deps.exportHistory!(kind) } : {}),
      }, 'ready', currentExportCapability());
    },
    getReviewBondedGroupComponents: (timePs) => timeline.getReviewBondedGroupComponents(timePs),
    getCurrentReviewBondedGroupComponents: () => {
      const state = timeline.getState();
      if (state.mode !== 'review') return null;
      const reviewFrame = timeline.getCurrentReviewFrame();
      if (!reviewFrame) return null;
      return timeline.getReviewBondedGroupComponents(reviewFrame.timePs);
    },
    getAtomIdentityTracker: () => atomIdentityTracker,
    getAtomMetadataRegistry: () => atomMetadataRegistry,
    getTimelineExportSnapshot: () => timeline.getExportSnapshot(),
    markIdentityStale: () => setIdentityStale(),
    isIdentityStale: () => _identityMayBeStale,
  };
}
