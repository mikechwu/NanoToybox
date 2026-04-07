/**
 * Watch controller — non-React bridge between runtime modules and React UI.
 *
 * Owns:        playback clock (RAF), loaded file state, snapshot publication.
 * Does NOT own: renderer lifecycle (that's WatchCanvas), DOM (that's React).
 * Called by:    main.ts (create), React components (subscribe via useSyncExternalStore).
 */

import { loadHistoryFile, type LoadDecision } from './history-file-loader';
import { importFullHistory, type LoadedFullHistory } from './full-history-import';
import { createWatchPlaybackModel, type WatchPlaybackModel } from './watch-playback-model';
import { createWatchBondedGroups, type WatchBondedGroups } from './watch-bonded-groups';
import { createWatchRenderer, type WatchRenderer } from './watch-renderer';
import { CONFIG } from '../../lab/js/config';
import type { BondedGroupSummary } from '../../src/history/bonded-group-projection';

/** Canonical x1 playback rate: ps advanced per real ms. Derived from shared lab config. */
const PS_PER_MS_AT_1X = CONFIG.playback.baseSimRatePsPerSecond / 1000;

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
  /** Get runtime modules for WatchCanvas renderer lifecycle. */
  getPlaybackModel(): WatchPlaybackModel;
  getBondedGroups(): WatchBondedGroups;
  /** Create or get renderer adapter (canvas owns lifecycle, controller provides the factory). */
  createRenderer(container: HTMLElement): WatchRenderer;
  getRenderer(): WatchRenderer | null;
  /** Called by WatchCanvas on unmount to prevent RAF from calling destroyed renderer. */
  detachRenderer(): void;
  dispose(): void;
}

const EMPTY_SNAPSHOT: WatchControllerSnapshot = {
  loaded: false,
  playing: false,
  currentTimePs: 0,
  startTimePs: 0,
  endTimePs: 0,
  groups: [],
  atomCount: 0,
  frameCount: 0,
  maxAtomCount: 0,
  fileKind: null,
  fileName: null,
  error: null,
};

export function createWatchController(): WatchController {
  const playback = createWatchPlaybackModel();
  const bondedGroups = createWatchBondedGroups();
  let renderer: WatchRenderer | null = null;

  let _snapshot: WatchControllerSnapshot = { ...EMPTY_SNAPSHOT };
  let _fileName: string | null = null;
  const _listeners = new Set<() => void>();
  let _rafId = 0;
  let _lastTimestamp = 0;

  function notify() {
    for (const cb of _listeners) {
      try { cb(); } catch (e) { console.error('[watch] listener error:', e); }
    }
  }

  function buildSnapshot(): WatchControllerSnapshot {
    if (!playback.isLoaded()) return { ...EMPTY_SNAPSHOT, error: _snapshot.error };
    const history = playback.getLoadedHistory();
    if (!history) return { ...EMPTY_SNAPSHOT, error: _snapshot.error };
    const timePs = playback.getCurrentTimePs();
    const topology = playback.getTopologyAtTime(timePs);
    const groups = bondedGroups.updateForTime(timePs, topology);

    return {
      loaded: true,
      playing: playback.isPlaying(),
      currentTimePs: timePs,
      startTimePs: playback.getStartTimePs(),
      endTimePs: playback.getEndTimePs(),
      groups,
      atomCount: history.atoms.length,
      frameCount: history.simulation.frameCount,
      maxAtomCount: history.simulation.maxAtomCount,
      fileKind: 'full',
      fileName: _fileName,
      error: _snapshot.error,  // preserve until explicitly cleared by successful commit
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

  /** Show an error while keeping the current document loaded (transactional failure). */
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

  // ── RAF playback clock (controller-owned) ──
  function tick(timestamp: number) {
    _rafId = requestAnimationFrame(tick);
    try {
      if (playback.isPlaying() && _lastTimestamp > 0) {
        const dtMs = timestamp - _lastTimestamp;
        // Canonical x1 playback rate from shared lab config (0.12 ps/s at 1x).
        // This matches the same simulation timing model used by lab review mode.
        const dtPs = dtMs * PS_PER_MS_AT_1X;
        let newTime = playback.getCurrentTimePs() + dtPs;
        const endTime = playback.getEndTimePs();
        if (newTime >= endTime) {
          newTime = endTime;
          playback.setPlaying(false);
        }
        playback.setCurrentTimePs(newTime);
      }
      _lastTimestamp = timestamp;

      // Update renderer with current frame
      if (renderer && playback.isLoaded()) {
        const timePs = playback.getCurrentTimePs();
        const posData = playback.getDisplayPositionsAtTime(timePs);
        const topology = playback.getTopologyAtTime(timePs);
        if (posData) {
          renderer.updateReviewFrame(posData.positions, posData.n, topology?.bonds ?? []);
          renderer.render();
        }
      }

      publishSnapshot();
    } catch (e) {
      stopRAF();
      console.error('[watch] tick error:', e);
      _snapshot = { ...EMPTY_SNAPSHOT, error: `Playback error: ${e instanceof Error ? e.message : String(e)}` };
      notify();
    }
  }

  function startRAF() {
    _lastTimestamp = 0;
    if (_rafId) cancelAnimationFrame(_rafId);
    _rafId = requestAnimationFrame(tick);
  }

  function stopRAF() {
    if (_rafId) {
      cancelAnimationFrame(_rafId);
      _rafId = 0;
    }
  }

  return {
    getSnapshot: () => _snapshot,

    subscribe(callback) {
      _listeners.add(callback);
      return () => { _listeners.delete(callback); };
    },

    async openFile(file: File) {
      // ── Phase 1: Prepare (non-destructive — current document stays intact) ──
      let text: string;
      try {
        text = await file.text();
      } catch (e) {
        setErrorKeepingCurrentState(`Could not read file: ${e instanceof Error ? e.message : String(e)}`);
        return;
      }

      let decision: LoadDecision;
      try {
        decision = loadHistoryFile(text);
      } catch (e) {
        setErrorKeepingCurrentState(`Could not open file: ${e instanceof Error ? e.message : String(e)}`);
        return;
      }

      if (decision.status === 'invalid') {
        setErrorKeepingCurrentState(`Invalid file: ${decision.errors[0]}`);
        return;
      }
      if (decision.status === 'unsupported') {
        setErrorKeepingCurrentState(`${decision.reason} (detected kind: ${decision.kind})`);
        return;
      }

      let history: LoadedFullHistory;
      try {
        history = importFullHistory(decision.file);
      } catch (e) {
        setErrorKeepingCurrentState(`Import failed: ${e instanceof Error ? e.message : String(e)}`);
        return;
      }

      if (history.denseFrames.length === 0) {
        setErrorKeepingCurrentState('This file has no recorded frames to play back.');
        return;
      }

      // ── Phase 2: Commit (swap to new document, rollback on failure) ──
      const prevHistory = playback.getLoadedHistory();
      const prevTimePs = playback.getCurrentTimePs();
      const prevPlaying = playback.isPlaying();
      const prevFileName = _fileName;
      const wasRunning = _rafId !== 0;

      try {
        stopRAF();
        _fileName = file.name;
        playback.load(history);
        bondedGroups.reset();
        if (renderer) {
          renderer.initForPlayback(history.simulation.maxAtomCount);
          // Force immediate render of the new file's first frame
          const timePs = playback.getCurrentTimePs();
          const posData = playback.getDisplayPositionsAtTime(timePs);
          const topology = playback.getTopologyAtTime(timePs);
          if (posData) {
            renderer.updateReviewFrame(posData.positions, posData.n, topology?.bonds ?? []);
          }
          renderer.render();
        }
        _snapshot = { ..._snapshot, error: null }; // clear any prior error on successful commit
        publishSnapshot();
        startRAF();
      } catch (e) {
        console.error('[watch] playback init error:', e);
        _fileName = prevFileName;
        // Rollback: restore previous document if one existed
        if (prevHistory) {
          try {
            playback.load(prevHistory);
            playback.setCurrentTimePs(prevTimePs);
            playback.setPlaying(prevPlaying);
            bondedGroups.reset();
            if (renderer) {
              renderer.initForPlayback(prevHistory.simulation.maxAtomCount);
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
      const wasPlaying = playback.isPlaying();
      if (!wasPlaying && playback.getCurrentTimePs() >= playback.getEndTimePs()) {
        playback.setCurrentTimePs(playback.getStartTimePs());
      }
      playback.setPlaying(!wasPlaying);
      // Reset timestamp so first tick after play doesn't see a huge dt gap
      if (!wasPlaying) _lastTimestamp = 0;
      publishSnapshot();
    },

    scrub(timePs: number) {
      playback.setCurrentTimePs(timePs);
      playback.setPlaying(false);
      publishSnapshot();
    },

    getPlaybackModel: () => playback,
    getBondedGroups: () => bondedGroups,

    createRenderer(container: HTMLElement) {
      renderer = createWatchRenderer(container);
      // If already loaded, init capacity
      if (playback.isLoaded()) {
        const history = playback.getLoadedHistory();
        if (history) renderer.initForPlayback(history.simulation.maxAtomCount);
      }
      return renderer;
    },

    getRenderer: () => renderer,
    /** Called by WatchCanvas on unmount to prevent RAF from calling destroyed renderer. */
    detachRenderer() { renderer = null; },

    dispose() {
      stopRAF();
      playback.unload();
      bondedGroups.reset();
      if (renderer) {
        renderer.destroy();
        renderer = null;
      }
    },
  };
}
