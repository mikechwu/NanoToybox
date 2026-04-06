/** Timeline formatting and progress helpers.
 *  formatTime output must fit within --tl-time-width (56px desktop, 48px mobile).
 *  Width-fit is enforced by the fixed CSS variable; this module owns formatting policy. */

/** Format simulation time for the timeline display.
 *  Longest expected outputs per unit: "999 fs", "99.99 ps", "9999.9 ps", "999.99 ns", "99.99 µs". */
export function formatTime(ps: number): string {
  if (ps < 0.001) return `${(ps * 1000).toFixed(1)} fs`;
  if (ps < 1) return `${(ps * 1000).toFixed(0)} fs`;
  if (ps < 100) return `${ps.toFixed(2)} ps`;
  if (ps < 10_000) return `${ps.toFixed(1)} ps`;
  if (ps < 1_000_000) return `${(ps / 1000).toFixed(2)} ns`;
  return `${(ps / 1_000_000).toFixed(2)} \u00b5s`;
}

export function getTimelineProgress(
  rangePs: { start: number; end: number } | null,
  currentTimePs: number,
): number {
  if (!rangePs) return 0;
  const duration = rangePs.end - rangePs.start;
  if (duration <= 0) return 0;
  return Math.max(0, Math.min(1, (currentTimePs - rangePs.start) / duration));
}

export function getRestartAnchorStyle(progress: number): { left: string } {
  const clamped = Math.max(0.05, Math.min(0.95, progress));
  return { left: `${clamped * 100}%` };
}
