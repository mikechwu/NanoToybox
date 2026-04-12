/**
 * Watch trajectory interpolation runtime — Round 6.
 *
 * Renders smooth positions between recorded dense frames via an
 * extension-oriented strategy registry. Ships one stable default (Linear)
 * and two experimental methods (Hermite, Catmull-Rom). New experimental
 * methods plug in by implementing InterpolationStrategy and calling
 * registerStrategy() — the controller and UI do not need to change.
 *
 * Owns:
 *   - bracketing frame lookup with cursor-cache fast path
 *   - 4-frame window lookup (for 4-frame strategies)
 *   - strategy registry + resolution loop + universal linear fallback
 *   - preallocated output buffer (sized to maxAtomCount at file load)
 *   - last-frame diagnostic state (active method + fallback reason)
 *   - lifecycle: reset() / dispose()
 *
 * Does NOT own:
 *   - user preferences (smoothPlayback / interpolationMode — those live in
 *     watch-settings.ts; the controller passes them in on each call)
 *   - transport clock, renderer lifecycle, bonded-group analysis, colors
 *
 * Buffer ownership: the output buffer is closure-private and returned BY
 * REFERENCE on interpolated frames. On boundary-degeneracy fallback paths
 * (null bracket, non-interpolatable bracket), the importer's immutable
 * dense-frame positions reference is returned directly — no copy, no
 * mutation. The renderer's retain-by-reference contract is upheld in both
 * cases because the runtime never mutates the output buffer between a
 * resolve() call and the next resolve() call.
 */

import type {
  LoadedFullHistory,
  NormalizedDenseFrame,
  NormalizedRestartFrame,
  InterpolationCapability,
} from './full-history-import';
import type { WatchInterpolationMode } from './watch-settings';
import { FS_PER_PS } from '../../src/history/units';

/** Runtime method identifier — an opaque string. The registry accepts any ID,
 *  so dev-only / research methods can be registered without widening the
 *  productized WatchInterpolationMode union in watch-settings.ts. Built-in
 *  IDs ('linear', 'hermite', 'catmull-rom') happen to overlap with
 *  WatchInterpolationMode but that alignment is enforced by the discriminated
 *  union below (product methods must use a WatchInterpolationMode id). */
export type InterpolationMethodId = string;

// ── Fallback reason taxonomy ──

/** Why a method declined or degraded for a specific bracket. Surfaces in
 *  snapshot for lightweight UI messaging. */
export type FallbackReason =
  | 'none'                    // method ran as selected
  | 'disabled'                // smoothPlayback = off
  | 'at-boundary'             // timeline edge — used discrete frame directly
  | 'single-frame'            // history has one frame
  | 'variable-n'              // prev.n !== next.n
  | 'atomids-mismatch'        // atomId divergence across the bracket
  | 'velocities-unavailable'  // Hermite needs velocities that aren't safely aligned
  | 'insufficient-frames'     // Catmull-Rom needs 4 frames but has fewer
  | 'window-mismatch'         // Catmull-Rom 4-frame window has n/atomId mismatch
  | 'capability-declined';    // strategy-specific decline not otherwise classified

// ── Strategy interface types ──

/** Common metadata fields shared by all methods. */
interface InterpolationMethodMetadataBase {
  label: string;
  stability: 'stable' | 'experimental';
  requiresVelocities: boolean;
  requires4Frames: boolean;
}

/** Product method: `id` is constrained to WatchInterpolationMode so the
 *  settings picker can safely use it without casting. */
export interface ProductMethodMetadata extends InterpolationMethodMetadataBase {
  availability: 'product';
  id: WatchInterpolationMode;
}

/** Dev-only method: `id` is any string — invisible to the product UI, usable
 *  only via test hooks or dev tools. */
export interface DevMethodMetadata extends InterpolationMethodMetadataBase {
  availability: 'dev-only';
  id: InterpolationMethodId;
}

/** Discriminated union — `availability` is the discriminant. The UI can
 *  narrow to ProductMethodMetadata via `m.availability === 'product'` and
 *  then safely read `m.id` as WatchInterpolationMode without a cast. */
export type InterpolationMethodMetadata = ProductMethodMetadata | DevMethodMetadata;

/** Read-only bracket descriptor passed to strategies. */
export interface Bracket {
  /** Importer-owned at-or-before frame. DO NOT mutate. */
  prev: { timePs: number; n: number; positions: Float64Array };
  /** Importer-owned next frame. DO NOT mutate. */
  next: { timePs: number; n: number; positions: Float64Array };
  /** Shared atomIds (guaranteed equal when interpolatable === true). */
  atomIds: number[];
  /** Interpolation parameter in [0, 1]. */
  alpha: number;
  /** False if n mismatch or atomId divergence between prev and next. */
  interpolatable: boolean;
  /** Dense frame index of `prev` — used by the runtime to read capability flags. */
  prevIndex: number;
}

/** Per-frame input to an interpolation strategy. Strategies MUST NOT mutate
 *  any input buffers — they write into outputBuffer only. The resolution
 *  loop only calls a strategy when its required inputs are non-null, so
 *  strategies may treat optional fields as "either present when needed or
 *  not needed at all". */
export interface InterpolationInput {
  bracket: Bracket;
  /** Non-null ONLY when the selected strategy has requires4Frames === true
   *  AND the capability layer certifies the window. */
  window4: {
    fMinus1: { positions: Float64Array };
    fPlus2: { positions: Float64Array };
  } | null;
  /** Non-null ONLY when the selected strategy has requiresVelocities === true
   *  AND the capability layer certifies the bracket. */
  velocityPair: { v0: Float64Array; v1: Float64Array } | null;
  /** Output buffer to write into. Length >= bracket.prev.n * 3. */
  outputBuffer: Float64Array;
}

/** Strategy return value. */
export type InterpolationResult =
  | { kind: 'ok'; n: number }
  | { kind: 'decline'; reason: FallbackReason };

/** Pure, stateless strategy — any caching lives in the runtime. */
export interface InterpolationStrategy {
  readonly metadata: InterpolationMethodMetadata;
  run(input: InterpolationInput): InterpolationResult;
}

// ── Runtime result type ──

export interface InterpolationResolveResult {
  /** Positions ready to pass to renderer.updateReviewFrame(). Buffer origin:
   *  runtime output buffer on interpolated paths; importer immutable reference
   *  on boundary/fallback paths. Both are safe under the retain-by-reference
   *  contract. */
  positions: Float64Array;
  n: number;
  atomIds: number[];
  selectedMode: InterpolationMethodId;
  activeMethod: InterpolationMethodId;
  fallbackReason: FallbackReason;
}

// ── Built-in strategies ──

/** Write linear interpolation into outputBuffer for bracket.prev.n atoms.
 *  Universal fallback — always succeeds, always does a full overwrite of
 *  [0, bracket.prev.n * 3). */
function linearRun(input: InterpolationInput): InterpolationResult {
  const { bracket, outputBuffer } = input;
  const p0 = bracket.prev.positions;
  const p1 = bracket.next.positions;
  const n3 = bracket.prev.n * 3;
  const a = bracket.alpha;
  const oneMinusA = 1 - a;
  for (let i = 0; i < n3; i++) {
    outputBuffer[i] = oneMinusA * p0[i] + a * p1[i];
  }
  return { kind: 'ok', n: bracket.prev.n };
}

const LinearStrategy: InterpolationStrategy = {
  metadata: {
    id: 'linear',
    label: 'Linear',
    stability: 'stable',
    availability: 'product',
    requiresVelocities: false,
    requires4Frames: false,
  },
  run: linearRun,
};

/** Cubic Hermite over a bracket using real velocities (Å/fs, scaled by
 *  FS_PER_PS to match ps time axis). Exact at knots. */
const HermiteStrategy: InterpolationStrategy = {
  metadata: {
    id: 'hermite',
    label: 'Hermite (Velocity-Based)',
    stability: 'experimental',
    availability: 'product',
    requiresVelocities: true,
    requires4Frames: false,
  },
  run(input: InterpolationInput): InterpolationResult {
    const { bracket, velocityPair, outputBuffer } = input;
    // The resolution loop only calls Hermite when velocityPair is non-null.
    // Defensive fallback — should never fire in production.
    if (!velocityPair) return { kind: 'decline', reason: 'velocities-unavailable' };

    const p0 = bracket.prev.positions;
    const p1 = bracket.next.positions;
    const v0 = velocityPair.v0; // Å/fs
    const v1 = velocityPair.v1; // Å/fs
    const n3 = bracket.prev.n * 3;

    const dtPs = bracket.next.timePs - bracket.prev.timePs;
    const t = bracket.alpha;
    const t2 = t * t;
    const t3 = t2 * t;

    // Cubic Hermite basis
    const h00 = 2 * t3 - 3 * t2 + 1;
    const h10 = t3 - 2 * t2 + t;
    const h01 = -2 * t3 + 3 * t2;
    const h11 = t3 - t2;

    for (let i = 0; i < n3; i++) {
      // Convert Å/fs → Å/ps, then multiply by interval duration to get tangents.
      const m0 = v0[i] * FS_PER_PS * dtPs;
      const m1 = v1[i] * FS_PER_PS * dtPs;
      outputBuffer[i] = h00 * p0[i] + h10 * m0 + h01 * p1[i] + h11 * m1;
    }
    return { kind: 'ok', n: bracket.prev.n };
  },
};

/** Catmull-Rom over a 4-frame window (f[i-1], f[i]=prev, f[i+1]=next, f[i+2]).
 *  Exact at interior knots (t=0 → prev, t=1 → next). Overshoot possible away
 *  from knots — experimental. */
const CatmullRomStrategy: InterpolationStrategy = {
  metadata: {
    id: 'catmull-rom',
    label: 'Catmull-Rom',
    stability: 'experimental',
    availability: 'product',
    requiresVelocities: false,
    requires4Frames: true,
  },
  run(input: InterpolationInput): InterpolationResult {
    const { bracket, window4, outputBuffer } = input;
    if (!window4) return { kind: 'decline', reason: 'insufficient-frames' };

    const p0 = window4.fMinus1.positions;
    const p1 = bracket.prev.positions;
    const p2 = bracket.next.positions;
    const p3 = window4.fPlus2.positions;
    const n3 = bracket.prev.n * 3;

    const t = bracket.alpha;
    const t2 = t * t;
    const t3 = t2 * t;

    // Standard Catmull-Rom basis (tau = 0.5)
    // q(t) = 0.5 * ( (2p1) + (-p0 + p2)*t + (2p0 - 5p1 + 4p2 - p3)*t² + (-p0 + 3p1 - 3p2 + p3)*t³ )
    for (let i = 0; i < n3; i++) {
      const a0 = 2 * p1[i];
      const a1 = -p0[i] + p2[i];
      const a2 = 2 * p0[i] - 5 * p1[i] + 4 * p2[i] - p3[i];
      const a3 = -p0[i] + 3 * p1[i] - 3 * p2[i] + p3[i];
      outputBuffer[i] = 0.5 * (a0 + a1 * t + a2 * t2 + a3 * t3);
    }
    return { kind: 'ok', n: bracket.prev.n };
  },
};

/** Maps BracketReason to FallbackReason for non-interpolatable brackets. */
const BRACKET_REASON_TO_FALLBACK: Readonly<Record<string, FallbackReason>> = {
  'bracket-n-mismatch': 'variable-n',
  'bracket-atomids-mismatch': 'atomids-mismatch',
};

// ── Runtime factory ──

export interface WatchTrajectoryInterpolation {
  /** Resolve positions at playback time `timePs` for the selected mode.
   *  `mode` is an InterpolationMethodId (string) — if the ID is not
   *  registered, the runtime falls back to linear with 'capability-declined'. */
  resolve(timePs: number, opts: { enabled: boolean; mode: InterpolationMethodId }): InterpolationResolveResult;
  /** Register (or replace) a strategy. Any string ID is accepted — dev-only
   *  or research methods can be registered without widening the productized
   *  WatchInterpolationMode union. Invalidates the cached metadata array. */
  registerStrategy(strategy: InterpolationStrategy): void;
  /** Unregister a strategy by id. Invalidates the cached metadata array. */
  unregisterStrategy(mode: InterpolationMethodId): void;
  /** Stable, frozen array of all registered method metadata. The reference
   *  only changes when the registry is mutated (register/unregister/dispose).
   *  Callers may filter by `availability` and `stability` as needed. */
  getRegisteredMethods(): readonly InterpolationMethodMetadata[];
  /** Reset cursor cache + last-frame diagnostic state. Called on file load. */
  reset(): void;
  /** Release internal state (output buffer reference, cursor cache, registry).
   *  Called on file unload or rollback when the runtime is replaced. */
  dispose(): void;
  /** Test / debug accessor — number of binary searches performed since last
   *  reset. Used by cursor-cache tests to verify the fast path. */
  getBinarySearchCount(): number;
}

export function createWatchTrajectoryInterpolation(
  history: LoadedFullHistory,
): WatchTrajectoryInterpolation {
  const denseFrames = history.denseFrames;
  const restartFrames = history.restartFrames;
  const capability = history.interpolationCapability;
  const maxAtomCount = history.simulation.maxAtomCount;

  // Preallocated output buffer sized to worst-case dense-prefix atom count.
  const outputBuffer = new Float64Array(Math.max(1, maxAtomCount) * 3);

  // Strategy registry — keyed by InterpolationMethodId (string). Accepts
  // arbitrary IDs so dev/research strategies can register without widening
  // the productized type.
  const registry = new Map<InterpolationMethodId, InterpolationStrategy>();
  registry.set(LinearStrategy.metadata.id, LinearStrategy);
  registry.set(HermiteStrategy.metadata.id, HermiteStrategy);
  registry.set(CatmullRomStrategy.metadata.id, CatmullRomStrategy);

  // Cached metadata array — stable frozen reference, rebuilt only on
  // register/unregister/dispose. Prevents snapshot churn from reference
  // inequality on every buildSnapshot() call.
  let _cachedMethods: readonly InterpolationMethodMetadata[] = rebuildMethodsCache();

  function rebuildMethodsCache(): readonly InterpolationMethodMetadata[] {
    return Object.freeze(Array.from(registry.values()).map(s => s.metadata));
  }

  // Bracket cursor cache — index of the currently-cached prev frame, or -1.
  let cursorIndex = -1;
  // Diagnostic counter for cursor-cache tests.
  let binarySearchCount = 0;

  // Last-frame diagnostic state — read by controller when building snapshot.
  let lastActive: InterpolationMethodId = 'linear';
  let lastFallback: FallbackReason = 'none';

  // ── Binary search for frame at-or-before timePs ──
  function bsearchAtOrBefore(timePs: number): number {
    const frames = denseFrames;
    if (frames.length === 0) return -1;
    let lo = 0;
    let hi = frames.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >>> 1;
      if (frames[mid].timePs <= timePs) lo = mid;
      else hi = mid - 1;
    }
    return frames[lo].timePs <= timePs ? lo : -1;
  }

  // ── Bracket lookup with cursor cache ──
  //
  // Policy (from plan):
  //   1. Same-bracket fast path: cache.prev.time <= t < cache.next.time → reuse O(1)
  //   2. One-step-forward fast path: t within next bracket → cursor++ O(1)
  //   3. Any other case → full binary search (backward/jump/wrap/first-call)
  //
  // Degeneracy: returns null at timeline edges and for single-frame history.
  function findBracket(
    timePs: number,
  ): { bracket: Bracket } | { degenerate: 'at-boundary' | 'single-frame' } {
    const n = denseFrames.length;
    if (n === 0) return { degenerate: 'single-frame' };
    if (n === 1) return { degenerate: 'single-frame' };

    const firstT = denseFrames[0].timePs;
    const lastT = denseFrames[n - 1].timePs;
    if (timePs <= firstT) return { degenerate: 'at-boundary' };
    if (timePs >= lastT) return { degenerate: 'at-boundary' };

    // Try cursor-cache fast paths.
    let prevIdx = -1;
    if (cursorIndex >= 0 && cursorIndex < n - 1) {
      const cPrev = denseFrames[cursorIndex];
      const cNext = denseFrames[cursorIndex + 1];
      if (timePs >= cPrev.timePs && timePs < cNext.timePs) {
        // Same-bracket fast path.
        prevIdx = cursorIndex;
      } else if (
        cursorIndex + 2 < n &&
        timePs >= cNext.timePs &&
        timePs < denseFrames[cursorIndex + 2].timePs
      ) {
        // One-step-forward fast path.
        prevIdx = cursorIndex + 1;
        cursorIndex = prevIdx;
      }
    }

    if (prevIdx < 0) {
      // Miss — full binary search.
      binarySearchCount++;
      prevIdx = bsearchAtOrBefore(timePs);
      if (prevIdx < 0 || prevIdx >= n - 1) return { degenerate: 'at-boundary' };
      cursorIndex = prevIdx;
    }

    const prev = denseFrames[prevIdx];
    const next = denseFrames[prevIdx + 1];
    const dt = next.timePs - prev.timePs;
    const alpha = dt > 0 ? (timePs - prev.timePs) / dt : 0;

    // Determine interpolatable via capability layer (per-bracket flag is
    // precomputed at import time).
    const interpolatable = capability.bracketSafe[prevIdx] === 1;

    return {
      bracket: {
        prev: { timePs: prev.timePs, n: prev.n, positions: prev.positions },
        next: { timePs: next.timePs, n: next.n, positions: next.positions },
        atomIds: prev.atomIds,
        alpha,
        interpolatable,
        prevIndex: prevIdx,
      },
    };
  }

  function atOrBeforeReference(
    timePs: number,
  ): { frame: NormalizedDenseFrame; fallbackReason: FallbackReason } {
    const n = denseFrames.length;
    if (n === 0) {
      // Defensive — callers guard with playback.isLoaded() upstream.
      throw new Error('watch-trajectory-interpolation: no dense frames loaded');
    }
    if (n === 1) {
      return { frame: denseFrames[0], fallbackReason: 'single-frame' };
    }
    // Use existing bsearch-at-or-before but DO increment binarySearchCount
    // because we are re-running a full search (cursor-cache miss by definition).
    binarySearchCount++;
    const firstT = denseFrames[0].timePs;
    const lastT = denseFrames[n - 1].timePs;
    if (timePs <= firstT) return { frame: denseFrames[0], fallbackReason: 'at-boundary' };
    if (timePs >= lastT) return { frame: denseFrames[n - 1], fallbackReason: 'at-boundary' };
    const idx = bsearchAtOrBefore(timePs);
    const safeIdx = idx < 0 ? 0 : idx;
    // Update cursor so subsequent resolve() calls on play-through can fast-path.
    cursorIndex = safeIdx < n - 1 ? safeIdx : safeIdx - 1;
    if (cursorIndex < 0) cursorIndex = 0;
    return { frame: denseFrames[safeIdx], fallbackReason: 'at-boundary' };
  }

  function buildVelocityPair(prevIdx: number): { v0: Float64Array; v1: Float64Array } | null {
    const r0 = capability.denseToRestartIndex[prevIdx];
    const r1 = capability.denseToRestartIndex[prevIdx + 1];
    if (r0 < 0 || r1 < 0) return null;
    return {
      v0: restartFrames[r0].velocities,
      v1: restartFrames[r1].velocities,
    };
  }

  function buildWindow4(
    prevIdx: number,
  ): { fMinus1: { positions: Float64Array }; fPlus2: { positions: Float64Array } } | null {
    if (capability.window4Safe[prevIdx] !== 1) return null;
    // window4Safe[prevIdx] === 1 guarantees prevIdx >= 1 and prevIdx + 2 < n,
    // so both array accesses are always in-bounds.
    return {
      fMinus1: { positions: denseFrames[prevIdx - 1].positions },
      fPlus2: { positions: denseFrames[prevIdx + 2].positions },
    };
  }

  function resolve(
    timePs: number,
    opts: { enabled: boolean; mode: InterpolationMethodId },
  ): InterpolationResolveResult {
    // ── 1. smoothPlayback disabled → at-or-before frame ──
    //     'disabled' trumps other reasons because the user explicitly opted out.
    if (!opts.enabled) {
      const { frame } = atOrBeforeReference(timePs);
      lastActive = 'linear';
      lastFallback = 'disabled';
      return {
        positions: frame.positions,
        n: frame.n,
        atomIds: frame.atomIds,
        selectedMode: opts.mode,
        activeMethod: 'linear',
        fallbackReason: 'disabled',
      };
    }

    // ── 2. Bracket lookup ──
    const lookup = findBracket(timePs);
    if ('degenerate' in lookup) {
      const { frame } = atOrBeforeReference(timePs);
      lastActive = 'linear';
      lastFallback = lookup.degenerate;
      return {
        positions: frame.positions,
        n: frame.n,
        atomIds: frame.atomIds,
        selectedMode: opts.mode,
        activeMethod: 'linear',
        fallbackReason: lookup.degenerate,
      };
    }
    const bracket = lookup.bracket;

    // ── 3. Non-interpolatable bracket → bracket.prev reference ──
    if (!bracket.interpolatable) {
      const fr = BRACKET_REASON_TO_FALLBACK[capability.bracketReason[bracket.prevIndex]]
        ?? 'capability-declined';
      lastActive = 'linear';
      lastFallback = fr;
      // Return importer's immutable at-or-before (bracket.prev) reference.
      return {
        positions: bracket.prev.positions,
        n: bracket.prev.n,
        atomIds: bracket.atomIds,
        selectedMode: opts.mode,
        activeMethod: 'linear',
        fallbackReason: fr,
      };
    }

    // ── 4. Resolve strategy + build optional inputs per metadata ──
    const selected = registry.get(opts.mode);
    // If the selected mode is not registered (tests may unregister), fall
    // back to linear over the bracket and report capability-declined.
    if (!selected) {
      linearRun({
        bracket,
        window4: null,
        velocityPair: null,
        outputBuffer,
      });
      lastActive = 'linear';
      lastFallback = 'capability-declined';
      return {
        positions: outputBuffer,
        n: bracket.prev.n,
        atomIds: bracket.atomIds,
        selectedMode: opts.mode,
        activeMethod: 'linear',
        fallbackReason: 'capability-declined',
      };
    }

    let velocityPair: InterpolationInput['velocityPair'] = null;
    let window4: InterpolationInput['window4'] = null;
    let shortCircuitReason: FallbackReason | null = null;

    if (selected.metadata.requiresVelocities) {
      if (capability.hermiteSafe[bracket.prevIndex] === 1) {
        velocityPair = buildVelocityPair(bracket.prevIndex);
        if (!velocityPair) {
          // Defensive — capability layer said yes but lookup failed.
          shortCircuitReason = 'velocities-unavailable';
        }
      } else {
        shortCircuitReason = 'velocities-unavailable';
      }
    }

    if (!shortCircuitReason && selected.metadata.requires4Frames) {
      if (capability.window4Safe[bracket.prevIndex] === 1) {
        window4 = buildWindow4(bracket.prevIndex);
        if (!window4) {
          shortCircuitReason = 'insufficient-frames';
        }
      } else {
        const wReason = capability.window4Reason[bracket.prevIndex];
        shortCircuitReason =
          wReason === 'timeline-edge' ? 'insufficient-frames' : 'window-mismatch';
      }
    }

    const input: InterpolationInput = {
      bracket,
      window4,
      velocityPair,
      outputBuffer,
    };

    // ── 5. Short-circuit → linear fallback over same bracket ──
    if (shortCircuitReason) {
      linearRun(input);
      lastActive = 'linear';
      lastFallback = shortCircuitReason;
      return {
        positions: outputBuffer,
        n: bracket.prev.n,
        atomIds: bracket.atomIds,
        selectedMode: opts.mode,
        activeMethod: 'linear',
        fallbackReason: shortCircuitReason,
      };
    }

    // ── 6. Run selected strategy; decline → linear fallback (full overwrite) ──
    const result = selected.run(input);
    if (result.kind === 'decline') {
      // Linear must do a full overwrite of [0, n*3) — enforced by linearRun's
      // straight-through write of all bracket.prev.n * 3 slots.
      linearRun(input);
      lastActive = 'linear';
      lastFallback = result.reason;
      return {
        positions: outputBuffer,
        n: bracket.prev.n,
        atomIds: bracket.atomIds,
        selectedMode: opts.mode,
        activeMethod: 'linear',
        fallbackReason: result.reason,
      };
    }

    // ── 7. Strategy succeeded ──
    lastActive = selected.metadata.id;
    lastFallback = 'none';
    return {
      positions: outputBuffer,
      n: result.n,
      atomIds: bracket.atomIds,
      selectedMode: opts.mode,
      activeMethod: selected.metadata.id,
      fallbackReason: 'none',
    };
  }

  function registerStrategy(strategy: InterpolationStrategy): void {
    registry.set(strategy.metadata.id, strategy);
    _cachedMethods = rebuildMethodsCache();
  }

  function unregisterStrategy(mode: InterpolationMethodId): void {
    registry.delete(mode);
    _cachedMethods = rebuildMethodsCache();
  }

  function getRegisteredMethods(): readonly InterpolationMethodMetadata[] {
    return _cachedMethods;
  }

  function reset(): void {
    cursorIndex = -1;
    binarySearchCount = 0;
    lastActive = 'linear';
    lastFallback = 'none';
  }

  function dispose(): void {
    cursorIndex = -1;
    binarySearchCount = 0;
    lastActive = 'linear';
    lastFallback = 'none';
    registry.clear();
    _cachedMethods = Object.freeze([]);
  }

  function getBinarySearchCount(): number {
    return binarySearchCount;
  }

  return {
    resolve,
    registerStrategy,
    unregisterStrategy,
    getRegisteredMethods,
    reset,
    dispose,
    getBinarySearchCount,
  };
}

// ── Exposed for tests that want to re-register built-ins after a test
//    unregistered them. Not part of the production controller surface. ──
export const BUILTIN_STRATEGIES: readonly InterpolationStrategy[] = [
  LinearStrategy,
  HermiteStrategy,
  CatmullRomStrategy,
];
