/**
 * Timeline recording policy — controls when history recording is active.
 *
 * Recording stays disarmed until the first direct atom interaction
 * (drag, move, rotate, flick). This prevents idle sessions from
 * allocating history buffers.
 *
 * The following actions do NOT arm recording:
 *   - Molecule placement (open, preview, commit)
 *   - Pause / resume
 *   - Speed changes
 *   - Physics settings (wall mode, drag/rotate strength, damping)
 *
 * The createInteractionDispatch function calls markAtomInteractionStarted()
 * unconditionally (not gated by isWorkerActive) when dispatching atom
 * interaction commands (startDrag, startMove, startRotate, flick). This
 * fires whether or not the worker is active, so both worker and sync/local
 * modes arm recording on atom interaction. Arming is idempotent, so only
 * the first call in an interaction sequence matters.
 *
 * Usage:
 *   - Call markAtomInteractionStarted() ONLY from atom interaction paths
 *   - Call isArmed() in the frame loop before recording
 *   - Call disarm() on clear/reset
 *
 * This is the single ownership point for the arming policy. New action
 * paths must NOT call markAtomInteractionStarted() unless they represent
 * a direct user interaction with atoms in the scene.
 */

export interface TimelineRecordingPolicy {
  /** Arm recording on first atom interaction. Idempotent. */
  markAtomInteractionStarted(): void;
  /** Is recording currently armed? */
  isArmed(): boolean;
  /** Disarm recording (e.g. on clear/reset). */
  disarm(): void;
}

export function createTimelineRecordingPolicy(): TimelineRecordingPolicy {
  let _armed = false;

  return {
    markAtomInteractionStarted() { _armed = true; },
    isArmed() { return _armed; },
    disarm() { _armed = false; },
  };
}
