/**
 * Watch document service — file lifecycle, document identity, and transactional prepare/commit.
 *
 * Owns:        file reading, detection, validation, import, current document metadata.
 * Does NOT own: playback state, renderer, analysis, RAF.
 * Called by:    watch-controller.ts (facade coordinates commit/rollback).
 *
 * Supports full, capsule, and legacy reduced files. Dispatches to the
 * appropriate importer based on detected file kind. Both capsule and
 * reduced route to the capsule importer (legacy reduced normalized at import).
 *
 * Rev 6 additions:
 *   - `documentFingerprint` — FNV-1a 32-bit over the first 64 KB of file bytes
 *     (allocates only the slice, not the full buffer).
 *   - `fileByteLength` — raw `file.size`.
 *   - `shareCode` — normalized share code when opened via openSharedCapsule, else null.
 *   - Atomic `commit(history, fileName, extras)` — single write surface.
 */

import { loadHistoryFile, type LoadDecision } from './history-file-loader';
import { importFullHistory } from './full-history-import';
import { importCapsuleHistory, importReducedAsCapsule } from './capsule-history-import';
import type { LoadedWatchHistory } from './watch-playback-model';

export type DocumentPrepareResult =
  | {
      status: 'ready';
      history: LoadedWatchHistory;
      fileName: string;
      /** FNV-1a 32-bit hex (8 chars) over the first 64 KB of the source bytes. */
      fingerprint: string;
      /** Total source byte length (file.size or blob.size). */
      fileByteLength: number;
    }
  | { status: 'error'; message: string };

export interface DocumentMetadata {
  fileName: string | null;
  fileKind: string | null;
  atomCount: number;
  frameCount: number;
  maxAtomCount: number;
  /** Content fingerprint — FNV-1a 32-bit over first 64 KB. Null when unloaded. */
  documentFingerprint: string | null;
  /** Total file byte length at prepare time. Null when unloaded. */
  fileByteLength: number | null;
  /** Normalized share code when opened via openSharedCapsule; null for local files. */
  shareCode: string | null;
}

export interface DocumentCommitExtras {
  fingerprint: string;
  fileByteLength: number;
  /** Provided by the controller only on the openSharedCapsule path. Null for local files. */
  shareCode: string | null;
}

const EMPTY_METADATA: DocumentMetadata = {
  fileName: null,
  fileKind: null,
  atomCount: 0,
  frameCount: 0,
  maxAtomCount: 0,
  documentFingerprint: null,
  fileByteLength: null,
  shareCode: null,
};

export interface WatchDocumentService {
  /** Non-destructive prepare: reads, parses, validates, imports, fingerprints. */
  prepare(file: File | Blob, fileNameOverride?: string): Promise<DocumentPrepareResult>;
  /** Commit a prepared document — stores metadata atomically. */
  commit(history: LoadedWatchHistory, fileName: string, extras: DocumentCommitExtras): void;
  /** Get current document metadata. */
  getMetadata(): DocumentMetadata;
  /** Save metadata for rollback (deep copies all fields). */
  saveForRollback(): DocumentMetadata;
  /** Restore metadata from a prior save (restores all fields atomically). */
  restoreFromRollback(saved: DocumentMetadata): void;
  /** Clear document state — resets every field. */
  clear(): void;
}

/** FNV-1a 32-bit over a byte buffer. Not cryptographic; adequate for
 *  content-identity pacing. Returns an 8-char lowercase hex string. */
export function fnv1a32Hex(bytes: Uint8Array): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    // multiply by FNV prime 0x01000193 using 32-bit math
    h = Math.imul(h, 0x01000193);
  }
  // Normalize to unsigned 32-bit
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** Derive the document key for hint pacing + future handoff identity. */
export function deriveDocumentKey(meta: DocumentMetadata): string | null {
  if (meta.shareCode) return `share:${meta.shareCode}`;
  if (meta.documentFingerprint && meta.fileByteLength != null) {
    return `file:${meta.documentFingerprint}:${meta.fileByteLength}`;
  }
  return null;
}

async function readFingerprintSlice(source: File | Blob): Promise<{ fingerprint: string; byteLength: number }> {
  const byteLength = source.size;
  const slice = source.slice(0, Math.min(65536, byteLength));
  const buffer = await slice.arrayBuffer();
  const fingerprint = fnv1a32Hex(new Uint8Array(buffer));
  return { fingerprint, byteLength };
}

export function createWatchDocumentService(): WatchDocumentService {
  let _metadata: DocumentMetadata = { ...EMPTY_METADATA };

  return {
    async prepare(file: File | Blob, fileNameOverride?: string): Promise<DocumentPrepareResult> {
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

      let history: LoadedWatchHistory;
      try {
        if (decision.kind === 'full') {
          history = importFullHistory(decision.file);
        } else if (decision.kind === 'capsule') {
          history = importCapsuleHistory(decision.file);
        } else {
          history = importReducedAsCapsule(decision.file);
        }
      } catch (e) {
        return { status: 'error', message: `Import failed: ${e instanceof Error ? e.message : String(e)}` };
      }

      if (history.denseFrames.length === 0) {
        return { status: 'error', message: 'This file has no recorded frames to play back.' };
      }

      // Rev 6 — bounded-allocation fingerprint. Reads ONLY the first 64 KB.
      let fingerprint: string;
      let fileByteLength: number;
      try {
        const r = await readFingerprintSlice(file);
        fingerprint = r.fingerprint;
        fileByteLength = r.byteLength;
      } catch {
        // Non-fatal: fall back to a deterministic token so the pacing logic
        // still has SOMETHING stable per session.
        fingerprint = '00000000';
        fileByteLength = (file as File).size ?? 0;
      }

      const fileName = fileNameOverride ?? (file as File).name ?? 'shared-capsule.atomdojo';
      return { status: 'ready', history, fileName, fingerprint, fileByteLength };
    },

    commit(history, fileName, extras) {
      _metadata = {
        fileName,
        fileKind: history.kind,
        atomCount: history.atoms.length,
        frameCount: history.simulation.frameCount,
        maxAtomCount: history.simulation.maxAtomCount,
        documentFingerprint: extras.fingerprint,
        fileByteLength: extras.fileByteLength,
        shareCode: extras.shareCode,
      };
    },

    getMetadata: () => _metadata,
    saveForRollback: () => ({ ..._metadata }),
    restoreFromRollback(saved: DocumentMetadata) { _metadata = { ...saved }; },
    clear() { _metadata = { ...EMPTY_METADATA }; },
  };
}
