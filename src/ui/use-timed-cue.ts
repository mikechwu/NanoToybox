/**
 * useTimedCue — trigger-driven one-shot visibility cue.
 *
 * Two discoverability affordances share the exact same animation
 * contract:
 *   1. TimelineBar's `TransferTrigger` — fades the "Share & Download"
 *      tooltip 5 s after first atom interaction.
 *   2. WatchLabEntryControl — fades the "Interact From Here" tooltip
 *      when playback crosses timeline milestones (halfway / end).
 *
 * Both reduce to: "when a monotonic trigger token changes, raise a
 * visibility flag for `durationMs`, then lower it." Keeping two
 * copies of the state machine means future changes (cancellation
 * semantics, back-to-back firing, debouncing) have to happen in two
 * places. This hook centralizes them.
 *
 * Contract
 * --------
 * - `triggerToken` is monotonic, but the hook does NOT enforce that.
 *   It only compares `!==`, so any distinct value restarts the cue.
 * - The FIRST observed token (including `undefined`) is recorded as
 *   a baseline and does NOT fire — so parents that default-initialize
 *   with `useState(0)` don't get a cue on mount.
 * - Successive firings within `durationMs` cancel the previous
 *   timer and start a fresh `durationMs` window. `animKey` bumps on
 *   every firing so the caller can React-`key` an element and force
 *   CSS animation restart.
 * - On unmount the pending timer is cleared.
 */

import { useEffect, useRef, useState } from 'react';

export interface UseTimedCueInput {
  /** Monotonic trigger token. Passing `undefined` leaves the cue dormant. */
  triggerToken: number | undefined;
  /** How long `active` stays `true` after a firing (ms). */
  durationMs: number;
}

export interface UseTimedCueResult {
  /** `true` while the cue's visibility window is open. */
  active: boolean;
  /** Increments on every firing — use as a React `key` to force an
   *  element to remount so its CSS animation restarts at 0 %. */
  animKey: number;
}

export function useTimedCue({
  triggerToken,
  durationMs,
}: UseTimedCueInput): UseTimedCueResult {
  const [active, setActive] = useState(false);
  const [animKey, setAnimKey] = useState(0);
  const prevTokenRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    // Dormant until the parent starts providing a token.
    if (triggerToken === undefined) return;

    // Baseline on first observation — don't fire on mount for parents
    // that default-initialize to 0 (or any other seed value).
    if (prevTokenRef.current === undefined) {
      prevTokenRef.current = triggerToken;
      return;
    }

    if (prevTokenRef.current === triggerToken) return;
    prevTokenRef.current = triggerToken;

    setAnimKey((k) => k + 1);
    setActive(true);
    const timer = setTimeout(() => setActive(false), durationMs);
    return () => clearTimeout(timer);
  }, [triggerToken, durationMs]);

  return { active, animKey };
}
