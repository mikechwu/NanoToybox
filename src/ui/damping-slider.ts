/**
 * Damping ↔ slider conversion — single source of truth.
 *
 * The Settings sheet exposes damping via a discrete 0–DAMPING_SLIDER_MAX
 * slider whose position maps to a physical damping coefficient via a
 * cubic curve. Two properties hold:
 *
 *   sliderValueToDamping(v) ≡ DAMPING_CUBIC_SCALE · (v/DAMPING_SLIDER_MAX)³
 *   dampingToSliderValue(d) ≡ round( cbrt(d/DAMPING_CUBIC_SCALE) · DAMPING_SLIDER_MAX )
 *
 * Keep this file as the only place either constant or formula appears.
 * Every consumer — the Settings slider, the initial-store population at
 * Lab boot, the `onDampingChange` callback, the timeline restart-from-
 * here store sync, and the Watch→Lab hydrate store sync — must route
 * through the helpers below. Inlining the math anywhere else reopens
 * the drift that motivated this module.
 *
 * Owns: cubic scale constant, slider range, round-trip conversion,
 *       and the user-facing damping label format.
 * Pure: no React, no store, no side effects. Safe to import from any
 *       layer of either frontend.
 */

/** Maximum integer slider position. Together with DAMPING_CUBIC_SCALE
 *  this defines the entire slider ↔ damping mapping. */
export const DAMPING_SLIDER_MAX = 100;

/** Damping coefficient at the slider maximum. The cubic curve means
 *  most of the slider travel produces gentle damping while the final
 *  third ramps into heavy viscous drag. */
export const DAMPING_CUBIC_SCALE = 0.5;

/** Inverse of `sliderValueToDamping`. Non-finite and non-positive
 *  inputs clamp to 0 so a corrupt restart/hydrate config cannot
 *  propagate NaN into the store and leave the Settings slider in an
 *  unrecoverable visual state. */
export function dampingToSliderValue(d: number): number {
  if (!Number.isFinite(d) || d <= 0) return 0;
  return Math.round(Math.cbrt(d / DAMPING_CUBIC_SCALE) * DAMPING_SLIDER_MAX);
}

export function sliderValueToDamping(sliderVal: number): number {
  const t = sliderVal / DAMPING_SLIDER_MAX;
  return t === 0 ? 0 : DAMPING_CUBIC_SCALE * t * t * t;
}

export function formatDampingFromSliderValue(sliderVal: number): string {
  const d = sliderValueToDamping(sliderVal);
  if (d === 0) return 'None';
  // Scientific form below 10⁻³ keeps the three-decimal fixed form from
  // collapsing to "0.000" at low slider positions.
  if (d < 0.001) return d.toExponential(0);
  return d.toFixed(3);
}
