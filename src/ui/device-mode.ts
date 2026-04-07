/**
 * Shared device-mode and interaction-capability detection.
 * Single source of truth for both lab and watch.
 *
 * getDeviceMode() breakpoints replicate lab/js/main.ts:274-281 exactly:
 *   - <768px → phone
 *   - <1024px or (coarse pointer without hover) → tablet
 *   - else → desktop
 *
 * isTouchInteraction() replicates lab/js/config.ts:191-195:
 *   - true when primary pointer is coarse AND cannot hover
 *   - stable across resize — does not change with viewport width
 */

export type DeviceMode = 'phone' | 'tablet' | 'desktop';

export function getDeviceMode(): DeviceMode {
  const w = window.innerWidth;
  const coarsePointer = window.matchMedia('(pointer: coarse)').matches;
  const canHover = window.matchMedia('(hover: hover)').matches;
  if (w < 768) return 'phone';
  if (w < 1024 || (coarsePointer && !canHover)) return 'tablet';
  return 'desktop';
}

/**
 * True when the primary pointer is coarse and cannot hover — genuine touch
 * interaction context (phone/tablet), not a narrow desktop window or a
 * touch-capable laptop with a precise trackpad.
 *
 * Determines whether to bind touch or pointer events for camera input.
 * Stable across resize — does not change with viewport width.
 */
export function isTouchInteraction(): boolean {
  return (
    window.matchMedia('(pointer: coarse)').matches &&
    !window.matchMedia('(hover: hover)').matches
  );
}
