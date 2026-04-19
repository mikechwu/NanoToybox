/**
 * History file loader — detection + support decision (two-step).
 *
 * Delegates detection and validation to the shared schema module.
 * Owns only file I/O and the user-facing load flow.
 *
 * Supports kind: 'full', 'capsule', and 'reduced' (legacy alias). Rejects 'replay'.
 */

import {
  detectHistoryFile,
  validateFullHistoryFile,
  validateReducedFile,
  validateCapsuleFile,
  type AtomDojoHistoryFileV1,
  type AtomDojoReducedFileV1,
  type AtomDojoPlaybackCapsuleFileV1,
  type DetectedHistoryFile,
} from '../../../src/history/history-file-v1';

export type { DetectedHistoryFile };

/** Policy decision: can this build of watch/ open the detected file? */
export type LoadDecision =
  | { status: 'supported'; kind: 'full'; file: AtomDojoHistoryFileV1 }
  | { status: 'supported'; kind: 'capsule'; file: AtomDojoPlaybackCapsuleFileV1 }
  | { status: 'supported'; kind: 'reduced'; file: AtomDojoReducedFileV1 }
  | { status: 'unsupported'; kind: string; reason: string }
  | { status: 'invalid'; errors: string[] };

/** Parse file text, detect kind, validate, return load decision. */
export function loadHistoryFile(text: string): LoadDecision {
  // Step 1: Parse JSON
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (e) {
    const detail = e instanceof SyntaxError ? e.message : 'file could not be parsed';
    return { status: 'invalid', errors: [`Invalid JSON: ${detail}`] };
  }

  // Step 2: Detect file kind (delegated to shared module)
  const detected = detectHistoryFile(json);
  if (detected.format === 'unknown') {
    return { status: 'invalid', errors: [detected.reason] };
  }

  // Step 3: Apply support policy
  if (detected.version !== 1) {
    return { status: 'unsupported', kind: detected.kind, reason: `Version ${detected.version} is not supported` };
  }

  if (detected.kind === 'full') {
    let errors: string[];
    try {
      errors = validateFullHistoryFile(detected.file);
    } catch (e) {
      return { status: 'invalid', errors: [`Validation error: ${e instanceof Error ? e.message : String(e)}`] };
    }
    if (errors.length > 0) {
      return { status: 'invalid', errors };
    }
    return { status: 'supported', kind: 'full', file: detected.file as AtomDojoHistoryFileV1 };
  }

  if (detected.kind === 'capsule') {
    let errors: string[];
    try {
      errors = validateCapsuleFile(detected.file);
    } catch (e) {
      return { status: 'invalid', errors: [`Validation error: ${e instanceof Error ? e.message : String(e)}`] };
    }
    if (errors.length > 0) {
      return { status: 'invalid', errors };
    }
    return { status: 'supported', kind: 'capsule', file: detected.file as AtomDojoPlaybackCapsuleFileV1 };
  }

  if (detected.kind === 'reduced') {
    let errors: string[];
    try {
      errors = validateReducedFile(detected.file);
    } catch (e) {
      return { status: 'invalid', errors: [`Validation error: ${e instanceof Error ? e.message : String(e)}`] };
    }
    if (errors.length > 0) {
      return { status: 'invalid', errors };
    }
    return { status: 'supported', kind: 'reduced', file: detected.file as AtomDojoReducedFileV1 };
  }

  if (detected.kind === 'replay') {
    return { status: 'unsupported', kind: 'replay', reason: 'Replay files are not supported in Watch yet' };
  }

  return { status: 'unsupported', kind: detected.kind, reason: `File kind "${detected.kind}" is not supported` };
}
