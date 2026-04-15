/**
 * Paint-deferred scheduler for INP-sensitive main-thread work.
 *
 * `requestAnimationFrame(() => setTimeout(work, 0))` gives the browser a
 * paint opportunity before `work` runs:
 *   - rAF fires before the next paint (work queued from here would still
 *     block that paint).
 *   - `setTimeout(..., 0)` inside rAF defers `work` to the task queue
 *     AFTER that paint commits.
 *
 * Module boundary exists so tests can mock the scheduler directly rather
 * than fighting vitest+jsdom rAF/fake-timer interop. See
 * tests/unit/timeline-bar-lifecycle.test.tsx for the mock pattern.
 *
 * Defensive rAF access: jsdom-based test runners and possible future
 * non-browser callers may not expose requestAnimationFrame. Fall back to
 * a ~1 frame setTimeout. All timer calls go through globalThis so the
 * fallback path does not silently depend on `window` — that is the
 * failure the defensive check is supposed to prevent.
 */
export function scheduleAfterNextPaint(work: () => void): () => void {
  const g: typeof globalThis = globalThis;
  // Select rAF + cAF as a pair — never mix-and-match. In a partial
  // environment that exposes only one of the two, a mixed pair would
  // schedule via setTimeout and try to cancel via cancelAnimationFrame
  // (or the reverse), silently losing cancellation. Falling back to
  // setTimeout/clearTimeout for both keeps cancellation semantics
  // correct in every environment.
  const hasRaf =
    typeof g.requestAnimationFrame === 'function' &&
    typeof g.cancelAnimationFrame === 'function';
  const raf: (cb: FrameRequestCallback) => number = hasRaf
    ? g.requestAnimationFrame.bind(g)
    : (cb) => g.setTimeout(() => cb(Date.now()), 16) as unknown as number;
  const caf: (id: number) => void = hasRaf
    ? g.cancelAnimationFrame.bind(g)
    : (id) => g.clearTimeout(id);

  let timeoutId: number | null = null;
  const rafId = raf(() => {
    timeoutId = g.setTimeout(work, 0) as unknown as number;
  });
  return () => {
    caf(rafId);
    if (timeoutId !== null) g.clearTimeout(timeoutId);
  };
}
