/**
 * Camera-interaction gate — shared event-attribution logic used by
 * the Lab renderer to decide which OrbitControls events represent
 * real user camera gestures vs. programmatic updates (follow, fit,
 * cinematic framing, per-frame damping).
 *
 * The gate models three inputs coming from OrbitControls:
 *   - `start` — a pointer/wheel/pinch gesture begins.
 *   - `change` — either the user gesture is progressing OR the
 *     renderer just called `controls.update()` programmatically
 *     (the renderer cannot tell these apart at the event layer;
 *     the gate does).
 *   - `end` — the gesture released.
 *
 * It exposes:
 *   - `onStart` / `onChange` / `onEnd` — handlers to wire directly
 *     to OrbitControls.
 *   - `runSilently(fn)` — brackets programmatic `controls.update()`
 *     calls so the 'change' events they emit are NOT forwarded to
 *     user-interaction subscribers. Uses a counter so nested silent
 *     calls remain suppressed correctly.
 *   - `reset()` — test/teardown aid; forces the gate back to idle.
 *
 * Pure module — no THREE, no DOM. Kept framework-free so both
 * production (lab renderer) and unit tests use the exact same code
 * path.
 */

/** Phase of a user camera gesture. Consumers use this to track
 *  whether the gesture is currently HELD (so cooldown should stay
 *  active even without movement) or has released. */
export type CameraInteractionPhase = 'start' | 'change' | 'end';

export interface CameraInteractionGate {
  /** Wire to OrbitControls' `'start'` event. */
  onStart(): void;
  /** Wire to OrbitControls' `'change'` event. */
  onChange(): void;
  /** Wire to OrbitControls' `'end'` event. */
  onEnd(): void;
  /**
   * Execute `work` with programmatic 'change' events suppressed.
   * Returns `work`'s return value so callers can wrap an expression
   * without a temp variable.
   */
  runSilently<T>(work: () => T): T;
  /** Force the gate back to idle (no active gesture, suppress=0).
   *  Call from `destroy()` / test teardown. */
  reset(): void;
}

export function createCameraInteractionGate(
  emit: (phase: CameraInteractionPhase) => void,
): CameraInteractionGate {
  let userActive = false;
  let suppressCount = 0;

  return {
    onStart() {
      userActive = true;
      emit('start');
    },
    onChange() {
      if (suppressCount > 0) return;
      if (!userActive) return;
      emit('change');
    },
    onEnd() {
      // Emit 'end' BEFORE clearing active so subscribers can
      // distinguish "gesture released" from "still held, no motion".
      // Guard against phantom ends (no preceding 'start') which
      // OrbitControls can produce if a listener is attached
      // mid-gesture.
      if (userActive) emit('end');
      userActive = false;
    },
    runSilently<T>(work: () => T): T {
      suppressCount++;
      try {
        return work();
      } finally {
        suppressCount--;
      }
    },
    reset() {
      userActive = false;
      suppressCount = 0;
    },
  };
}
