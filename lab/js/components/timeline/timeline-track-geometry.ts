/**
 * Timeline track geometry — shared ratio-math for scrub + trim.
 *
 * Extracted from TimelineBar's `scrubFromEvent` so trim and scrub
 * handlers don't maintain parallel implementations of the same
 * clientX ↔ timePs conversion. One bug-fix, one place.
 */

export function timePsFromClientX(
  clientX: number,
  rangePs: { start: number; end: number },
  trackEl: HTMLElement,
): number {
  const rect = trackEl.getBoundingClientRect();
  if (rect.width <= 0) return rangePs.start;
  const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
  return rangePs.start + ratio * (rangePs.end - rangePs.start);
}

export function clientXFromTimePs(
  timePs: number,
  rangePs: { start: number; end: number },
  trackEl: HTMLElement,
): number {
  const rect = trackEl.getBoundingClientRect();
  const duration = rangePs.end - rangePs.start;
  if (duration <= 0) return rect.left;
  const ratio = Math.max(0, Math.min(1, (timePs - rangePs.start) / duration));
  return rect.left + ratio * rect.width;
}
