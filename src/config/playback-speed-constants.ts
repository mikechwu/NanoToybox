/**
 * Shared playback speed constants and logarithmic slider mapping.
 *
 * Used by both the watch playback model (engine) and UI components
 * (dock speed control, settings sheet). Single source of truth.
 */

/** Minimum playback speed multiplier. */
export const SPEED_MIN = 0.5;
/** Maximum playback speed multiplier. */
export const SPEED_MAX = 20;
/** Default playback speed multiplier. */
export const SPEED_DEFAULT = 1;
/** Preset speed values for quick-tap buttons. */
export const SPEED_PRESETS = [0.5, 1, 2, 4, 8, 16, 20] as const;
/** Maximum wall-clock delta (ms) before clamping. Prevents huge jumps after tab-background return. */
export const PLAYBACK_GAP_CLAMP_MS = 250;
/** Hold threshold (ms) for transport buttons: tap below = step, hold above = directional play. */
export const HOLD_PLAY_THRESHOLD_MS = 160;

// ── Logarithmic slider mapping ──
// A linear slider over [0.5, 20] gives most travel to the high end.
// Logarithmic mapping distributes control evenly across the ratio range,
// giving ~37% of slider travel to the 0.5x–2x range where fine control matters most.

/** Slider position [0,1] → speed value [SPEED_MIN, SPEED_MAX]. Logarithmic. */
export function sliderToSpeed(t: number): number {
  const clamped = Math.max(0, Math.min(1, t));
  return SPEED_MIN * Math.pow(SPEED_MAX / SPEED_MIN, clamped);
}

/** Speed value [SPEED_MIN, SPEED_MAX] → slider position [0,1]. Inverse logarithmic. */
export function speedToSlider(speed: number): number {
  const clamped = Math.max(SPEED_MIN, Math.min(SPEED_MAX, speed));
  return Math.log(clamped / SPEED_MIN) / Math.log(SPEED_MAX / SPEED_MIN);
}

/** Format speed for display. Sub-10: one decimal. 10+: integer. */
export function formatSpeed(speed: number): string {
  if (speed < 10) return `${speed.toFixed(1)}x`;
  return `${Math.round(speed)}x`;
}
