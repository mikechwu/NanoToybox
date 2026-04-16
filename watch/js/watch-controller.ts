/**
 * Watch controller facade — orchestration layer over domain services.
 *
 * Round 2: view service, analysis interaction, follow, highlight.
 * Round 5: transport + settings domain (theme, text-size).
 * Round 6: smooth playback runtime (interpolation strategies + unified render pipeline).
 *
 * Domains:
 *   - Document: watch-document-service.ts
 *   - Playback: watch-playback-model.ts
 *   - Analysis: watch-bonded-groups.ts (interaction state + highlight priority)
 *   - View: watch-view-service.ts (camera target, follow)
 *   - Settings: watch-settings.ts (viewer preferences — theme, text-size,
 *               smoothPlayback, interpolationMode)
 *   - Interpolation: watch-trajectory-interpolation.ts (strategy runtime,
 *               render-time reconstruction; owned by controller, recreated on
 *               file load/rollback, disposed on unload)
 *
 * Render pipeline: ALL render entry points (RAF tick, scrub/step, initial load,
 * rollback) route through the single applyReviewFrameAtTime() helper. That
 * helper is the only direct caller of interpolation.resolve() and
 * renderer.updateReviewFrame() — enforced by code review + a meta-test.
 */

import { createWatchDocumentService, type DocumentMetadata } from './watch-document-service';
import { createWatchPlaybackModel, type WatchPlaybackModel } from './watch-playback-model';
import { createWatchBondedGroups, type WatchBondedGroups } from './watch-bonded-groups';
import { createWatchViewService, type WatchViewService } from './watch-view-service';
import { createWatchRenderer, type WatchRenderer } from './watch-renderer';
import { createWatchCameraInput, type WatchCameraInput } from './watch-camera-input';
import {
  createWatchCinematicCameraService,
  type WatchCinematicCameraService,
} from './watch-cinematic-camera';
import { createWatchOverlayLayout, type WatchOverlayLayout } from './watch-overlay-layout';
import { createWatchBondedGroupAppearance, type WatchBondedGroupAppearance } from './watch-bonded-group-appearance';
import { createWatchSettings, type WatchSettings, type WatchInterpolationMode } from './watch-settings';
import {
  createWatchTrajectoryInterpolation,
  createWatchTrajectoryInterpolationForCapsule,
  type WatchTrajectoryInterpolation,
  type FallbackReason,
  type InterpolationMethodMetadata,
  type InterpolationMethodId,
} from './watch-trajectory-interpolation';
import type { LoadedFullHistory, ImportDiagnostic } from './full-history-import';
import type { LoadedWatchHistory } from './watch-playback-model';
import { VIEWER_DEFAULTS } from '../../src/config/viewer-defaults';
import type { BondedGroupSummary } from './watch-bonded-groups';
import { normalizeShareInput } from '../../src/share/share-code';
import type { ShareMetadataResponse } from '../../src/share/share-record';

/**
 * Discriminated progress state for the share/local-file open flow.
 *
 * Drives the centered open panel's stage copy and progress bar mode.
 * `openSharedCapsule` and `openFile` are the only writers; the
 * compatibility shim `loadingShareCode` on the public snapshot is
 * DERIVED from this field in `buildSnapshot()` / `baseEmptySnapshot()`.
 *
 * Invariant: every update assigns a FRESH object. In-place mutation
 * would silently defeat the identity check in `snapshotChanged()`
 * and freeze the loading UI mid-download.
 */
export type WatchOpenProgress =
  | { kind: 'idle' }
  | { kind: 'share'; code: string; stage: 'metadata' }
  | {
      kind: 'share';
      code: string;
      stage: 'download';
      loadedBytes: number;
      /** From `normalizeTotalBytes(meta.sizeBytes)`; `null` when
       *  metadata omitted or rejected the size. */
      totalBytes: number | null;
    }
  | { kind: 'share'; code: string; stage: 'prepare' }
  | { kind: 'file'; fileName: string; stage: 'prepare' };

/**
 * Normalize a `sizeBytes` candidate to a safe positive integer byte
 * count, or `null` when the value cannot drive a determinate bar.
 *
 * Rejects: missing, zero, negative, NaN, non-integer (e.g. 1000.5),
 * non-number. Byte counts are inherently integer; percent math and
 * progress semantics stay grounded in real byte boundaries.
 */
export function normalizeTotalBytes(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    ? value
    : null;
}

/**
 * Clamp a loaded-bytes value to the metadata-reported total (when
 * known), so every download-stage publish satisfies the determinate-
 * progress invariant `loadedBytes <= totalBytes`. Used by ALL
 * download publishes — throttled, initial-0, and completion — so the
 * controller snapshot stays coherent regardless of which branch
 * captured the last tick. The raw (unclamped) counter stays
 * function-local for the over-download `console.warn` payload and
 * for assembling the blob. When `totalBytes` is null (unknown-size
 * metadata), the value passes through unchanged — indeterminate
 * downloads have no invariant to enforce.
 */
export function clampLoadedBytes(loadedBytes: number, totalBytes: number | null): number {
  return totalBytes == null ? loadedBytes : Math.min(loadedBytes, totalBytes);
}

export interface WatchControllerSnapshot {
  loaded: boolean;
  playing: boolean;
  currentTimePs: number;
  startTimePs: number;
  endTimePs: number;
  groups: BondedGroupSummary[];
  atomCount: number;
  frameCount: number;
  maxAtomCount: number;
  fileKind: string | null;
  fileName: string | null;
  error: string | null;
  // ── Round 2: interaction state ──
  hoveredGroupId: string | null;
  following: boolean;
  followedGroupId: string | null;
  // ── Round 5: transport + settings ──
  speed: number;
  repeat: boolean;
  playDirection: 1 | -1 | 0;
  theme: 'dark' | 'light';
  textSize: 'normal' | 'large';
  // ── Round 6: smooth playback ──
  smoothPlayback: boolean;
  interpolationMode: WatchInterpolationMode;
  /** What the runtime actually used for the last rendered frame. This is a
   *  string (InterpolationMethodId) rather than the closed WatchInterpolationMode
   *  union because the registry can hold dev/research strategies with arbitrary
   *  IDs. For productized methods, the value will still be 'linear', 'hermite',
   *  or 'catmull-rom'. */
  activeInterpolationMethod: InterpolationMethodId;
  lastFallbackReason: FallbackReason;
  importDiagnostics: readonly ImportDiagnostic[];
  /** Discriminated open-flow state. Sole writer of the loading UX.
   *  `loadingShareCode` is derived from this field (see below). */
  openProgress: WatchOpenProgress;
  /** Derived from `openProgress`:
   *    openProgress.kind === 'share' ? openProgress.code : null
   *  Retained as a separate field for short-term reader compatibility
   *  (WatchTopBar's submit guard). Do not write it directly — only
   *  write `openProgress` and let `buildSnapshot` derive this. */
  loadingShareCode: string | null;
  // ── Cinematic Camera ──
  /** User-controlled on/off. Defaults to true; survives file reload
   *  within a session; resets to default on fresh page load. */
  cinematicCameraEnabled: boolean;
  /** UI-truth: `enabled && !pausedForUserInput && eligibleClusterCount > 0
   *  && !viewService.isFollowing()`. Computed once per `buildSnapshot`. */
  cinematicCameraActive: boolean;
  /** True within the configured cooldown window after user camera
   *  input (see `CinematicCameraConfig.userIdleResumeMs`). */
  cinematicCameraPausedForUserInput: boolean;
  /** Number of large clusters feeding the current framing target. 0 →
   *  "Waiting for major clusters". */
  cinematicCameraEligibleClusterCount: number;
}

export interface WatchController {
  getSnapshot(): WatchControllerSnapshot;
  subscribe(callback: () => void): () => void;
  openFile(file: File): Promise<void>;
  openSharedCapsule(input: string): Promise<void>;
  togglePlay(): void;
  scrub(timePs: number): void;
  // ── Round 2: interaction commands ──
  hoverGroup(id: string | null): void;
  centerOnGroup(id: string): void;
  followGroup(id: string): void;
  unfollowGroup(): void;
  // ── Round 4: color commands ──
  applyGroupColor(groupId: string, colorHex: string): void;
  clearGroupColor(groupId: string): void;
  getGroupColorState(groupId: string): import('../../src/appearance/bonded-group-color-assignments').GroupColorState;
  // ── Round 5: transport + settings commands ──
  setSpeed(speed: number): void;
  toggleRepeat(): void;
  stepForward(): void;
  stepBackward(): void;
  startDirectionalPlayback(direction: 1 | -1): void;
  stopDirectionalPlayback(): void;
  setTheme(theme: 'dark' | 'light'): void;
  setTextSize(size: 'normal' | 'large'): void;
  // ── Round 6: smooth playback commands ──
  setSmoothPlayback(enabled: boolean): void;
  setInterpolationMode(mode: WatchInterpolationMode): void;
  getRegisteredInterpolationMethods(): readonly InterpolationMethodMetadata[];
  // ── Cinematic Camera ──
  setCinematicCameraEnabled(enabled: boolean): void;
  // ── Runtime access ──
  getPlaybackModel(): WatchPlaybackModel;
  getBondedGroups(): WatchBondedGroups;
  /** Test/debug access to the interpolation runtime. Not consumed by
   *  production UI code. */
  getInterpolationRuntime(): WatchTrajectoryInterpolation | null;
  createRenderer(container: HTMLElement): WatchRenderer;
  getRenderer(): WatchRenderer | null;
  detachRenderer(): void;
  dispose(): void;
}

const EMPTY_DIAGNOSTICS: readonly ImportDiagnostic[] = Object.freeze([]);
const EMPTY_METHODS: readonly InterpolationMethodMetadata[] = Object.freeze([]);

const IDLE_OPEN_PROGRESS: WatchOpenProgress = Object.freeze({ kind: 'idle' as const }) as WatchOpenProgress;

const EMPTY_SNAPSHOT: WatchControllerSnapshot = {
  loaded: false, playing: false, currentTimePs: 0, startTimePs: 0, endTimePs: 0,
  groups: [], atomCount: 0, frameCount: 0, maxAtomCount: 0,
  fileKind: null, fileName: null, error: null,
  hoveredGroupId: null, following: false, followedGroupId: null,
  speed: 1, repeat: true, playDirection: 0, theme: VIEWER_DEFAULTS.defaultTheme, textSize: 'normal',
  smoothPlayback: true, interpolationMode: 'linear',
  activeInterpolationMethod: 'linear', lastFallbackReason: 'none',
  importDiagnostics: EMPTY_DIAGNOSTICS,
  openProgress: IDLE_OPEN_PROGRESS,
  loadingShareCode: null,
  cinematicCameraEnabled: false,
  cinematicCameraActive: false,
  cinematicCameraPausedForUserInput: false,
  cinematicCameraEligibleClusterCount: 0,
};

/** Derive the compatibility shim from the authoritative field. */
function deriveLoadingShareCode(progress: WatchOpenProgress): string | null {
  return progress.kind === 'share' ? progress.code : null;
}

export function createWatchController(): WatchController {
  const documentService = createWatchDocumentService();
  const playback = createWatchPlaybackModel();
  const bondedGroups = createWatchBondedGroups();
  const viewService = createWatchViewService();
  const cinematicCamera = createWatchCinematicCameraService();
  const settings = createWatchSettings(VIEWER_DEFAULTS.defaultTheme);
  const appearance = createWatchBondedGroupAppearance({
    getBondedGroups: () => bondedGroups,
    getPlaybackModel: () => playback,
    getRenderer: () => renderer,
  });
  let renderer: WatchRenderer | null = null;
  let cameraInput: WatchCameraInput | null = null;
  let overlayLayout: WatchOverlayLayout | null = null;
  let interpolation: WatchTrajectoryInterpolation | null = null;
  /** Last-frame diagnostic state from interpolation.resolve(). Kept on the
   *  controller so snapshot publication has a cheap read path — the runtime
   *  also owns this state but we cache it here to avoid another call per
   *  snapshot build. */
  let _lastActiveMethod: InterpolationMethodId = 'linear';
  let _lastFallbackReason: FallbackReason = 'none';
  let _lastImportDiagnostics: readonly ImportDiagnostic[] = EMPTY_DIAGNOSTICS;

  let _snapshot: WatchControllerSnapshot = { ...EMPTY_SNAPSHOT };
  const _listeners = new Set<() => void>();
  let _rafId = 0;
  let _lastTimestamp = 0;
  /** Monotonic counter bumped on every open start (local `openFile`
   *  AND remote `openSharedCapsule`). Each open captures its own
   *  value and rechecks at every async boundary to detect a
   *  concurrent second open — including a local file picker chosen
   *  before a share auto-open begins, or rapid double-submit from
   *  WatchTopBar, or a `?c=` auto-open racing a user click. A stale
   *  run bails instead of overwriting the newer run's state. */
  let _openGeneration = 0;

  function notify() {
    for (const cb of _listeners) {
      try { cb(); } catch (e) { console.error('[watch] listener error:', e); }
    }
  }

  function updateAnalysis() {
    if (!playback.isLoaded()) return;
    const timePs = playback.getCurrentTimePs();
    const topology = playback.getTopologyAtTime(timePs);
    bondedGroups.updateForTime(timePs, topology);
  }

  /** Apply current highlight to renderer based on analysis domain priority. */
  function applyHighlight() {
    if (!renderer) return;
    const result = bondedGroups.resolveHighlight();
    if (result) {
      renderer.setGroupHighlight(result.atomIndices, result.intensity);
    } else {
      renderer.clearGroupHighlight();
    }
  }

  /** Single source of truth for producing + applying a rendered frame at a
   *  given playback time. Called by RAF tick (with render=false), scrub/step,
   *  initial load, and rollback (all with render=true).
   *
   *  Does NOT call viewService.updateFollow() — follow is rate-based (uses
   *  real dtMs for exponential easing) and therefore belongs in the RAF tick
   *  loop, NOT in the render helper. The tick loop calls this helper with
   *  render=false, then calls updateFollow(dtMs, renderer), then
   *  renderer.render(). Scrub/load/rollback call this helper with render=true
   *  and do not touch follow (current behavior preserved).
   *
   *  This is the ONLY function in the controller that invokes interpolation
   *  or renderer.updateReviewFrame(). All other render paths must route
   *  through here — direct calls are a bug. */
  function applyReviewFrameAtTime(timePs: number, opts: { render: boolean }): void {
    if (!renderer || !playback.isLoaded() || !interpolation) return;

    // 1. Resolve positions via the interpolation runtime (always — the
    //    runtime handles smoothPlayback=off, boundary degeneracy, capability
    //    decline, and linear fallback internally).
    const resolved = interpolation.resolve(timePs, {
      enabled: settings.getSmoothPlayback(),
      mode: settings.getInterpolationMode(),
    });
    _lastActiveMethod = resolved.activeMethod;
    _lastFallbackReason = resolved.fallbackReason;

    // 2. Discrete topology (still dense-prefix, not interpolated in Round 6).
    const topology = playback.getTopologyAtTime(timePs);

    // 3. Apply frame geometry — renderer retains `resolved.positions` by
    //    reference in _reviewPositions, which display-aware queries (follow,
    //    highlight, centroid) will read between now and the next
    //    updateReviewFrame call.
    renderer.updateReviewFrame(resolved.positions, resolved.n, topology?.bonds ?? []);

    // 4. Authored color projection for this frame's atomId ordering.
    appearance.projectAndSync(timePs);

    // 5. Bonded-group topology / analysis state (discrete, unchanged).
    updateAnalysis();

    // 6. Highlight layer — reads renderer's displayed positions via
    //    _applyHighlightLayer, so highlight geometry automatically tracks
    //    the interpolated buffer from step 3 without special handling.
    applyHighlight();

    // 7. Final render (optional — RAF tick sets render=false and renders
    //    AFTER calling updateFollow separately; scrub/load/rollback set
    //    render=true).
    if (opts.render) renderer.render();
  }

  /** Immediate render-sync at current playback time. Used by scrub, step,
   *  rollback. Routes through the unified helper with render=true. */
  function renderAtCurrentTime() {
    applyReviewFrameAtTime(playback.getCurrentTimePs(), { render: true });
  }

  /** Viewer preferences are user-owned and independent of whether a file is
   *  loaded. Surface them even in the empty-snapshot path so the UI can
   *  reflect toggle changes in the empty-state open panel.
   *  `openProgress` is preserved from `_snapshot` (not zeroed) so the
   *  `?c=` auto-open path reliably propagates the loading state while
   *  `!playback.isLoaded()`. `loadingShareCode` is derived. */
  /** Single source of truth for the UI-truth `cinematicCameraActive`
   *  field. `cs.active` already combines `enabled`, `pausedForUserInput`
   *  and `eligibleClusterCount`; the controller AND's with
   *  `!viewService.isFollowing()` because the service itself cannot
   *  see the follow state. */
  function computeCinematicCameraActive(): boolean {
    return cinematicCamera.getState().active && !viewService.isFollowing();
  }

  function baseEmptySnapshot(): WatchControllerSnapshot {
    const cs = cinematicCamera.getState();
    return {
      ...EMPTY_SNAPSHOT,
      error: _snapshot.error,
      theme: settings.getTheme(),
      textSize: settings.getTextSize(),
      smoothPlayback: settings.getSmoothPlayback(),
      interpolationMode: settings.getInterpolationMode(),
      activeInterpolationMethod: _lastActiveMethod,
      lastFallbackReason: _lastFallbackReason,
      importDiagnostics: _lastImportDiagnostics,
      openProgress: _snapshot.openProgress,
      loadingShareCode: deriveLoadingShareCode(_snapshot.openProgress),
      cinematicCameraEnabled: cs.enabled,
      cinematicCameraActive: computeCinematicCameraActive(),
      cinematicCameraPausedForUserInput: cs.pausedForUserInput,
      cinematicCameraEligibleClusterCount: cs.eligibleClusterCount,
    };
  }

  function buildSnapshot(): WatchControllerSnapshot {
    if (!playback.isLoaded()) return baseEmptySnapshot();
    const meta = documentService.getMetadata();
    if (!meta.fileName) return baseEmptySnapshot();

    const cs = cinematicCamera.getState();
    const cinematicCameraActive = computeCinematicCameraActive();

    return {
      loaded: true,
      playing: playback.isPlaying(),
      currentTimePs: playback.getCurrentTimePs(),
      startTimePs: playback.getStartTimePs(),
      endTimePs: playback.getEndTimePs(),
      groups: bondedGroups.getSummaries(),
      atomCount: meta.atomCount,
      frameCount: meta.frameCount,
      maxAtomCount: meta.maxAtomCount,
      fileKind: meta.fileKind,
      fileName: meta.fileName,
      error: _snapshot.error,
      hoveredGroupId: bondedGroups.getHoveredGroupId(),
      following: viewService.isFollowing(),
      followedGroupId: viewService.isFollowing()
        ? (viewService.getTargetRef()?.groupId ?? null)
        : null,
      speed: playback.getSpeed(),
      repeat: playback.getRepeat(),
      playDirection: playback.getPlaybackDirection(),
      theme: settings.getTheme(),
      textSize: settings.getTextSize(),
      smoothPlayback: settings.getSmoothPlayback(),
      interpolationMode: settings.getInterpolationMode(),
      activeInterpolationMethod: _lastActiveMethod,
      lastFallbackReason: _lastFallbackReason,
      importDiagnostics: _lastImportDiagnostics,
      openProgress: _snapshot.openProgress,
      loadingShareCode: deriveLoadingShareCode(_snapshot.openProgress),
      cinematicCameraEnabled: cs.enabled,
      cinematicCameraActive,
      cinematicCameraPausedForUserInput: cs.pausedForUserInput,
      cinematicCameraEligibleClusterCount: cs.eligibleClusterCount,
    };
  }

  function snapshotChanged(a: WatchControllerSnapshot, b: WatchControllerSnapshot): boolean {
    return a.loaded !== b.loaded || a.playing !== b.playing
      || a.currentTimePs !== b.currentTimePs || a.startTimePs !== b.startTimePs
      || a.endTimePs !== b.endTimePs || a.frameCount !== b.frameCount
      || a.maxAtomCount !== b.maxAtomCount || a.fileKind !== b.fileKind
      || a.fileName !== b.fileName || a.error !== b.error
      || a.groups !== b.groups || a.atomCount !== b.atomCount
      || a.hoveredGroupId !== b.hoveredGroupId
      || a.following !== b.following || a.followedGroupId !== b.followedGroupId
      || a.speed !== b.speed || a.repeat !== b.repeat || a.playDirection !== b.playDirection
      || a.theme !== b.theme || a.textSize !== b.textSize
      || a.smoothPlayback !== b.smoothPlayback
      || a.interpolationMode !== b.interpolationMode
      || a.activeInterpolationMethod !== b.activeInterpolationMethod
      || a.lastFallbackReason !== b.lastFallbackReason
      || a.importDiagnostics !== b.importDiagnostics
      // `openProgress` is immutable — identity compare catches any
      // fresh-object mutation (including different `loadedBytes` during
      // streaming). `loadingShareCode` is derived, but we still compare
      // it as a cheap defensive safety net against a future direct
      // write.
      || a.openProgress !== b.openProgress
      || a.loadingShareCode !== b.loadingShareCode
      || a.cinematicCameraEnabled !== b.cinematicCameraEnabled
      || a.cinematicCameraActive !== b.cinematicCameraActive
      || a.cinematicCameraPausedForUserInput !== b.cinematicCameraPausedForUserInput
      || a.cinematicCameraEligibleClusterCount !== b.cinematicCameraEligibleClusterCount;
  }

  /**
   * Atomic terminal mutation helper.
   *
   * Captures the previous PUBLIC snapshot before the mutation,
   * rebuilds the derived snapshot from the mutated internal state,
   * compares the two, and fires subscribers exactly when the public
   * state changed.
   *
   * Why this exists: naive `_snapshot = { ... }; publishSnapshot()`
   * comparisons run `snapshotChanged(_snapshot, buildSnapshot())`
   * against the already-mutated `_snapshot`, so the comparator can
   * return `false` when the mutation happened to equal its own
   * derived form — dropping the terminal notification. The previous
   * direct `notify()` avoided that by bypassing the comparator
   * entirely, but then `buildSnapshot`'s derived fields never re-ran.
   * This helper fixes both: real derivation AND real comparison.
   *
   * Invariant: `_snapshot` is always the last published public
   * snapshot, plus any pending edits the current mutation is about
   * to commit. If future code wants to store internal-only state
   * here (retry counters, caches, etc.), split `_snapshot` into
   * `internalState` + `publishedSnapshot` rather than overloading.
   */
  function commitSnapshotMutation(
    mutate: (current: WatchControllerSnapshot) => WatchControllerSnapshot,
  ) {
    const previous = _snapshot;
    _snapshot = mutate(_snapshot);
    const next = buildSnapshot();
    _snapshot = next;
    if (snapshotChanged(previous, next)) notify();
  }

  function setErrorKeepingCurrentState(error: string) {
    // Terminal failure of the open flow: clear `openProgress` AND
    // set `error` atomically. The derived `loadingShareCode` clears
    // automatically via `buildSnapshot`, and `commitSnapshotMutation`
    // compares against the previously-published snapshot so the
    // subscriber fires exactly once for this terminal transition.
    commitSnapshotMutation((current) => ({
      ...current,
      error,
      openProgress: { kind: 'idle' },
    }));
  }

  /**
   * Every `openProgress` transition must route through this helper so
   * the notify fires against the previously-PUBLISHED snapshot — not
   * against the snapshot we just mutated. Direct
   * `_snapshot.openProgress = …; publishSnapshot()` would compare
   * against the same object and silently drop the notification
   * whenever `buildSnapshot` re-reads the freshly-mutated
   * `_snapshot.openProgress` (which is always, since it's a mirrored
   * field). This matters for every metadata/download/prepare
   * transition, not just the terminal error path.
   */
  function commitOpenProgress(
    progress: WatchOpenProgress,
    extra?: Partial<WatchControllerSnapshot>,
  ) {
    commitSnapshotMutation((current) => ({
      ...current,
      ...extra,
      openProgress: progress,
    }));
  }

  function publishSnapshot() {
    const next = buildSnapshot();
    if (!snapshotChanged(_snapshot, next)) return;
    _snapshot = next;
    notify();
  }

  // ── Interpolation runtime lifecycle helpers ──

  /** Dispose any existing runtime and create a fresh one for `history`.
   *  Full-history files use the standard factory. Reduced files use a
   *  dedicated factory that computes a minimal capability layer internally. */
  function installInterpolationRuntime(history: LoadedWatchHistory): void {
    if (interpolation) interpolation.dispose();
    if (history.kind === 'full') {
      interpolation = createWatchTrajectoryInterpolation(history);
      _lastImportDiagnostics = history.importDiagnostics;
    } else {
      interpolation = createWatchTrajectoryInterpolationForCapsule(history);
      _lastImportDiagnostics = EMPTY_DIAGNOSTICS;
    }
    _lastActiveMethod = 'linear';
    _lastFallbackReason = 'none';
  }

  /** Release the interpolation runtime — called on unload. */
  function teardownInterpolationRuntime(): void {
    if (interpolation) {
      interpolation.dispose();
      interpolation = null;
    }
    _lastActiveMethod = 'linear';
    _lastFallbackReason = 'none';
    _lastImportDiagnostics = EMPTY_DIAGNOSTICS;
  }

  // ── RAF loop ──

  function tick(timestamp: number) {
    _rafId = requestAnimationFrame(tick);

    let dtMs = 0;
    try {
      if (_lastTimestamp > 0) {
        dtMs = timestamp - _lastTimestamp;
        playback.advance(dtMs);
      }
      _lastTimestamp = timestamp;
    } catch (e) {
      stopRAF();
      console.error('[watch] playback tick error:', e);
      _snapshot = { ...EMPTY_SNAPSHOT, error: `Playback error: ${e instanceof Error ? e.message : String(e)}` };
      notify();
      return;
    }

    // ── Round 6 tick order ──
    //   Step 1: unified render pipeline (resolve → updateReviewFrame →
    //           appearance → analysis → highlight). No follow, no final render.
    //   Step 2: rate-based camera follow using real dtMs. Must run AFTER the
    //           helper (so _reviewPositions reflects the interpolated frame)
    //           and BEFORE the final render (so camera position is current
    //           for this frame).
    //   Step 3: final composited render.
    //   Step 4: publish snapshot.
    if (renderer && playback.isLoaded()) {
      try {
        applyReviewFrameAtTime(playback.getCurrentTimePs(), { render: false });
      } catch (e) {
        console.error('[watch] render error (non-fatal):', e);
      }
    }

    // Narrow try blocks: a throw inside follow / cinematic / render /
    // publish must not short-circuit the OTHER subsystems. A single
    // outer catch was swallowing a cinematic failure + skipping the
    // final render, leaving the user with a frozen scene AND no
    // snapshot update.
    if (renderer) {
      try {
        if (viewService.isFollowing()) {
          viewService.updateFollow(dtMs, renderer);
        } else if (cinematicCamera.getState().enabled) {
          cinematicCamera.update({
            dtMs,
            nowMs: timestamp,
            playbackSpeed: playback.getSpeed(),
            renderer,
            bondedGroups,
            manualFollowActive: false,
          });
        }
      } catch (e) {
        console.error('[watch] camera update error (non-fatal):', e);
      }

      try {
        renderer.render();
      } catch (e) {
        console.error('[watch] render error (non-fatal):', e);
      }
    }

    try {
      publishSnapshot();
    } catch (e) {
      console.error('[watch] publishSnapshot error (non-fatal):', e);
    }
  }

  function startRAF() {
    _lastTimestamp = 0;
    // Defensive guard for non-browser environments (Node-based unit
    // tests that exercise openFile end-to-end without a jsdom shim).
    // Production Lab/Watch always has rAF; the guard is a silent
    // no-op when absent. Without it, a missing rAF throws inside the
    // openFile success path, triggers the catch block's rollback, and
    // the public snapshot reports loaded:false even though playback
    // loaded correctly.
    if (typeof requestAnimationFrame === 'undefined') return;
    if (_rafId && typeof cancelAnimationFrame !== 'undefined') cancelAnimationFrame(_rafId);
    _rafId = requestAnimationFrame(tick);
  }

  function stopRAF() {
    if (_rafId && typeof cancelAnimationFrame !== 'undefined') {
      cancelAnimationFrame(_rafId); _rafId = 0;
    } else if (_rafId) {
      _rafId = 0;
    }
  }

  function detachRenderer() {
    if (overlayLayout) { overlayLayout.destroy(); overlayLayout = null; }
    if (cameraInput) { cameraInput.destroy(); cameraInput = null; }
    if (renderer) { renderer.destroy(); renderer = null; }
  }

  /**
   * Private prepare pipeline shared by `openFile` (local) and
   * `openSharedCapsule` (remote).
   *
   * `progressOwnership` controls who owns the `openProgress` lifecycle:
   *   - `'self'`   — this helper sets `{ kind: 'file', fileName, stage: 'prepare' }`
   *                  on entry and `{ kind: 'idle' }` on exit (terminal
   *                  error OR success). Used by public `openFile`.
   *   - `'caller'` — caller is already in its own `{ kind: 'share', …,
   *                  stage: 'prepare' }` and is responsible for the
   *                  terminal transition. Used by `openSharedCapsule`
   *                  so the share-code context survives the whole flow.
   *
   * Transactional rollback behavior is unchanged from the previous
   * inline implementation.
   */
  async function openPreparedFile(
    file: File,
    opts: {
      progressOwnership: 'self' | 'caller';
      /** Called at every destructive commit boundary. Returning
       *  `false` aborts the prepare pipeline BEFORE documentService
       *  commits, playback.load runs, or the renderer is
       *  reinitialised. Used by `openSharedCapsule` to cancel an
       *  older share open whose blob finished downloading after a
       *  newer share started (the generation counter returns false
       *  via `!isStale()`). Omit or return `true` for unconditional
       *  continuation (the default for local-file opens). */
      shouldContinue?: () => boolean;
    },
  ): Promise<void> {
    const canContinue = () => opts.shouldContinue?.() ?? true;

    if (opts.progressOwnership === 'self') {
      commitOpenProgress({ kind: 'file', fileName: file.name, stage: 'prepare' });
    }

    const result = await documentService.prepare(file);
    if (!canContinue()) return;
    if (result.status === 'error') {
      // setErrorKeepingCurrentState clears openProgress atomically —
      // works for both ownership modes.
      setErrorKeepingCurrentState(result.message);
      return;
    }

    const { history, fileName } = result;
    const prevDocMeta = documentService.saveForRollback();
    const prevHistory = playback.getLoadedHistory();
    const prevTimePs = playback.getCurrentTimePs();
    const prevDirection = playback.getPlaybackDirection();
    const prevAppearance = [...appearance.getAssignments()];
    const prevSpeed = playback.getSpeed();
    const prevRepeat = playback.getRepeat();
    const wasRunning = _rafId !== 0;

    try {
      // Last re-entry gate BEFORE any destructive mutation. If a
      // second open superseded us during `documentService.prepare`
      // above, bail now — documentService.commit + playback.load
      // are irreversible-visible operations and must not run for a
      // stale request.
      if (!canContinue()) return;
      stopRAF();
      documentService.commit(history, fileName);
      playback.load(history);
      // Appearance reset before first render — prevents stale color flash from prior file.
      // bondedGroups/viewService reset AFTER render — they don't affect visual state,
      // and deferring them preserves rollback safety (if renderer init fails, follow/hover
      // state is never cleared, so rollback doesn't need to restore them).
      appearance.reset();
      if (history.kind === 'capsule' && history.appearance) {
        appearance.importColorAssignments(history.appearance.colorAssignments);
      }
      // Round 6: install a fresh interpolation runtime sized to the new file's
      // maxAtomCount and bound to its capability layer. Must precede the first
      // applyReviewFrameAtTime call.
      installInterpolationRuntime(history);
      if (renderer) {
        renderer.initForPlayback(history.simulation.maxAtomCount);
        applyReviewFrameAtTime(playback.getCurrentTimePs(), { render: true });
      }
      // Reset interaction/view state after all risky init succeeded.
      // This ensures rollback preserves prior follow/hover state naturally.
      bondedGroups.reset();
      viewService.reset();
      cinematicCamera.resetForFile();
      updateAnalysis();
      // Success: clear error AND reset openProgress → idle in ONE
      // snapshot update so the subscriber fires exactly once with
      // the loaded workspace state. `playback.isLoaded()` has just
      // flipped to true, so `buildSnapshot`'s domain delta guarantees
      // `snapshotChanged` fires even though the helper compares
      // against the previously-published snapshot.
      // Auto-play: start forward playback so the user sees motion as
      // soon as the workspace appears. Must run BEFORE the snapshot
      // commit so the first published snapshot has `playing: true`.
      // Guard against single-frame files where start === end
      // (advance() would produce NaN via modulo-zero with repeat on).
      if (playback.getEndTimePs() > playback.getStartTimePs()) {
        playback.startPlayback();
      }
      commitOpenProgress({ kind: 'idle' }, { error: null });
      startRAF();
    } catch (e) {
      console.error('[watch] playback init error:', e);
      documentService.restoreFromRollback(prevDocMeta);
      if (prevHistory) {
        try {
          playback.load(prevHistory);
          playback.setSpeed(prevSpeed);
          playback.setRepeat(prevRepeat);
          playback.setCurrentTimePs(prevTimePs);
          if (prevDirection !== 0) playback.startDirectionalPlayback(prevDirection);
          // Restore prior authored colors (cleared by appearance.reset() above)
          appearance.restoreAssignments(prevAppearance);
          // Fully restore the visual scene
          if (renderer) renderer.initForPlayback(prevHistory.simulation.maxAtomCount);
          // Round 6: recreate interpolation runtime against the ROLLED-BACK file
          // BEFORE calling renderAtCurrentTime(). Without this step the helper
          // would invoke a runtime still sized for the failed file.
          installInterpolationRuntime(prevHistory);
          renderAtCurrentTime();
          if (wasRunning) startRAF();
        } catch (rollbackErr) {
          console.error('[watch] rollback also failed:', rollbackErr);
        }
      } else {
        // No prior history to roll back to — tear down the orphaned runtime
        // that was installed for the failed file so subsequent calls don't
        // see stale capability metadata or import diagnostics.
        teardownInterpolationRuntime();
      }
      setErrorKeepingCurrentState(`Failed to initialize playback: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // ── Public facade ──

  return {
    getSnapshot: () => _snapshot,

    subscribe(callback) {
      _listeners.add(callback);
      return () => { _listeners.delete(callback); };
    },

    async openFile(file) {
      // Public entry — drag/drop + Open-File button. Owns the
      // `openProgress` lifecycle as `{ kind: 'file', … }` for the
      // duration of the prepare pipeline. Shares the open-generation
      // counter with `openSharedCapsule` so a user picking a local
      // file while a share is in flight (or vice versa) aborts the
      // losing flow BEFORE it commits destructive state.
      const myGen = ++_openGeneration;
      const isStale = () => _openGeneration !== myGen;
      await openPreparedFile(file, {
        progressOwnership: 'self',
        shouldContinue: () => !isStale(),
      });
    },

    async openSharedCapsule(input) {
      // Re-entry guard: capture our generation at start, BEFORE
      // validation. Every user open attempt (even an invalid-code
      // rejection) must supersede an in-flight older open so the
      // stale flow bails at its next `await` and cannot commit a
      // file after the user's last action was an invalid-code
      // rejection. The counter is shared across openFile and
      // openSharedCapsule so the two flows are mutually exclusive
      // at the controller layer.
      const myGen = ++_openGeneration;
      const isStale = () => _openGeneration !== myGen;

      const code = normalizeShareInput(input);
      if (!code) {
        setErrorKeepingCurrentState('Invalid share code or URL');
        return;
      }

      // Stage 1 — metadata. Commit so the loading panel renders
      // immediately even on fast networks.
      commitOpenProgress({ kind: 'share', code, stage: 'metadata' }, { error: null });

      try {
        // Fetch + parse metadata. The parse itself is new — PR 1
        // consumes `meta.sizeBytes` as `totalBytes` for determinate
        // progress. Malformed JSON (HTML error page, aborted body)
        // surfaces as the existing "Failed to load shared capsule"
        // error through the outer catch.
        const metaRes = await fetch(`/api/capsules/${code}`);
        if (isStale()) return;
        if (!metaRes.ok) {
          setErrorKeepingCurrentState(
            metaRes.status === 404 ? 'Shared capsule not found' : `Failed to load shared capsule (${metaRes.status})`,
          );
          return;
        }
        let meta: ShareMetadataResponse;
        try {
          meta = (await metaRes.json()) as ShareMetadataResponse;
        } catch (parseErr) {
          if (isStale()) return;
          // Preserve the underlying parse-error detail for operators —
          // e.g. "Unexpected token '<'" indicates the server returned
          // an HTML error page instead of JSON. Without this log, all
          // malformed-metadata failures look identical in devtools.
          console.error('[watch] metadata JSON parse failed:', parseErr);
          setErrorKeepingCurrentState('Failed to load shared capsule');
          return;
        }
        if (isStale()) return;

        // Fetch the blob response (headers first; body is streamed
        // below).
        const blobRes = await fetch(`/api/capsules/${code}/blob`);
        if (isStale()) return;
        if (!blobRes.ok) {
          setErrorKeepingCurrentState('Failed to download shared capsule');
          return;
        }
        const contentType = blobRes.headers.get('Content-Type') ?? 'application/json';

        // Stage 2 — download. Force-publish the 0-byte,
        // totalBytes-known entry so the determinate bar renders at
        // 0% while the first chunk is in flight (prevents a visible
        // mode flip mid-download).
        const normalizedTotal = normalizeTotalBytes(meta.sizeBytes);
        // `warnOnOverDownload` is the one piece of logic genuinely
        // shared between stream and fallback paths (divergence is a
        // property of the download, not the transport). The *publish*
        // step differs between paths: stream skips when a throttled
        // tick already landed the final value; fallback always
        // publishes because no throttled ticks fire. Extracting the
        // publish into a helper would need a skip-flag that hurts
        // readability; keeping the 3-line publish inline at each
        // site is clearer.
        const warnOnOverDownload = (actual: number) => {
          if (normalizedTotal != null && actual > normalizedTotal) {
            console.warn(
              '[watch] shared capsule exceeded metadata sizeBytes',
              { code, loadedBytes: actual, totalBytes: normalizedTotal },
            );
          }
        };
        commitOpenProgress({
          kind: 'share', code, stage: 'download',
          loadedBytes: 0, totalBytes: normalizedTotal,
        });

        const reader = blobRes.body?.getReader();
        let blob: Blob;
        if (reader) {
          // Stream path — chunk-by-chunk progress, throttled to ~3 fps.
          const chunks: Uint8Array[] = [];
          let loadedBytes = 0;
          // Track the last-published byte count so the completion
          // force-publish below fires only when the final value
          // actually differs (avoids a spurious publish when the last
          // chunk happened to land exactly on a throttle interval).
          let lastPublishedLoadedBytes = 0;
          let lastPublish = (typeof performance !== 'undefined' ? performance.now() : Date.now());
          const PROGRESS_PUBLISH_INTERVAL_MS = 333;
          while (true) {
            const { done, value } = await reader.read();
            if (isStale()) {
              // Cancel the reader so the underlying resource is
              // released and we don't leak a pending read.
              try { await reader.cancel(); } catch { /* ignore */ }
              return;
            }
            if (done) break;
            chunks.push(value);
            loadedBytes += value.byteLength;
            const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
            if (now - lastPublish >= PROGRESS_PUBLISH_INTERVAL_MS) {
              lastPublish = now;
              lastPublishedLoadedBytes = loadedBytes;
              // Clamp via the shared helper so the snapshot invariant
              // `loadedBytes <= totalBytes` holds on every download
              // publish — not just the completion path. Without this,
              // a throttled tick that lands after metadata/content
              // divergence would commit a snapshot where
              // loadedBytes > totalBytes, which any future consumer
              // assuming the determinate invariant would render
              // inconsistently.
              commitOpenProgress({
                kind: 'share', code, stage: 'download',
                loadedBytes: clampLoadedBytes(loadedBytes, normalizedTotal),
                totalBytes: normalizedTotal,
              });
            }
          }
          // Diagnostic always fires on divergence; the publish is
          // skipped if a throttled tick already captured the final
          // value to avoid redundant subscriber notifications.
          warnOnOverDownload(loadedBytes);
          if (loadedBytes !== lastPublishedLoadedBytes) {
            commitOpenProgress({
              kind: 'share', code, stage: 'download',
              loadedBytes: clampLoadedBytes(loadedBytes, normalizedTotal),
              totalBytes: normalizedTotal,
            });
          }
          // `Uint8Array` satisfies BlobPart at runtime; TS lib shape
          // varies by target and can reject it.
          blob = new Blob(chunks as unknown as BlobPart[], { type: contentType });
        } else {
          // Fallback path — environments without readable streaming
          // (stale Safari, service-worker injection). `normalizedTotal`
          // stays identical so the user's progress model does not
          // regress when the stream API is missing. Diagnostics
          // mirror the stream path: if the blob ends up larger than
          // metadata claimed, warn (D1/R2 divergence is a property of
          // the download, not the transport implementation). Then
          // publish one final clamped download tick so the UI shows
          // the real final byte count before the `prepare` transition
          // — without it, fallback users would see 0% → Preparing…
          // with no glimpse of completion.
          blob = await blobRes.blob();
          if (isStale()) return;
          warnOnOverDownload(blob.size);
          commitOpenProgress({
            kind: 'share', code, stage: 'download',
            loadedBytes: clampLoadedBytes(blob.size, normalizedTotal),
            totalBytes: normalizedTotal,
          });
        }

        const file = new File([blob], `atomdojo-capsule-${code}.atomdojo`, { type: contentType });

        // Stage 3 — prepare. Share keeps progress ownership so the
        // share-code context survives through the prepare pipeline;
        // `openPreparedFile` ('caller' mode) does NOT touch
        // openProgress during prepare.
        commitOpenProgress({ kind: 'share', code, stage: 'prepare' });

        // Pass the staleness guard into the helper so a second open
        // that races the prepare pipeline aborts BEFORE destructive
        // commits (documentService.commit / playback.load / renderer
        // init). Without this, an older share could overwrite a
        // newer share's loaded state.
        await openPreparedFile(file, {
          progressOwnership: 'caller',
          shouldContinue: () => !isStale(),
        });
        if (isStale()) return;

        // Stage 4 — success: `openPreparedFile` already flipped
        // `snapshot.loaded` AND cleared `openProgress` in one
        // combined publish (plan §4 step 4). Failure paths inside
        // the helper surface through the existing
        // `setErrorKeepingCurrentState` (which also resets
        // openProgress atomically via commitSnapshotMutation). No
        // second publish is needed here.
      } catch (err) {
        // If a newer share open has already bumped the generation,
        // this rejected fetch/read belongs to a stale request and
        // must NOT clear the newer request's loading state or
        // overwrite its error field. Silently drop the stale
        // failure; the newer request owns the terminal state.
        if (isStale()) return;
        setErrorKeepingCurrentState(
          `Network error loading shared capsule: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },

    togglePlay() {
      if (!playback.isLoaded()) return;
      if (playback.isPlaying()) {
        playback.pausePlayback();
      } else {
        playback.startPlayback();
        _lastTimestamp = 0;
        if (!_rafId) startRAF();
      }
      updateAnalysis();
      publishSnapshot();
    },

    scrub(timePs) {
      if (!playback.isLoaded()) return;
      playback.seekTo(timePs);
      renderAtCurrentTime();
      publishSnapshot();
    },

    // ── Round 2: interaction commands ──

    hoverGroup(id) {
      if (!playback.isLoaded()) return;
      bondedGroups.setHoveredGroupId(id);
      applyHighlight();
      publishSnapshot();
    },

    centerOnGroup(id) {
      if (!playback.isLoaded() || !renderer) return;
      // Explicit user choice — cinematic must pause for the full
      // cooldown so it doesn't immediately override the user's center.
      cinematicCamera.markUserCameraInteraction();
      viewService.centerOnGroup(id, renderer, bondedGroups);
      publishSnapshot();
    },

    followGroup(id) {
      if (!playback.isLoaded() || !renderer) return;
      // Lab parity: follow is a global toggle. If active, any follow click turns it off.
      if (viewService.isFollowing()) {
        viewService.unfollowGroup();
      } else {
        viewService.followGroup(id, renderer, bondedGroups);
      }
      applyHighlight();
      publishSnapshot();
    },

    unfollowGroup() {
      viewService.unfollowGroup();
      applyHighlight();
      publishSnapshot();
    },

    // ── Round 4: color commands ──

    applyGroupColor(groupId, colorHex) {
      if (!playback.isLoaded()) return;
      appearance.applyGroupColor(groupId, colorHex);
      publishSnapshot();
    },

    clearGroupColor(groupId) {
      if (!playback.isLoaded()) return;
      appearance.clearGroupColor(groupId);
      publishSnapshot();
    },

    getGroupColorState(groupId) {
      return appearance.getGroupColorState(groupId);
    },

    // ── Round 5: transport + settings commands ──

    setSpeed(speed) {
      playback.setSpeed(speed);
      publishSnapshot();
    },

    toggleRepeat() {
      playback.setRepeat(!playback.getRepeat());
      publishSnapshot();
    },

    stepForward() {
      if (!playback.isLoaded()) return;
      playback.stepForward();
      renderAtCurrentTime();
      publishSnapshot();
    },

    stepBackward() {
      if (!playback.isLoaded()) return;
      playback.stepBackward();
      renderAtCurrentTime();
      publishSnapshot();
    },

    startDirectionalPlayback(direction: 1 | -1) {
      if (!playback.isLoaded()) return;
      playback.startDirectionalPlayback(direction);
      _lastTimestamp = 0;
      if (!_rafId) startRAF();
      publishSnapshot();
    },

    stopDirectionalPlayback() {
      playback.stopDirectionalPlayback();
      publishSnapshot();
    },

    setTheme(theme) {
      settings.setTheme(theme);
      if (renderer) renderer.applyTheme(theme);
      publishSnapshot();
    },

    setTextSize(size) {
      settings.setTextSize(size);
      publishSnapshot();
    },

    // ── Round 6: smooth playback commands ──

    setSmoothPlayback(enabled) {
      settings.setSmoothPlayback(enabled);
      // Re-render current frame so the mode change is immediately visible
      // (especially when paused or scrubbing).
      if (playback.isLoaded() && renderer) {
        renderAtCurrentTime();
      }
      publishSnapshot();
    },

    setInterpolationMode(mode) {
      settings.setInterpolationMode(mode);
      if (playback.isLoaded() && renderer) {
        renderAtCurrentTime();
      }
      publishSnapshot();
    },

    /** Stable immutable array of registered method metadata. The reference
     *  only changes when the registry is mutated (register/unregister) or
     *  when a new file is loaded (runtime recreation). Safe to call during
     *  React render — will not cause rerender churn on its own because the
     *  identity is stable between mutations. Returns a frozen empty array
     *  when no file is loaded. */
    getRegisteredInterpolationMethods() {
      return interpolation
        ? interpolation.getRegisteredMethods()
        : EMPTY_METHODS;
    },

    setCinematicCameraEnabled(enabled) {
      cinematicCamera.setEnabled(enabled);
      publishSnapshot();
    },

    getPlaybackModel: () => playback,
    getBondedGroups: () => bondedGroups,
    getInterpolationRuntime: () => interpolation,

    createRenderer(container) {
      // Guard: tear down any prior renderer subsystems to prevent listener/RAF leaks
      detachRenderer();
      renderer = createWatchRenderer(container);
      // Sync current theme into the new renderer (CSS tokens already set by settings)
      renderer.applyTheme(settings.getTheme());
      cameraInput = createWatchCameraInput(renderer, {
        onUserCameraInteraction: (phase) => cinematicCamera.markUserCameraInteraction(phase),
      });
      overlayLayout = createWatchOverlayLayout(renderer);
      cinematicCamera.attachRenderer(renderer);
      if (playback.isLoaded()) {
        const meta = documentService.getMetadata();
        if (meta.maxAtomCount > 0) renderer.initForPlayback(meta.maxAtomCount);
        // Route through the unified render pipeline so the newly attached
        // renderer gets current geometry, interpolation, colors, analysis,
        // and highlight state in one pass. Without this, a reattach while
        // paused would leave the renderer blank until the next RAF tick.
        if (interpolation) {
          applyReviewFrameAtTime(playback.getCurrentTimePs(), { render: true });
        } else {
          appearance.projectAndSync(playback.getCurrentTimePs());
        }
      }
      return renderer;
    },

    getRenderer: () => renderer,
    detachRenderer,

    dispose() {
      stopRAF();
      playback.unload();
      bondedGroups.reset();
      viewService.reset();
      cinematicCamera.dispose();
      appearance.reset();
      documentService.clear();
      teardownInterpolationRuntime();
      detachRenderer();
    },
  };
}
