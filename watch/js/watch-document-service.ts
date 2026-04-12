/**
 * Watch document service — file lifecycle, document identity, and transactional prepare/commit.
 *
 * Owns:        file reading, detection, validation, import, current document metadata.
 * Does NOT own: playback state, renderer, analysis, RAF.
 * Called by:    watch-controller.ts (facade coordinates commit/rollback).
 *
 * Supports both full-history and reduced-history files. Dispatches to the
 * appropriate importer based on detected file kind.
 */

import { loadHistoryFile, type LoadDecision } from './history-file-loader';
import { importFullHistory, type LoadedFullHistory } from './full-history-import';
import { importReducedHistory, type LoadedReducedHistory } from './reduced-history-import';
import type { LoadedWatchHistory } from './watch-playback-model';

export type DocumentPrepareResult =
  | { status: 'ready'; history: LoadedWatchHistory; fileName: string }
  | { status: 'error'; message: string };

export interface DocumentMetadata {
  fileName: string | null;
  fileKind: string | null;
  atomCount: number;
  frameCount: number;
  maxAtomCount: number;
}

const EMPTY_METADATA: DocumentMetadata = {
  fileName: null, fileKind: null, atomCount: 0, frameCount: 0, maxAtomCount: 0,
};

export interface WatchDocumentService {
  /** Non-destructive prepare: reads, parses, validates, imports. No side effects. */
  prepare(file: File): Promise<DocumentPrepareResult>;
  /** Commit a prepared document — stores metadata. Called by facade on successful load. */
  commit(history: LoadedWatchHistory, fileName: string): void;
  /** Get current document metadata. */
  getMetadata(): DocumentMetadata;
  /** Save metadata for rollback. */
  saveForRollback(): DocumentMetadata;
  /** Restore metadata from a prior save. */
  restoreFromRollback(saved: DocumentMetadata): void;
  /** Clear document state. */
  clear(): void;
}

export function createWatchDocumentService(): WatchDocumentService {
  let _metadata: DocumentMetadata = { ...EMPTY_METADATA };

  return {
    async prepare(file: File): Promise<DocumentPrepareResult> {
      let text: string;
      try {
        text = await file.text();
      } catch (e) {
        return { status: 'error', message: `Could not read file: ${e instanceof Error ? e.message : String(e)}` };
      }

      let decision: LoadDecision;
      try {
        decision = loadHistoryFile(text);
      } catch (e) {
        return { status: 'error', message: `Could not open file: ${e instanceof Error ? e.message : String(e)}` };
      }

      if (decision.status === 'invalid') {
        return { status: 'error', message: `Invalid file: ${decision.errors[0]}` };
      }
      if (decision.status === 'unsupported') {
        return { status: 'error', message: `${decision.reason} (detected kind: ${decision.kind})` };
      }

      // Dispatch to the appropriate importer based on file kind
      let history: LoadedWatchHistory;
      try {
        if (decision.kind === 'full') {
          history = importFullHistory(decision.file);
        } else {
          history = importReducedHistory(decision.file);
        }
      } catch (e) {
        return { status: 'error', message: `Import failed: ${e instanceof Error ? e.message : String(e)}` };
      }

      if (history.denseFrames.length === 0) {
        return { status: 'error', message: 'This file has no recorded frames to play back.' };
      }

      return { status: 'ready', history, fileName: file.name };
    },

    commit(history: LoadedWatchHistory, fileName: string) {
      _metadata = {
        fileName,
        fileKind: history.kind,
        atomCount: history.atoms.length,
        frameCount: history.simulation.frameCount,
        maxAtomCount: history.simulation.maxAtomCount,
      };
    },

    getMetadata: () => _metadata,
    saveForRollback: () => ({ ..._metadata }),
    restoreFromRollback(saved: DocumentMetadata) { _metadata = { ...saved }; },
    clear() { _metadata = { ...EMPTY_METADATA }; },
  };
}
