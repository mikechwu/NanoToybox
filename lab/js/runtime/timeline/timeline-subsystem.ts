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
import { syncPhysicsConfigToStore } from '../physics-config-store-sync';
import { createTimelineAtomIdentityTracker } from './timeline-atom-identity';
import { createAtomMetadataRegistry } from './atom-metadata-registry';
import { useAppStore } from '../../store/app-store';
import type { PhysicsCheckpoint } from '../../../../src/types/interfaces';
import type {
  CapsuleFrameIndex,
  CapsuleSelectionRange,
  CapsuleSnapshotId,
  PreparedCapsuleSummary,
} from './capsule-publish-types';
import type { BondedGroupAppearanceRuntime } from '../bonded-groups/bonded-group-appearance-runtime';
// NOTE: any future runtime bond-policy edit path MUST own a
// getPolicyVersion() counter and feed it into the combined snapshot
// string tuple below. Today `buildExportBondPolicy()` is a pure
// function over static BOND_DEFAULTS, so the policy slot is the
// constant `0`.

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
  /** Sync appearance overrides + renderer after assignment cleanup. */
  syncAppearance?: () => void;
  /** Export dependency — only injected when export is implemented. */
  exportHistory?: (kind: 'full' | 'capsule') => Promise<'saved' | 'picker-cancelled'>;
  /** Estimate dependency — returns formatted size strings for both export kinds. */
  getExportEstimates?: () => { capsule: string | null; full: string | null };
  exportCapabilities?: { full: boolean; capsule: boolean };
  /** Publish dependency — publishes a capsule to cloud storage and returns share info.
   *  `warnings` carries non-fatal server-reported issues (e.g. quota-accounting
   *  drift) that the UI should surface subtly without blocking the share. */
  publishCapsule?: () => Promise<{ shareCode: string; shareUrl: string; warnings?: string[] }>;
  /** Bonded-group appearance runtime. Owner of appearanceVersion bumps
   *  on color-assignment writes. Optional for back-compat with tests
   *  that construct the subsystem with a minimal dep set; when absent,
   *  the appearance slot in the capsule snapshot id is the constant
   *  `0` and the post-rebuild cleanup falls back to the direct-setState
   *  path (with a diagnostic warn). */
  bondedGroupAppearance?: BondedGroupAppearanceRuntime;
  /** Trim-mode publisher. When provided, the subsystem exposes
   *  prepare/publish/cancel through the installed TimelineCallbacks so
   *  TimelineBar can drive the two-phase submit. `main.ts` constructs
   *  one publisher at boot and passes its three operations here. */
  prepareCapsulePublish?: (range: CapsuleSelectionRange) => Promise<PreparedCapsuleSummary>;
  publishPreparedCapsule?: (prepareId: string) => Promise<{ shareCode: string; shareUrl: string; warnings?: string[] }>;
  cancelPreparedPublish?: (prepareId: string) => void;
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
  /** Lightweight capsule frame index + combined snapshotId. Returns
   *  null when capsule publish is not viable for this instant (no
   *  export capability, identity stale, empty timeline). Used by the
   *  TimelineBar trim-mode UI. */
  getCapsuleFrameIndex(): CapsuleFrameIndex | null;
  /** Combined capsule export input version. Read by the publisher
   *  directly (bypassing React) during the pre-POST staleness recheck. */
  getCapsuleExportInputVersion(): CapsuleSnapshotId;
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
    syncPhysicsConfigToStore,
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

  /** Try to rebuild export atom state. On success, clear staleness and restore
   *  export capability. On failure, reset to clean empty state and mark stale. */
  const STALE_EXPORT_STATUS = 'Export disabled: scene atom metadata is inconsistent.';

  function tryRebuildExportAtomState() {
    // One try-block wraps BOTH the rebuild and the post-rebuild
    // appearance cleanup. If the cleanup at the bottom of the try
    // throws (e.g. a renderer goes missing between frames), the
    // catch below resets the tracker + registry and re-sets
    // identity-staleness — undoing the `clearIdentityStaleness` /
    // `syncExportCapability` that ran earlier in the try. Net
    // outcome on cleanup failure: registry stays clean, export
    // capability is gated off, status text surfaces the reason.
    try {
      rebuildExportAtomState();
      clearIdentityStaleness();
      syncExportCapability();
      const currentStatus = useAppStore.getState().statusText;
      if (currentStatus === STALE_EXPORT_STATUS) {
        useAppStore.getState().setStatusText(null);
      }
      const assignments = useAppStore.getState().bondedGroupColorAssignments;
      const clean = assignments.filter(a => a.atomIds.length > 0 && a.atomIds.every(id => id >= 0));
      if (clean.length !== assignments.length) {
        // Route the cleanup through the appearance runtime so the
        // capsule appearance-version counter bumps uniformly. A direct
        // `useAppStore.setState({ bondedGroupColorAssignments: clean })`
        // would bypass writeAssignments and strand any active trim
        // session on a snapshotId that looks unchanged.
        if (deps.bondedGroupAppearance) {
          // `restoreAssignments` routes through the same
          // `writeAssignments` bump point every other mutator uses,
          // so the capsule appearance-version counter moves
          // uniformly. The method name matches the "install a
          // snapshotted list" intent.
          deps.bondedGroupAppearance.restoreAssignments(clean);
        } else {
          console.warn('[timeline-subsystem] bondedGroupAppearance dep missing; falling back to direct setState (appearance version not bumped).');
          useAppStore.setState({ bondedGroupColorAssignments: clean });
          deps.syncAppearance?.();
        }
      }
    } catch (err) {
      console.error('[timeline-subsystem] export atom state rebuild failed:', err);
      atomIdentityTracker.reset();
      atomMetadataRegistry.reset();
      setIdentityStale();
      useAppStore.getState().setStatusText(STALE_EXPORT_STATUS);
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

  // ── Capsule snapshot id composition ──
  //
  // Concatenate per-component monotonic counters into a string tuple
  // (never sum, never hash — sums collide when resets happen, hashes
  // collide on content, string equality is exact and cheap). The
  // policy slot is the constant 0 in v1 — add a getPolicyVersion()
  // counter if any runtime bond-policy edit path ships in the future.
  function getCapsuleExportInputVersion(): CapsuleSnapshotId {
    const frameV = timeline.getCapsuleSnapshotVersion();
    const metaV = atomMetadataRegistry.getMetadataVersion();
    const appearanceV = deps.bondedGroupAppearance?.getAppearanceVersion() ?? 0;
    return `${frameV}:${metaV}:${appearanceV}:0`;
  }

  function getCapsuleFrameIndex(): CapsuleFrameIndex | null {
    // Gate matches `buildExportArtifact('capsule')` in main.ts so the
    // trim UI can never open when capsule publish would not be viable.
    if (!currentExportCapability()?.capsule) return null;
    if (_identityMayBeStale) return null;
    const snapshot = timeline.getExportSnapshot();
    if (snapshot.denseFrames.length === 0) return null;
    const frames = snapshot.denseFrames.map((f) => ({ frameId: f.frameId, timePs: f.timePs }));
    return {
      snapshotId: getCapsuleExportInputVersion(),
      frames,
    };
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
      tryRebuildExportAtomState();
      useAppStore.getState().publishTimelineReadyState();
      syncExportCapability();
    },
    teardown: () => {
      resetRuntime();
      publishOffState({ uninstall: true });
    },
    installAndEnable: () => {
      policy.turnOn();
      tryRebuildExportAtomState();
      const hasExport = !!(deps.exportHistory && deps.exportCapabilities);
      useAppStore.getState().installTimelineUI({
        onScrub: (timePs: number) => coordinator.handleScrub(timePs),
        onReturnToLive: () => coordinator.returnToLive(),
        onEnterReview: () => coordinator.enterReviewAtCurrentTime(),
        onRestartFromHere: () => { coordinator.restartFromHere(); },
        onStartRecordingNow: () => startRecordingNow(),
        onTurnRecordingOff: () => turnRecordingOff(),
        ...(hasExport ? { onExportHistory: (kind: 'full' | 'capsule') => deps.exportHistory!(kind) } : {}),
        onPauseForExport: () => {
          if (!deps.isPaused()) { deps.pause(); return true; }
          return false;
        },
        onResumeFromExport: () => { deps.resume(); },
        ...(deps.getExportEstimates ? { getExportEstimates: () => deps.getExportEstimates!() } : {}),
        ...(deps.publishCapsule ? { onPublishCapsule: () => deps.publishCapsule!() } : {}),
        getCapsuleFrameIndex: () => getCapsuleFrameIndex(),
        ...(deps.prepareCapsulePublish
          ? { onPrepareCapsulePublish: (range: CapsuleSelectionRange) => deps.prepareCapsulePublish!(range) }
          : {}),
        ...(deps.publishPreparedCapsule
          ? { onPublishPreparedCapsule: (prepareId: string) => deps.publishPreparedCapsule!(prepareId) }
          : {}),
        ...(deps.cancelPreparedPublish
          ? { onCancelPreparedPublish: (prepareId: string) => deps.cancelPreparedPublish!(prepareId) }
          : {}),
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
    getCapsuleFrameIndex,
    getCapsuleExportInputVersion,
  };
}
