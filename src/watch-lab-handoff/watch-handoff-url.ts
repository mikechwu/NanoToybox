/**
 * Shared URL predicate for the Watch → Lab handoff boot signal.
 *
 * The marker is the URL-parameter tuple `?from=watch&handoff=<token>`.
 * Two authorities on the Lab side need to agree on this signal:
 *
 *   1. `lab/js/main.ts` — skip the default-structure load during boot
 *      so the hydrate transaction can stage the scene against an empty
 *      canvas (see `_hasPendingWatchHandoff` historical usage).
 *   2. `lab/js/runtime/onboarding.ts` — suppress the welcome overlay
 *      and its sink-to-Settings animation, because a user arriving via
 *      Continue has already been introduced to the product on Watch.
 *
 * Keeping the URL-contract in one module means the two gates cannot
 * drift: a future rename of `from=watch` or `handoff=` will update
 * both boot gate and onboarding gate in a single edit.
 *
 * Pure function — accepts a `Location`-shaped input so tests can pass a
 * synthetic `{ search: '...' }` instead of monkey-patching `window`.
 */

/** Minimum surface of `Location` this predicate reads. */
export interface LocationSearchLike {
  search: string;
}

/**
 * True when the current URL indicates the Lab tab was opened via the
 * Watch → Lab Continue handoff. Safe in non-browser contexts: defaults
 * to `window.location` when available, returns `false` otherwise.
 */
export function isWatchHandoffBoot(
  loc: LocationSearchLike | undefined = typeof window !== 'undefined' ? window.location : undefined,
): boolean {
  if (!loc) return false;
  try {
    const params = new URLSearchParams(loc.search);
    return params.get('from') === 'watch' && !!params.get('handoff');
  } catch {
    return false;
  }
}
