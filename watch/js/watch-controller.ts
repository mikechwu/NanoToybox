/**
 * Watch controller facade — orchestration layer over domain services.
 *
 * Round 1 decomposition status:
 *   - Document preparation + metadata: watch-document-service.ts
 *   - Playback policy: watch-playback-model.ts (advance, start, pause, seek)
 *   - Analysis: watch-bonded-groups.ts (dedicated runtime boundary)
 *   - Shared config: src/config/viewer-defaults.ts
 *
 * This facade owns:
 *   - RAF loop + renderer frame application (D58)
 *   - Document commit/rollback transaction coordination
 *   - Explicit analysis update at orchestration points (not inside snapshot)
 *   - Snapshot composition (pure read) / diffing / publication
 *   - Error state lifecycle
 *
 * Future domain seams (documented, not yet implemented):
 * - View domain: camera/view state, center/follow targets, camera presets
 * - Settings domain: theme/text-size/device preferences
 */

import { createWatchDocumentService, type DocumentMetadata } from './watch-document-service';
import { createWatchPlaybackModel, type WatchPlaybackModel } from './watch-playback-model';
import { createWatchBondedGroups, type WatchBondedGroups } from './watch-bonded-groups';
import { createWatchRenderer, type WatchRenderer } from './watch-renderer';
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
}

export interface WatchController {
  getSnapshot(): WatchControllerSnapshot;
  subscribe(callback: () => void): () => void;
  openFile(file: File): Promise<void>;
  togglePlay(): void;
  scrub(timePs: number): void;
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
};

export function createWatchController(): WatchController {
  // ── Domain services ──
  const documentService = createWatchDocumentService();
  const playback = createWatchPlaybackModel();
  const bondedGroups = createWatchBondedGroups();
  let renderer: WatchRenderer | null = null;

  // ── Snapshot state ──
  let _snapshot: WatchControllerSnapshot = { ...EMPTY_SNAPSHOT };
  const _listeners = new Set<() => void>();
  let _rafId = 0;
  let _lastTimestamp = 0;

  function notify() {
    for (const cb of _listeners) {
      try { cb(); } catch (e) { console.error('[watch] listener error:', e); }
    }
  }

  /** Update analysis state explicitly. Called at orchestration points, NOT inside buildSnapshot. */
  function updateAnalysis() {
    if (!playback.isLoaded()) return;
    const timePs = playback.getCurrentTimePs();
    const topology = playback.getTopologyAtTime(timePs);
    bondedGroups.updateForTime(timePs, topology);
  }

  /** Build snapshot as a PURE READ — no side effects, no analysis mutation. */
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
    };
  }

  function snapshotChanged(a: WatchControllerSnapshot, b: WatchControllerSnapshot): boolean {
    return a.loaded !== b.loaded || a.playing !== b.playing
      || a.currentTimePs !== b.currentTimePs || a.startTimePs !== b.startTimePs
      || a.endTimePs !== b.endTimePs || a.frameCount !== b.frameCount
      || a.maxAtomCount !== b.maxAtomCount || a.fileKind !== b.fileKind
      || a.fileName !== b.fileName
      || a.error !== b.error || a.groups !== b.groups || a.atomCount !== b.atomCount;
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

  // ── RAF loop (facade-owned per D58) ──

  function tick(timestamp: number) {
    _rafId = requestAnimationFrame(tick);

    // Playback time advancement
    try {
      if (_lastTimestamp > 0) {
        playback.advance(timestamp - _lastTimestamp);
      }
      _lastTimestamp = timestamp;
    } catch (e) {
      stopRAF();
      console.error('[watch] playback tick error:', e);
      _snapshot = { ...EMPTY_SNAPSHOT, error: `Playback error: ${e instanceof Error ? e.message : String(e)}` };
      notify();
      return;
    }

    // Renderer frame application (isolated — non-fatal)
    if (renderer && playback.isLoaded()) {
      try {
        const timePs = playback.getCurrentTimePs();
        const posData = playback.getDisplayPositionsAtTime(timePs);
        const topology = playback.getTopologyAtTime(timePs);
        if (posData) {
          renderer.updateReviewFrame(posData.positions, posData.n, topology?.bonds ?? []);
          renderer.render();
        }
      } catch (e) {
        console.error('[watch] render error (non-fatal):', e);
      }
    }

    // Analysis update + snapshot publication (explicit, not inside buildSnapshot)
    try {
      updateAnalysis();
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

  /** Single destruction path for the renderer. */
  function detachRenderer() {
    if (renderer) { renderer.destroy(); renderer = null; }
  }

  // ── Public facade ──

  return {
    getSnapshot: () => _snapshot,

    subscribe(callback) {
      _listeners.add(callback);
      return () => { _listeners.delete(callback); };
    },

    async openFile(file: File) {
      // Phase 1: Prepare via document service (non-destructive)
      const result = await documentService.prepare(file);
      if (result.status === 'error') {
        setErrorKeepingCurrentState(result.message);
        return;
      }

      // Phase 2: Commit (swap to new document, rollback on failure)
      const { history, fileName } = result;
      const prevDocMeta = documentService.saveForRollback();
      const prevHistory = playback.getLoadedHistory();
      const prevTimePs = playback.getCurrentTimePs();
      const prevPlaying = playback.isPlaying();
      const wasRunning = _rafId !== 0;

      try {
        stopRAF();
        documentService.commit(history, fileName);
        playback.load(history);
        bondedGroups.reset();
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
        // Explicit analysis update after commit
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
            // Explicit analysis recomputation after rollback
            bondedGroups.reset();
            updateAnalysis();
            if (renderer) renderer.initForPlayback(prevHistory.simulation.maxAtomCount);
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

    scrub(timePs: number) {
      if (!playback.isLoaded()) return;
      playback.seekTo(timePs);
      updateAnalysis();
      publishSnapshot();
    },

    getPlaybackModel: () => playback,
    getBondedGroups: () => bondedGroups,

    createRenderer(container: HTMLElement) {
      renderer = createWatchRenderer(container);
      if (playback.isLoaded()) {
        const meta = documentService.getMetadata();
        if (meta.maxAtomCount > 0) renderer.initForPlayback(meta.maxAtomCount);
      }
      return renderer;
    },

    getRenderer: () => renderer,
    detachRenderer,

    dispose() {
      stopRAF();
      playback.unload();
      bondedGroups.reset();
      documentService.clear();
      detachRenderer();
    },
  };
}
