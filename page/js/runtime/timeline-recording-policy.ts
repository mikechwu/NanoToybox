/**
 * Timeline recording policy — 3-state machine controlling recording lifecycle.
 *
 * States:
 *   off    — recording disabled, history destroyed, bar shows "History Off"
 *   ready  — recording enabled, waiting for first atom interaction (passive startup)
 *   active — recording in progress, history accumulating
 *
 * Transitions:
 *   off    → ready   via turnOn()         (passive: wait for atom interaction)
 *   off    → active  via startNow()       (explicit: user clicked Start Recording)
 *   ready  → active  via markAtomInteractionStarted()  (auto-arm on first drag)
 *   any    → off     via turnOff() or disarm()
 *
 * Two enable paths exist for different UX semantics:
 *   - turnOn()     — passive startup: enters ready, recording begins on first
 *                    atom interaction. Used by app init (installAndEnable).
 *   - startNow()   — explicit user action: enters active immediately with a
 *                    seed frame. Used by the "Start Recording" button.
 *
 * markAtomInteractionStarted() is a no-op from off (recording disabled)
 * and from active (already recording). Only ready → active is meaningful.
 *
 * The following actions do NOT arm recording:
 *   - Molecule placement (open, preview, commit)
 *   - Pause / resume
 *   - Speed changes
 *   - Physics settings (wall mode, drag/rotate strength, damping)
 *
 * Owns:        _mode state variable (off/ready/active), all transition methods
 *              (turnOn, startNow, turnOff, markAtomInteractionStarted, disarm).
 * Depends on:  nothing — pure state machine with no external dependencies.
 * Called by:   timeline-subsystem.ts (creates policy, drives transitions),
 *              timeline-recording-orchestrator.ts (reads isArmed, calls disarm).
 *              Tests: timeline-recording-policy.test.ts,
 *              timeline-recording-orchestrator.test.ts.
 * Teardown:    disarm() / turnOff() — resets _mode to 'off'. No listeners
 *              or globals.
 */

export type RecordingMode = 'off' | 'ready' | 'active';

export interface TimelineRecordingPolicy {
  /** Passive enable — off → ready. No-op from ready or active. */
  turnOn(): void;
  /** Explicit enable — off → active. No-op from ready or active. */
  startNow(): void;
  /** Disable recording — any state → off. */
  turnOff(): void;
  /** Auto-arm on atom interaction. ready → active; no-op from off or active. */
  markAtomInteractionStarted(): void;
  /** Is recording actively capturing frames? (mode === 'active') */
  isArmed(): boolean;
  /** Disable recording (alias for turnOff, used by orchestrator.reset). */
  disarm(): void;
  /** Current state machine mode. */
  getMode(): RecordingMode;
}

export function createTimelineRecordingPolicy(): TimelineRecordingPolicy {
  let _mode: RecordingMode = 'off';

  return {
    turnOn() { if (_mode === 'off') _mode = 'ready'; },
    startNow() { if (_mode === 'off') _mode = 'active'; },
    turnOff() { _mode = 'off'; },
    markAtomInteractionStarted() { if (_mode === 'ready') _mode = 'active'; },
    isArmed() { return _mode === 'active'; },
    disarm() { _mode = 'off'; },
    getMode() { return _mode; },
  };
}
