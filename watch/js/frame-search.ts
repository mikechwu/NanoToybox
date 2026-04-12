/**
 * Watch-local binary search helpers for time-indexed frame arrays.
 *
 * Shared across watch-playback-model and topology sources. Not exported
 * to src/ or lab/ — this is a watch playback concern only.
 */

/** Find the frame at or before `timePs`. Returns null if no frame qualifies. */
export function bsearchAtOrBefore<T extends { timePs: number }>(frames: T[], timePs: number): T | null {
  if (frames.length === 0) return null;
  let lo = 0, hi = frames.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1;
    if (frames[mid].timePs <= timePs) lo = mid;
    else hi = mid - 1;
  }
  return frames[lo].timePs <= timePs ? frames[lo] : null;
}

/** Find the INDEX of the frame at or before `timePs`. Returns -1 if none. */
export function bsearchIndexAtOrBefore<T extends { timePs: number }>(frames: T[], timePs: number): number {
  if (frames.length === 0) return -1;
  let lo = 0, hi = frames.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1;
    if (frames[mid].timePs <= timePs) lo = mid;
    else hi = mid - 1;
  }
  return frames[lo].timePs <= timePs ? lo : -1;
}
