/**
 * Watch controller facade — orchestration layer over domain services.
 *
 * Round 2 additions:
 *   - View service: camera target, follow state, center/follow commands
 *   - Analysis interaction: hover/select state, highlight resolution
 *   - Per-frame follow update + highlight application in RAF tick
 *   - Interaction commands exposed to UI
 *
 * Domains:
 *   - Document: watch-document-service.ts
 *   - Playback: watch-playback-model.ts
 *   - Analysis: watch-bonded-groups.ts (interaction state + highlight priority)
 *   - View: watch-view-service.ts (camera target, follow)
 *   - Settings: future (documented seam only)
 */

import { createWatchDocumentService, type DocumentMetadata } from './watch-document-service';
import { createWatchPlaybackModel, type WatchPlaybackModel } from './watch-playback-model';
import { createWatchBondedGroups, type WatchBondedGroups } from './watch-bonded-groups';
import { createWatchViewService, type WatchViewService } from './watch-view-service';
import { createWatchRenderer, type WatchRenderer } from './watch-renderer';
import { createWatchCameraInput, type WatchCameraInput } from './watch-camera-input';
import { createWatchOverlayLayout, type WatchOverlayLayout } from './watch-overlay-layout';
import { createWatchBondedGroupAppearance, type WatchBondedGroupAppearance } from './watch-bonded-group-appearance';
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
  // ── Runtime access ──
  getPlaybackModel(): WatchPlaybackModel;
  getBondedGroups(): WatchBondedGroups;
  createRenderer(container: HTMLElement): WatchRenderer;
  getRenderer(): WatchRenderer | null;
  detachRenderer(): void;
  dispose(): void;
}

const EMPTY_SNAPSHOT: WatchControllerSnapshot = {
  loaded: false, playing: false, currentTimePs: 0, startTimePs: 0, endTimePs: 0,
  groups: [], atomCount: 0, frameCount: 0, maxAtomCount: 0,
  fileKind: null, fileName: null, error: null,
  hoveredGroupId: null, following: false, followedGroupId: null,
};

export function createWatchController(): WatchController {
  const documentService = createWatchDocumentService();
  const playback = createWatchPlaybackModel();
  const bondedGroups = createWatchBondedGroups();
  const viewService = createWatchViewService();
  const appearance = createWatchBondedGroupAppearance({
    getBondedGroups: () => bondedGroups,
    getPlaybackModel: () => playback,
    getRenderer: () => renderer,
  });
  let renderer: WatchRenderer | null = null;
  let cameraInput: WatchCameraInput | null = null;
  let overlayLayout: WatchOverlayLayout | null = null;

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

  function buildSnapshot(): WatchControllerSnapshot {
    if (!playback.isLoaded()) return { ...EMPTY_SNAPSHOT, error: _snapshot.error };
    const meta = documentService.getMetadata();
    if (!meta.fileName) return { ...EMPTY_SNAPSHOT, error: _snapshot.error };

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
      || a.following !== b.following || a.followedGroupId !== b.followedGroupId;
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

    // ── Round 4 tick order: colors + follow projected before render ──
    // 1. advance (above) → 2. sample → 3. updateReviewFrame → 4. project colors
    // → 5. setAtomColorOverrides → 6. analysis → 7. follow → 8. highlight → 9. render → 10. snapshot
    if (renderer && playback.isLoaded()) {
      try {
        const timePs = playback.getCurrentTimePs();
        const posData = playback.getDisplayPositionsAtTime(timePs);
        const topology = playback.getTopologyAtTime(timePs);
        if (posData) {
          // 3. Apply frame geometry
          renderer.updateReviewFrame(posData.positions, posData.n, topology?.bonds ?? []);
          // 4-5. Project authored colors for this frame's atomId ordering
          appearance.projectAndSync(timePs);
        }
      } catch (e) {
        console.error('[watch] render error (non-fatal):', e);
      }
    }

    try {
      // 6. Bonded-group topology projection
      updateAnalysis();
      // 7. Camera follow — tracks target before render
      if (renderer && viewService.isFollowing()) {
        viewService.updateFollow(dtMs, renderer);
      }
      // 8. Highlight on top of authored colors
      applyHighlight();
      // 9. Final composited render
      if (renderer) renderer.render();
      // 10. Publish snapshot
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
      const prevPlaying = playback.isPlaying();
      const prevAppearance = [...appearance.getAssignments()];
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
        if (renderer) {
          renderer.initForPlayback(history.simulation.maxAtomCount);
          const timePs = playback.getCurrentTimePs();
          const posData = playback.getDisplayPositionsAtTime(timePs);
          const topology = playback.getTopologyAtTime(timePs);
          if (posData) {
            renderer.updateReviewFrame(posData.positions, posData.n, topology?.bonds ?? []);
          }
          renderer.render();
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
            playback.setCurrentTimePs(prevTimePs);
            playback.setPlaying(prevPlaying);
            // Restore prior authored colors (cleared by appearance.reset() above)
            appearance.restoreAssignments(prevAppearance);
            updateAnalysis();
            // Fully restore the visual scene — mirror success-path rendering
            if (renderer) {
              renderer.initForPlayback(prevHistory.simulation.maxAtomCount);
              const posData = playback.getDisplayPositionsAtTime(prevTimePs);
              const topology = playback.getTopologyAtTime(prevTimePs);
              if (posData) {
                renderer.updateReviewFrame(posData.positions, posData.n, topology?.bonds ?? []);
              }
              appearance.projectAndSync(prevTimePs);
              applyHighlight();
              renderer.render();
            }
            if (wasRunning) startRAF();
          } catch (rollbackErr) {
            console.error('[watch] rollback also failed:', rollbackErr);
          }
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
      appearance.projectAndSync(timePs);
      updateAnalysis();
      applyHighlight();
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

    getPlaybackModel: () => playback,
    getBondedGroups: () => bondedGroups,

    createRenderer(container) {
      // Guard: tear down any prior renderer subsystems to prevent listener/RAF leaks
      detachRenderer();
      renderer = createWatchRenderer(container);
      cameraInput = createWatchCameraInput(renderer);
      overlayLayout = createWatchOverlayLayout(renderer);
      if (playback.isLoaded()) {
        const meta = documentService.getMetadata();
        if (meta.maxAtomCount > 0) renderer.initForPlayback(meta.maxAtomCount);
        // Resync authored colors into the new renderer
        appearance.projectAndSync(playback.getCurrentTimePs());
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
      detachRenderer();
    },
  };
}
