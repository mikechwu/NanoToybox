/**
 * Watch Lab-discovery runtime — owns the hint trigger engine.
 *
 * Responsibilities:
 *   - evaluate milestone triggers (`timeline_halfway`, `timeline_completed`)
 *     against incoming progress ticks with an advancement gate
 *   - pace hints once per (documentKey, triggerId) per session via
 *     sessionStorage + in-memory Set (hot-path cache)
 *   - own the active hint's lifecycle (auto-dismiss timer, explicit dismiss)
 *   - produce a FRESH `WatchLabHintModel` object on every transition so the
 *     controller's `snapshotChanged()` identity-compare stays reliable
 *
 * Does NOT:
 *   - publish snapshots (controller projects state via getState())
 *   - render DOM (the React component owns rendering)
 *   - know about camera-intent triggers (PR 3; see Phase notes)
 *
 * Scope: PR 1. Camera-intent is specified but not implemented here.
 *
 * Advancement gate: `timeline_halfway` / `timeline_completed` fire only when
 *   previousProgress < threshold <= currentProgress AND (curr - prev) < 0.15.
 *   This prevents a scrub-to-99% from firing both halfway and completed in
 *   the same tick (large delta = seek, not watch).
 */

import { readE2EBoolean, readE2ENumber } from './watch-lab-href';

export type WatchLabHintTriggerId = 'timeline_halfway' | 'timeline_completed';

export interface WatchLabHintModel {
  id: WatchLabHintTriggerId;
  message: string;
  tone: 'milestone' | 'intent';
}

export interface WatchLabDiscoveryState {
  activeHint: WatchLabHintModel | null;
}

export interface WatchLabDiscoveryRuntime {
  onPlaybackProgress(args: {
    loaded: boolean;
    currentTimePs: number;
    startTimePs: number;
    endTimePs: number;
    documentKey: string | null;
    isScrubbing: boolean;
  }): void;
  /** Signal the most recent pointer/gesture end so the idle-grace window starts. */
  notifyGestureEnd(nowMs: number): void;
  dismissActiveHint(id?: WatchLabHintTriggerId): void;
  getState(): WatchLabDiscoveryState;
  /** Invoked when the loaded document changes; clears per-document runtime cache. */
  resetForDocument(documentKey: string | null): void;
  /** Internal listener for state changes; called when `activeHint` changes so
   *  the controller can publish a snapshot. */
  subscribe(cb: () => void): () => void;
  destroy(): void;
}

/** Fired exactly once when the furthest-watched progress crosses each threshold. */
const THRESHOLDS: { id: WatchLabHintTriggerId; at: number; message: string }[] = [
  { id: 'timeline_halfway', at: 0.5, message: 'Play with the scene yourself →' },
  { id: 'timeline_completed', at: 0.95, message: 'Start from this frame in Lab →' },
];

/** Incremental-play window: progress jumps larger than this are treated as seeks. */
const ADVANCEMENT_DELTA_MAX = 0.15;

/** Minimum time between gesture-end and hint-render. */
const GESTURE_IDLE_GRACE_MS = 600;

/** Reading-speed scaling + floor/ceiling for auto-dismiss. */
const DISMISS_MS_PER_CHAR = 70;
const DISMISS_MS_FLOOR = 3500;
const DISMISS_MS_CEIL = 9000;

/** sessionStorage key prefix for per-document trigger suppression. */
const SUPPRESSION_PREFIX = 'atomdojo.watchLabHint:';

function suppressionKey(documentKey: string, triggerId: WatchLabHintTriggerId): string {
  return `${SUPPRESSION_PREFIX}${documentKey}:${triggerId}`;
}

function safeSessionGet(key: string): string | null {
  try {
    return typeof sessionStorage !== 'undefined' ? sessionStorage.getItem(key) : null;
  } catch {
    return null;
  }
}

function safeSessionSet(key: string, value: string): void {
  try {
    if (typeof sessionStorage !== 'undefined') sessionStorage.setItem(key, value);
  } catch {
    /* private mode / quota — ignore; in-memory cache still paces correctly. */
  }
}

function clearAllSuppressionKeys(): void {
  try {
    if (typeof sessionStorage === 'undefined') return;
    const toRemove: string[] = [];
    for (let i = 0; i < sessionStorage.length; i++) {
      const k = sessionStorage.key(i);
      if (k && k.startsWith(SUPPRESSION_PREFIX)) toRemove.push(k);
    }
    for (const k of toRemove) sessionStorage.removeItem(k);
  } catch {
    /* ignore */
  }
}

export function computeHintDismissMs(message: string, e2eOverride?: number | null): number {
  if (e2eOverride != null && e2eOverride > 0) return e2eOverride;
  const raw = message.length * DISMISS_MS_PER_CHAR;
  return Math.max(DISMISS_MS_FLOOR, Math.min(DISMISS_MS_CEIL, raw));
}

/** Opaque ambient so tests can inject Date.now() / setTimeout. */
export interface WatchLabDiscoveryDeps {
  now?: () => number;
  setTimeout?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimeout?: (t: ReturnType<typeof setTimeout>) => void;
  /** For tests: override sessionStorage base auto-dismiss override. */
  e2eDismissMsOverride?: number | null;
  /** If true, skip sessionStorage suppression (hints re-fire); used by ?e2eResetLabHints=1. */
  bypassPersistedSuppression?: boolean;
}

export function createWatchLabDiscoveryRuntime(
  deps: WatchLabDiscoveryDeps = {},
): WatchLabDiscoveryRuntime {
  const now = deps.now ?? (() => Date.now());
  const setTmr = deps.setTimeout ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTmr = deps.clearTimeout ?? ((t) => clearTimeout(t));

  // Resolve env overrides once at construction; tests inject deps instead.
  const resetHints = deps.bypassPersistedSuppression ?? readE2EBoolean('e2eResetLabHints');
  const e2eDismissOverride =
    deps.e2eDismissMsOverride !== undefined
      ? deps.e2eDismissMsOverride
      : readE2ENumber('e2eHintDismissMs');

  if (resetHints) clearAllSuppressionKeys();

  /** In-memory fired set per document key. Hot path — avoids a sessionStorage
   *  read on every progress tick. Populated lazily from sessionStorage when a
   *  document becomes active. */
  const firedByDocument = new Map<string, Set<WatchLabHintTriggerId>>();
  let currentDocumentKey: string | null = null;
  let furthestProgress = 0;
  let lastGestureEndMs = -Infinity;
  let lastProgress = 0;

  /** Grace-window defer state (rev 6 follow-up P1). When a threshold is
   *  crossed WHILE `withinGrace` is true, the runtime cannot fire the
   *  hint immediately — but it must not lose the crossing either, because
   *  the next tick has `prev >= threshold` and the crossing predicate
   *  would never re-trigger. We stash the pending id and fire on the
   *  first eligible tick after grace clears. Exactly one trigger can
   *  be pending at a time; if a second threshold crosses during grace
   *  (rare), it takes priority because crossings are processed in
   *  threshold order and `markFired` still records the earlier one.
   *
   *  NOTE: `pendingTriggerId` is NOT persisted and NOT added to
   *  `firedByDocument` until it actually fires. If the document changes
   *  (`resetForDocument`) before grace clears, the pending state is
   *  cleared and cannot leak to the next document. */
  let pendingTriggerId: WatchLabHintTriggerId | null = null;

  let activeHint: WatchLabHintModel | null = null;
  let dismissTimer: ReturnType<typeof setTimeout> | null = null;
  const listeners = new Set<() => void>();

  function notify() {
    for (const cb of listeners) {
      try { cb(); } catch (e) { console.error('[watch.discovery] listener error:', e); }
    }
  }

  function hydrateFiredSet(docKey: string): Set<WatchLabHintTriggerId> {
    let set = firedByDocument.get(docKey);
    if (set) return set;
    set = new Set();
    if (!resetHints) {
      for (const t of THRESHOLDS) {
        if (safeSessionGet(suppressionKey(docKey, t.id))) set.add(t.id);
      }
    }
    firedByDocument.set(docKey, set);
    return set;
  }

  function markFired(docKey: string, id: WatchLabHintTriggerId): void {
    const set = hydrateFiredSet(docKey);
    set.add(id);
    safeSessionSet(suppressionKey(docKey, id), String(now()));
  }

  function setActiveHint(next: WatchLabHintModel | null): void {
    // Identity invariant: only publish a change when the REFERENCE differs.
    // Callers already pass a fresh object when firing; this guard stops
    // redundant `null → null` publishes from notifying subscribers.
    if (activeHint === next) return;
    activeHint = next;
    notify();
  }

  function clearDismissTimer(): void {
    if (dismissTimer != null) {
      clearTmr(dismissTimer);
      dismissTimer = null;
    }
  }

  function fire(triggerId: WatchLabHintTriggerId, message: string): void {
    clearDismissTimer();
    // Fresh object on every transition — snapshot identity compare depends on this.
    const hint: WatchLabHintModel = { id: triggerId, message, tone: 'milestone' };
    setActiveHint(hint);
    const dismissMs = computeHintDismissMs(message, e2eDismissOverride);
    dismissTimer = setTmr(() => {
      dismissTimer = null;
      // Auto-dismiss produces a fresh null publish ONLY if this hint is still active.
      if (activeHint === hint) setActiveHint(null);
    }, dismissMs);
  }

  return {
    onPlaybackProgress({ loaded, currentTimePs, startTimePs, endTimePs, documentKey, isScrubbing }) {
      if (!loaded) {
        lastProgress = 0;
        furthestProgress = 0;
        pendingTriggerId = null;
        return;
      }
      if (!documentKey) return;
      // Document key change — reset per-document state (pending trigger
      // MUST NOT leak across documents; see regression test).
      if (documentKey !== currentDocumentKey) {
        currentDocumentKey = documentKey;
        furthestProgress = 0;
        lastProgress = 0;
        pendingTriggerId = null;
      }
      const duration = endTimePs - startTimePs;
      if (duration <= 0) return;
      const progress = Math.max(0, Math.min(1, (currentTimePs - startTimePs) / duration));
      const prev = lastProgress;
      lastProgress = progress;

      // Scrub / seek: do not consider for milestone advancement, AND do
      // not clear a pending trigger — the crossing that produced it is
      // still real; we just wait for the next non-scrub idle tick.
      if (isScrubbing) return;

      // Idle grace: suppress hint render until the user's most recent
      // gesture has settled. Crossings that happen during grace are
      // deferred via `pendingTriggerId` so the hint still fires once
      // the grace window clears (rev 6 follow-up P1).
      const withinGrace = now() - lastGestureEndMs < GESTURE_IDLE_GRACE_MS;

      furthestProgress = Math.max(furthestProgress, progress);

      // 1. If a trigger was deferred during an earlier grace, try to
      //    fire it now — but only when the grace has actually cleared
      //    AND progress is still at-or-past the threshold. Dismissed
      //    or already-fired triggers are rejected here.
      //
      //    NOTE: the deferred-fire path intentionally does NOT re-run the
      //    advancement-delta gate. The original crossing (during grace)
      //    already satisfied `delta < ADVANCEMENT_DELTA_MAX`, and scrub
      //    ticks early-return BEFORE reaching this block, so an
      //    intentional seek cannot trigger a deferred fire. A non-scrub
      //    large-delta tick (e.g. RAF catch-up after a backgrounded tab)
      //    can still fire the pending hint; that edge case is preferable
      //    to permanently losing the crossing the user worked toward.
      if (pendingTriggerId && !withinGrace) {
        const firedSet = hydrateFiredSet(documentKey);
        const threshold = THRESHOLDS.find((t) => t.id === pendingTriggerId);
        if (!threshold || firedSet.has(pendingTriggerId) || progress < threshold.at) {
          // Cannot fire: either unknown id, already fired, or progress
          // has regressed below the threshold (e.g. repeat-wrap). Drop
          // the pending state.
          pendingTriggerId = null;
        } else {
          markFired(documentKey, pendingTriggerId);
          fire(pendingTriggerId, threshold.message);
          pendingTriggerId = null;
          return;
        }
      }

      // 2. Detect fresh crossings on this tick.
      for (const t of THRESHOLDS) {
        const crossedNow = prev < t.at && progress >= t.at;
        const delta = progress - prev;
        const incremental = delta >= 0 && delta < ADVANCEMENT_DELTA_MAX;
        if (!crossedNow || !incremental) continue;
        const firedSet = hydrateFiredSet(documentKey);
        if (firedSet.has(t.id)) continue;
        if (withinGrace) {
          // Defer — do NOT markFired yet; sessionStorage suppression
          // records only ACTUAL fires so a user who dismisses us via
          // `resetForDocument` before grace clears keeps the slot open.
          // Only one trigger can be pending at a time; a later crossing
          // during the same grace window overwrites (the terminal
          // threshold is more valuable than the earlier one).
          pendingTriggerId = t.id;
          continue;
        }
        markFired(documentKey, t.id);
        fire(t.id, t.message);
        // Only one hint at a time
        return;
      }
    },

    notifyGestureEnd(nowMs) {
      lastGestureEndMs = nowMs;
    },

    dismissActiveHint(id) {
      if (id != null && (activeHint == null || activeHint.id !== id)) return;
      clearDismissTimer();
      setActiveHint(null);
      // Dismiss also suppresses the deferred pending trigger — otherwise
      // a user who closed the hint would see it re-render on the next
      // grace-clear tick, which feels like the close button is broken.
      pendingTriggerId = null;
    },

    getState() {
      return { activeHint };
    },

    resetForDocument(documentKey) {
      currentDocumentKey = documentKey;
      furthestProgress = 0;
      lastProgress = 0;
      pendingTriggerId = null;
      clearDismissTimer();
      setActiveHint(null);
    },

    subscribe(cb) {
      listeners.add(cb);
      return () => { listeners.delete(cb); };
    },

    destroy() {
      clearDismissTimer();
      listeners.clear();
      firedByDocument.clear();
    },
  };
}
