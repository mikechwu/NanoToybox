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
import { createWatchOverlayLayout, type WatchOverlayLayout } from './watch-overlay-layout';
import { createWatchBondedGroupAppearance, type WatchBondedGroupAppearance } from './watch-bonded-group-appearance';
import { createWatchSettings, type WatchSettings, type WatchInterpolationMode } from './watch-settings';
import {
  createWatchTrajectoryInterpolation,
  createWatchTrajectoryInterpolationForReduced,
  type WatchTrajectoryInterpolation,
  type FallbackReason,
  type InterpolationMethodMetadata,
  type InterpolationMethodId,
} from './watch-trajectory-interpolation';
import type { LoadedFullHistory, ImportDiagnostic } from './full-history-import';
import type { LoadedWatchHistory } from './watch-playback-model';
import { VIEWER_DEFAULTS } from '../../src/config/viewer-defaults';
import type { BondedGroupSummary } from './watch-bonded-groups';

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
}

export interface WatchController {
  getSnapshot(): WatchControllerSnapshot;
  subscribe(callback: () => void): () => void;
  openFile(file: File): Promise<void>;
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

const EMPTY_SNAPSHOT: WatchControllerSnapshot = {
  loaded: false, playing: false, currentTimePs: 0, startTimePs: 0, endTimePs: 0,
  groups: [], atomCount: 0, frameCount: 0, maxAtomCount: 0,
  fileKind: null, fileName: null, error: null,
  hoveredGroupId: null, following: false, followedGroupId: null,
  speed: 1, repeat: false, playDirection: 0, theme: VIEWER_DEFAULTS.defaultTheme, textSize: 'normal',
  smoothPlayback: true, interpolationMode: 'linear',
  activeInterpolationMethod: 'linear', lastFallbackReason: 'none',
  importDiagnostics: EMPTY_DIAGNOSTICS,
};

export function createWatchController(): WatchController {
  const documentService = createWatchDocumentService();
  const playback = createWatchPlaybackModel();
  const bondedGroups = createWatchBondedGroups();
  const viewService = createWatchViewService();
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
   *  reflect toggle changes on the landing page. */
  function baseEmptySnapshot(): WatchControllerSnapshot {
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
    };
  }

  function buildSnapshot(): WatchControllerSnapshot {
    if (!playback.isLoaded()) return baseEmptySnapshot();
    const meta = documentService.getMetadata();
    if (!meta.fileName) return baseEmptySnapshot();

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
      || a.importDiagnostics !== b.importDiagnostics;
  }

  function setErrorKeepingCurrentState(error: string) {
    _snapshot = { ..._snapshot, error };
    notify();
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
      interpolation = createWatchTrajectoryInterpolationForReduced(history);
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

    try {
      if (renderer && viewService.isFollowing()) {
        viewService.updateFollow(dtMs, renderer);
      }
      if (renderer) renderer.render();
      publishSnapshot();
    } catch (e) {
      console.error('[watch] snapshot error:', e);
    }
  }

  function startRAF() {
    _lastTimestamp = 0;
    if (_rafId) cancelAnimationFrame(_rafId);
    _rafId = requestAnimationFrame(tick);
  }

  function stopRAF() {
    if (_rafId) { cancelAnimationFrame(_rafId); _rafId = 0; }
  }

  function detachRenderer() {
    if (overlayLayout) { overlayLayout.destroy(); overlayLayout = null; }
    if (cameraInput) { cameraInput.destroy(); cameraInput = null; }
    if (renderer) { renderer.destroy(); renderer = null; }
  }

  // ── Public facade ──

  return {
    getSnapshot: () => _snapshot,

    subscribe(callback) {
      _listeners.add(callback);
      return () => { _listeners.delete(callback); };
    },

    async openFile(file) {
      const result = await documentService.prepare(file);
      if (result.status === 'error') {
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
        stopRAF();
        documentService.commit(history, fileName);
        playback.load(history);
        // Appearance reset before first render — prevents stale color flash from prior file.
        // bondedGroups/viewService reset AFTER render — they don't affect visual state,
        // and deferring them preserves rollback safety (if renderer init fails, follow/hover
        // state is never cleared, so rollback doesn't need to restore them).
        appearance.reset();
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
        updateAnalysis();
        _snapshot = { ..._snapshot, error: null };
        publishSnapshot();
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

    getPlaybackModel: () => playback,
    getBondedGroups: () => bondedGroups,
    getInterpolationRuntime: () => interpolation,

    createRenderer(container) {
      // Guard: tear down any prior renderer subsystems to prevent listener/RAF leaks
      detachRenderer();
      renderer = createWatchRenderer(container);
      // Sync current theme into the new renderer (CSS tokens already set by settings)
      renderer.applyTheme(settings.getTheme());
      cameraInput = createWatchCameraInput(renderer);
      overlayLayout = createWatchOverlayLayout(renderer);
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
      appearance.reset();
      documentService.clear();
      teardownInterpolationRuntime();
      detachRenderer();
    },
  };
}
