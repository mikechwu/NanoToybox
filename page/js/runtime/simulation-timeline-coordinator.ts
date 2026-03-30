/**
 * Simulation timeline coordinator — orchestrates review and restart flows
 * across timeline runtime, worker runtime, snapshot reconciler, renderer, and store.
 *
 * This module exists because review/restart touches multiple subsystems that
 * should not know about each other directly.
 */

import type { SimulationTimeline, TimelineFrame } from './simulation-timeline';
import type { PhysicsEngine } from '../physics';
import type { Renderer } from '../renderer';
import { applyRestartState } from './restart-state-adapter';


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
}

export interface TimelineCoordinator {
  handleScrub(timePs: number): void;
  enterReview(timePs: number): void;
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
    renderer.updateReviewFrame(frame.positions, frame.n);
    deps.forceRender();
  }

  function enterReview(timePs: number): void {
    _wasPausedBeforeReview = deps.isPaused();
    if (!deps.isPaused()) deps.pause();

    // Clear all interactive visual state — review is display-only.
    // Live highlights would appear against historical positions and be misleading.
    deps.clearBondedGroupHighlight();
    deps.clearRendererFeedback();

    const frame = deps.timeline.enterReview(timePs);
    if (frame) applyReviewFrame(frame);
    deps.syncStoreState();
  }

  function scrubTo(timePs: number): void {
    const frame = deps.timeline.scrubTo(timePs);
    if (frame) applyReviewFrame(frame);
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

  return {
    handleScrub,
    enterReview,
    scrubTo,
    returnToLive,
    restartFromHere,
  };
}
