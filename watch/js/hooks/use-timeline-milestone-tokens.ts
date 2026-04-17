/**
 * useTimelineMilestoneTokens — once-per-file tokens that fire when
 * playback crosses the timeline's halfway and end marks.
 *
 * Consumers:
 *   · `WatchApp` wires the returned token into
 *     `WatchLabEntryControl`'s auto-cue machinery.
 *
 * Semantic contract (tightened from the initial simple-ref version
 * after the audit flagged three silent-failure edge cases):
 *
 *   1. **Once per file, not once per session.** The fired-state
 *      resets whenever `fileIdentity` changes (new file loaded,
 *      re-opened, etc.). Without this, a user's second file of the
 *      session would silently never cue even though their mental
 *      model is "fresh timeline, fresh signals."
 *
 *   2. **Arm-then-fire.** Each milestone must be "armed" by
 *      observing at least one sample with `currentTimePs < threshold`
 *      before it can fire. A share-code deep-link that resumes at
 *      80 % would otherwise instantly trigger both the halfway and
 *      the end cue at t=0 of attention — a startup flash, not a
 *      milestone signal. Arming makes the cue mean "they just
 *      crossed it", not "they started there."
 *
 *   3. **Paused-seek coalescing.** A scrub from 10 % to 95 % while
 *      paused would previously bump the token twice in one effect
 *      run; React batches the two setState calls, the child sees a
 *      SINGLE change, and one cue is silently lost. We now only
 *      cross one milestone per effect run — whichever was armed and
 *      newly crossed, end-first — and re-enter the effect on the
 *      next snapshot if a second milestone is still pending. The
 *      ordering (end-first) ensures a "skip to end" gesture signals
 *      the end cue (the user's final intent), not a flash of
 *      halfway that immediately re-rolls into end.
 *
 * Pure behaviourally-observable state only — no logging, no store
 * writes. Consumers wire side effects.
 */

import { useEffect, useRef, useState } from 'react';

export interface TimelineSnapshotLike {
  loaded: boolean;
  currentTimePs: number;
  startTimePs: number;
  endTimePs: number;
  /** Opaque identity for "this is the same file we last saw." If the
   *  parent doesn't expose one, pass `fileName ?? null` — good enough
   *  in practice since re-opening the same filename replays the same
   *  timeline. */
  fileIdentity: string | null;
}

/** Arm state for a single milestone. `armed` flips true the first
 *  time we see `currentTimePs < threshold`; `fired` flips true the
 *  first time `currentTimePs >= threshold` AFTER being armed. */
interface MilestoneArmState {
  armed: boolean;
  fired: boolean;
}

export function useTimelineMilestoneTokens(
  snapshot: TimelineSnapshotLike,
): number {
  const [token, setToken] = useState(0);
  const midRef = useRef<MilestoneArmState>({ armed: false, fired: false });
  const endRef = useRef<MilestoneArmState>({ armed: false, fired: false });
  const lastFileRef = useRef<string | null | undefined>(undefined);

  useEffect(() => {
    const { loaded, currentTimePs, startTimePs, endTimePs, fileIdentity } = snapshot;

    // (1) File-change reset — clears both milestones so the next
    //     file's timeline gets a fresh pair of cues. First run after
    //     mount also lands here (lastFileRef starts undefined).
    if (lastFileRef.current !== fileIdentity) {
      lastFileRef.current = fileIdentity;
      midRef.current = { armed: false, fired: false };
      endRef.current = { armed: false, fired: false };
    }

    if (!loaded) return;
    const span = endTimePs - startTimePs;
    if (span <= 0) return;

    const midPs = startTimePs + span / 2;
    // 0.2 % tolerance absorbs float-precision drift at the timeline's
    // right end (smooth-playback cursors don't always land exactly on
    // endTimePs).
    const endThresholdPs = endTimePs - span * 0.002;

    // (2) Arm-before-fire. If we're already past the threshold on
    //     first observation, we stay un-armed and won't ever fire
    //     that milestone for this file — the user started past it.
    if (!midRef.current.armed && currentTimePs < midPs) {
      midRef.current.armed = true;
    }
    if (!endRef.current.armed && currentTimePs < endThresholdPs) {
      endRef.current.armed = true;
    }

    // (3) Fire — end first (see docstring for ordering rationale).
    //     Fire at most ONE per effect run so a paused-seek that
    //     crosses both doesn't get React-batched into a single
    //     perceived cue. If the other milestone is still pending,
    //     it will fire on the next snapshot tick.
    if (endRef.current.armed && !endRef.current.fired && currentTimePs >= endThresholdPs) {
      endRef.current.fired = true;
      setToken((t) => t + 1);
      return;
    }
    if (midRef.current.armed && !midRef.current.fired && currentTimePs >= midPs) {
      midRef.current.fired = true;
      setToken((t) => t + 1);
    }
  }, [snapshot]);

  return token;
}
