/**
 * Shared camera-gesture discrimination constants.
 *
 * Both lab/js/input.ts and watch/js/view/watch-camera-input.ts import from this
 * single source so triad tap/drag/double-tap behavior stays numerically
 * identical across both apps.
 */

/** Movement threshold (px) before a triad touch commits to orbit drag.
 *  Below this = tap intent, above = orbit. */
export const TRIAD_DRAG_COMMIT_PX = 5;

/** Delay (ms) before showing axis highlight during a triad hold.
 *  Fires only if finger hasn't moved beyond TRIAD_DRAG_COMMIT_PX. */
export const TAP_INTENT_PREVIEW_MS = 150;

/** Maximum touch duration (ms) for a gesture to count as a tap.
 *  Longer = drag (even if finger didn't move far). */
export const TAP_MAX_DURATION_MS = 300;

/** Maximum gap (ms) between two taps for double-tap detection.
 *  Used for triad center double-tap → animated reset. */
export const DOUBLE_TAP_WINDOW_MS = 400;
