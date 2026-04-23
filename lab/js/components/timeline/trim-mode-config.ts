/**
 * Trim-mode configuration — user-visible policy constants for the
 * Capsule Publish trim UX.
 *
 * These values are product decisions, not local component details.
 * Future tuning should happen here with review, not as inline
 * edits inside TimelineBar.tsx.
 */

import { MAX_PUBLISH_BYTES } from '../../../../src/share/constants';

/**
 * Soft client-side target for the chunked suffix search during trim
 * entry. The search bisects dense-frame start indices to find the
 * widest suffix that serializes under this value. Set BELOW the hard
 * `MAX_PUBLISH_BYTES` so there is headroom for subsequent manual
 * drag adjustments without flipping into the `over-limit` branch.
 *
 * 95% chosen because:
 *   · the full capsule `exportedAt` timestamp and minor atom-count
 *     variations between frames can drift the serialized size by a
 *     few hundred bytes between prepare runs.
 *   · a range measured at 100% of the cap could cross the cap on a
 *     subsequent recordFrame adding a new dense frame mid-trim.
 *   · leaves room for a user drag to widen the range slightly
 *     without the status pill flashing "over limit" for a value
 *     that still publishes.
 */
export const TRIM_TARGET_BYTES = Math.floor(MAX_PUBLISH_BYTES * 0.95);

/**
 * Hard cap on bisect iterations during the entry-time default-
 * selection search. log2(600) ≈ 9.2 for the default dense-frame
 * budget (600 frames @ 10 Hz = 60 s), so 16 is a comfortable ceiling
 * that terminates even under pathological frame-size distributions
 * while keeping total serialization work bounded to ~16 prepare
 * calls.
 */
export const MAX_SEARCH_ITERATIONS = 16;

/**
 * Size of the right-anchored fallback window shown while the async
 * default-selection search is still running. Measured in dense
 * frames — intentionally CADENCE-INDEPENDENT.
 *
 * Why a frame count, not a duration:
 *   The plan bans time-based framing throughout trim mode ("use
 *   'history' and 'range', not 'seconds' or 'playback duration'"
 *   — §Terminology). Simulation/playback speed is user-adjustable
 *   in Watch and the export timeline does not carry a stable
 *   seconds-per-frame contract, so any "60 frames ≈ N seconds"
 *   explanation would bit-rot the moment someone changes the
 *   record cadence or the default speed.
 *
 * Value rationale:
 *   · Large enough that the kept-region band is visibly wider than
 *     the end-caps when the fallback renders (prevents a "nothing
 *     selected?" flash on fast machines before the search settles).
 *   · Small enough that painting / prepare-measuring against the
 *     fallback remains cheap — the real search answer typically
 *     arrives within one or two paints anyway.
 *   · Never described as a duration in user-facing copy. While the
 *     fallback is active the status row renders "Finding the best
 *     fit…", with no time number.
 */
export const FRAME_FALLBACK_SUFFIX = 60;

/**
 * Debounce for the keyboard-driven prepare call fired after Arrow/
 * Home/End edits on a trim handle. 200 ms is short enough that
 * users typing a burst of Arrow presses see the status row update
 * once per rest, and long enough that each keystroke does not
 * trigger its own prepare.
 */
export const TRIM_KEYBOARD_PREPARE_DEBOUNCE_MS = 200;

/**
 * Trim-entry pulse on the end-caps.
 *
 * The caps live outside the non-modal dialog, so a user could miss
 * them on first open; a short animation draws the eye. Respects
 * `prefers-reduced-motion` via CSS media query.
 *
 * These two constants are the SINGLE SOURCE OF TRUTH for the pulse
 * lifecycle. The React component passes them into CSS via
 * `--trim-handle-pulse-duration` / `--trim-handle-pulse-count`
 * custom properties on the handle elements, and the JS timeout
 * that removes the `--pulse` class is computed as
 *   `duration × count`.
 *
 * Previously these lived in three places (JS timeout, CSS
 * `animation: X 1.2s ... 2`, and the config) and drifted. Keeping
 * the numbers here + derived everywhere else eliminates the drift.
 */
export const TRIM_HANDLE_PULSE_ITERATION_MS = 1200;
export const TRIM_HANDLE_PULSE_ITERATION_COUNT = 2;
/** Total wall-clock lifetime of the pulse. */
export const TRIM_HANDLE_PULSE_MS = TRIM_HANDLE_PULSE_ITERATION_MS * TRIM_HANDLE_PULSE_ITERATION_COUNT;
