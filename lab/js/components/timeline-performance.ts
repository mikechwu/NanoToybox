/**
 * User Timing instrumentation helper.
 *
 * Centralizes `performance.mark` / `performance.measure` hygiene so the
 * two call sites (export-estimate effect, transfer-pause helper) do not
 * have to repeat the same five-line boilerplate — and, more importantly,
 * so missing API pieces cannot cause a new failure mode.
 *
 * Why a separate module from timeline-after-paint.ts: tests mock the
 * scheduler to run synchronously; a colocated `measureSync` would be
 * silently replaced with `undefined` by a mock factory that forgot to
 * re-export it, breaking the component at test time.
 */
export function measureSync<T>(name: string, work: () => T): T {
  // Bail cleanly if either half of the User Timing API is unavailable —
  // `measure()` without `mark()` would throw on missing named marks.
  if (
    typeof performance === 'undefined' ||
    typeof performance.mark !== 'function' ||
    typeof performance.measure !== 'function'
  ) {
    return work();
  }

  const start = `${name}-start`;
  const end = `${name}-end`;

  // Invariant: instrumentation must never change app behavior. If any
  // User Timing call throws (clock regression, locked-down realms,
  // exotic sandboxes), we fall through to `work()` untouched and let
  // its result or error propagate exactly as if the helper were not
  // here. This matters because a throwing `performance.measure` inside
  // a naive `finally` would replace the real error from `work()` with
  // the instrumentation error and break export/share UX.
  try {
    performance.mark(start);
  } catch {
    return work();
  }

  try {
    // Return (or rethrow) the result of `work`. Mark/measure/clear all
    // happen in `finally` so INP cost is attributable whether the
    // expensive work succeeded or failed.
    return work();
  } finally {
    try {
      performance.mark(end);
      performance.measure(name, start, end);
    } catch {
      // User Timing is diagnostic only — swallow.
    } finally {
      try {
        performance.clearMarks?.(start);
        performance.clearMarks?.(end);
      } catch {
        // Same diagnostic-only rule — never replace work()'s error.
      }
    }
  }
}
