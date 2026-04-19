/**
 * Simulation timeline coordinator — orchestrates review and restart flows
 * across timeline runtime, worker runtime, snapshot reconciler, renderer, and store.
 *
 * This module exists because review/restart touches multiple subsystems that
 * should not know about each other directly.
 *
 * Owns:        review-enter/scrub/return-to-live/restart-from-here flows,
 *              _wasPausedBeforeReview flag, _isRestarting guard.
 * Depends on:  SimulationTimeline (frame storage, review state),
 *              PhysicsEngine and Renderer (via deps), restart-state-adapter
 *              (applyRestartState for physics restore on restart).
 * Called by:   timeline-subsystem.ts (sole consumer, wires coordinator into
 *              subsystem facade and store callbacks).
 * Teardown:    stateless closure — no teardown needed. Lifetime tied to the
 *              enclosing TimelineSubsystem.
 */

import type { SimulationTimeline, TimelineFrame } from './simulation-timeline';
import type { PhysicsEngine } from '../../physics';
import type { Renderer } from '../../renderer';
import { applyRestartState } from './restart-state-adapter';
import type { MirroredPhysicsConfig } from '../physics-config-store-sync';


export interface TimelineCoordinatorDeps {
  timeline: SimulationTimeline;
  getPhysics: () => PhysicsEngine;
  getRenderer: () => Renderer;
  pause: () => void;
  resume: () => void;
  isPaused: () => boolean;
  reinitWorker: () => Promise<void>;
  isWorkerActive: () => boolean;
  forceRender: () => void;
  syncStoreState: () => void;
  setSimTimePs: (timePs: number) => void;
  /** Clear bonded-group highlight so review doesn't show stale live highlights. */
  clearBondedGroupHighlight: () => void;
  /** Clear all visual feedback (hover highlight, force line) from the renderer. */
  clearRendererFeedback: () => void;
  /** Refresh bonded-group projection + highlight for the current display frame. */
  syncBondedGroupsForDisplayFrame: () => void;
  /** Push restored physics config (damping + drag/rotate strengths) into
   *  the Zustand store so the Settings sheet reflects the restart-frame
   *  values. Invoked once per restart-from-here, immediately after
   *  `applyRestartState` writes to the physics engine. Injected (not
   *  imported) so tests can stub without mounting the real store. */
  syncPhysicsConfigToStore: (config: MirroredPhysicsConfig) => void;
}

export interface TimelineCoordinator {
  handleScrub(timePs: number): void;
  enterReview(timePs: number): void;
  enterReviewAtCurrentTime(): void;
  scrubTo(timePs: number): void;
  returnToLive(): void;
  restartFromHere(): Promise<void>;
}

export function createTimelineCoordinator(deps: TimelineCoordinatorDeps): TimelineCoordinator {
  let _wasPausedBeforeReview = false;
  let _isRestarting = false;

  function applyReviewFrame(frame: TimelineFrame): void {
    const renderer = deps.getRenderer();
    if (frame.n !== renderer.getAtomCount()) {
      renderer.setAtomCount(frame.n);
    }
    // Resolve historical bond topology for the reviewed time (empty = no bonds visible)
    const reviewBonds = deps.timeline.getReviewBondTopology(frame.timePs) ?? [];
    renderer.updateReviewFrame(frame.positions, frame.n, reviewBonds);
    deps.forceRender();
  }

  function enterReview(timePs: number): void {
    _wasPausedBeforeReview = deps.isPaused();
    if (!deps.isPaused()) deps.pause();

    // Clear live interaction feedback (Move/Rotate forces, hover indicators).
    // Bonded-group highlight is cleared to reset stale live-topology selections.
    // Users can re-select from review-projected groups after entering review.
    deps.clearBondedGroupHighlight();
    deps.clearRendererFeedback();

    const frame = deps.timeline.enterReview(timePs);
    if (frame) applyReviewFrame(frame);
    // Re-project bonded groups from the review frame's topology
    deps.syncBondedGroupsForDisplayFrame();
    deps.syncStoreState();
  }

  function scrubTo(timePs: number): void {
    const frame = deps.timeline.scrubTo(timePs);
    if (frame) applyReviewFrame(frame);
    // Re-project bonded groups for the new scrub position
    deps.syncBondedGroupsForDisplayFrame();
    deps.syncStoreState();
  }

  function returnToLive(): void {
    deps.timeline.returnToLive();

    const physics = deps.getPhysics();
    const renderer = deps.getRenderer();
    if (physics.n !== renderer.getAtomCount()) {
      renderer.setAtomCount(physics.n);
    }
    if (physics.n > 0 && physics.pos) {
      renderer.updateFromSnapshot(physics.pos.subarray(0, physics.n * 3), physics.n);
    }

    if (!_wasPausedBeforeReview && deps.isPaused()) deps.resume();
    _wasPausedBeforeReview = false;

    // Re-project bonded groups from live physics (display source now resolves live)
    deps.syncBondedGroupsForDisplayFrame();
    deps.forceRender();
    deps.syncStoreState();
  }

  async function restartFromHere(): Promise<void> {
    if (_isRestarting) return;
    _isRestarting = true;
    try {
      const timeline = deps.timeline;
      const state = timeline.getState();
      if (state.reviewTimePs === null) return;

      // Get the single authoritative RestartState from the timeline.
      // This is the shared contract between storage, main-thread restore, and worker restore.
      const rs = timeline.getRestartState(state.reviewTimePs);
      if (!rs) return;

      const physics = deps.getPhysics();
      const renderer = deps.getRenderer();

      // 1-2. Restore full physics state via the shared adapter
      applyRestartState(physics, rs);
      // 2a. Mirror the restored config into the store so the Settings
      //     sheet's damping/drag/rotate sliders reflect the restart-
      //     frame values instead of their pre-restart positions.
      //     See physics-config-store-sync.ts for the contract.
      deps.syncPhysicsConfigToStore(rs.config);
      deps.setSimTimePs(rs.timePs);

      // 3. Truncate history after restart point — maintains monotonic timeline
      timeline.truncateAfter(rs.timePs);

      // 4. Update renderer from restored physics
      if (physics.n !== renderer.getAtomCount()) {
        renderer.setAtomCount(physics.n);
      }
      renderer.setPhysicsRef(physics);
      if (physics.n > 0 && physics.pos) {
        renderer.updateFromSnapshot(physics.pos.subarray(0, physics.n * 3), physics.n);
      }

      // 5. Reinitialize worker with the same restored state
      //    (reinitWorker reads from physics which now holds the RestartState)
      if (deps.isWorkerActive()) {
        await deps.reinitWorker();
      }

      // 6. Exit review mode and resume
      timeline.returnToLive();
      _wasPausedBeforeReview = false;
      if (deps.isPaused()) deps.resume();

      deps.syncBondedGroupsForDisplayFrame();
      deps.forceRender();
      deps.syncStoreState();
    } finally {
      _isRestarting = false;
    }
  }

  function handleScrub(timePs: number): void {
    const state = deps.timeline.getState();
    if (state.mode === 'live') {
      enterReview(timePs);
    } else {
      scrubTo(timePs);
    }
  }

  function enterReviewAtCurrentTime(): void {
    const currentTimePs = deps.timeline.getState().currentTimePs;
    enterReview(currentTimePs);
  }

  return {
    handleScrub,
    enterReview,
    enterReviewAtCurrentTime,
    scrubTo,
    returnToLive,
    restartFromHere,
  };
}
