/**
 * WatchInfoPanel — top panel that names the current source and exposes
 * Open Link / Open File. Replaces the previous full-width `.review-topbar`
 * that consumed its own grid row. Surface tokens are documented at
 * `.watch-info-panel` in watch.css.
 */

import React, { useState, useCallback, useRef } from 'react';

interface WatchTopBarProps {
  fileKind: string | null;
  fileName: string | null;
  /** Non-null while a share open is in flight. Drives disabled states
   *  + the "Loading…" submit label, and gates the post-submit form
   *  dismissal (we only clear the input + close the form on success). */
  loadingShareCode: string | null;
  onOpenFile: () => void;
  /** Resolves `true` when the open succeeded (no `snapshot.error` set),
   *  `false` on any failure path. WatchApp's adapter wires this to
   *  `controller.openSharedCapsule` + `getSnapshot().error`. */
  onOpenShareCode: (input: string) => Promise<boolean>;
}

/** Map raw file-kind identifiers to user-facing words. Unknown values
 *  pass through — the loader already rejects unsupported kinds
 *  ('replay' etc.) before they reach here, so `string | null` in
 *  practice is one of 'full' / 'capsule' / 'reduced'. */
const KIND_LABELS: Record<string, string> = {
  full: 'history',
  reduced: 'preview',
};
function formatKind(kind: string): string {
  return KIND_LABELS[kind] ?? kind;
}

export function WatchTopBar({
  fileKind, fileName, loadingShareCode, onOpenFile, onOpenShareCode,
}: WatchTopBarProps) {
  const [shareInput, setShareInput] = useState('');
  const [showShareInput, setShowShareInput] = useState(false);

  const isLoading = loadingShareCode !== null;

  // Ref-level re-entry guard — closes the microtask gap between the
  // first submit firing `onOpenShareCode` (which updates the store
  // synchronously) and React re-rendering with `disabled={true}`. A
  // rapid second click before the re-render would otherwise slip past
  // the `isLoading` closure value and fire a parallel fetch.
  const submittingRef = useRef(false);

  const handleSubmit = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = shareInput.trim();
    if (!trimmed || isLoading || submittingRef.current) return;
    submittingRef.current = true;
    try {
      const success = await onOpenShareCode(trimmed);
      // Only dismiss on success. On failure the error banner surfaces
      // the reason and the form stays mounted with the input intact
      // so the user can edit + retry without re-pasting.
      if (success) {
        setShareInput('');
        setShowShareInput(false);
      }
    } finally {
      submittingRef.current = false;
    }
  }, [shareInput, isLoading, onOpenShareCode]);

  return (
    <div className="watch-info-panel" role="region" aria-label="Currently watching">
      <div className="watch-info-panel__identity">
        {fileKind && <span className="watch-info-panel__kind">{formatKind(fileKind)}</span>}
        {fileName && (
          <span
            className="watch-info-panel__filename"
            title={fileName}
            aria-label={fileName}
          >
            {fileName}
          </span>
        )}
      </div>
      {showShareInput ? (
        <form className="watch-info-panel__form" onSubmit={handleSubmit}>
          <input
            className="watch-info-panel__input"
            type="text"
            placeholder="Paste share link or code"
            value={shareInput}
            onChange={(e) => setShareInput(e.target.value)}
            autoFocus
            aria-label="Share link or code"
            disabled={isLoading}
          />
          <div className="watch-info-panel__actions">
            <button
              className="watch-info-panel__action"
              type="submit"
              disabled={!shareInput.trim() || isLoading}
            >
              {isLoading ? 'Loading…' : 'Open'}
            </button>
            <button
              className="watch-info-panel__action"
              type="button"
              onClick={() => setShowShareInput(false)}
              disabled={isLoading}
            >
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <div className="watch-info-panel__actions">
          <button
            className="watch-info-panel__action"
            type="button"
            onClick={() => setShowShareInput(true)}
            disabled={isLoading}
          >
            Open Link
          </button>
          <button
            className="watch-info-panel__action"
            type="button"
            onClick={onOpenFile}
            disabled={isLoading}
          >
            Open File
          </button>
        </div>
      )}
    </div>
  );
}
