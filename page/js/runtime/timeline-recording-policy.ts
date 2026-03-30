/**
 * Timeline recording policy — controls when history recording is active.
 *
 * Recording stays disarmed until the first user action that changes
 * simulation behavior. This prevents idle sessions from allocating
 * history buffers.
 *
 * Usage:
 *   - Call markUserEngaged() from any user-driven action that changes
 *     the simulation trajectory (drag, pause, settings change, etc.)
 *   - Call isArmed() in the frame loop before recording
 *   - Call disarm() on clear/reset
 *
 * This is the single ownership point for the arming policy. New user
 * action paths should call markUserEngaged() here instead of scattering
 * arming calls across main.ts.
 */

export interface TimelineRecordingPolicy {
  /** Arm recording. Idempotent — safe to call on every interaction. */
  markUserEngaged(): void;
  /** Is recording currently armed? */
  isArmed(): boolean;
  /** Disarm recording (e.g. on clear/reset). */
  disarm(): void;
}

export function createTimelineRecordingPolicy(): TimelineRecordingPolicy {
  let _armed = false;

  return {
    markUserEngaged() { _armed = true; },
    isArmed() { return _armed; },
    disarm() { _armed = false; },
  };
}
