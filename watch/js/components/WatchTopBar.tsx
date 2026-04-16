/**
 * WatchTopBar — compact inline file-identity bar with Open Link / Open File
 * actions. Sits in the bottom-chrome toolbar strip (left side).
 */

import React, { useState, useCallback, useRef } from 'react';

interface WatchTopBarProps {
  fileKind: string | null;
  fileName: string | null;
  loadingShareCode: string | null;
  onOpenFile: () => void;
  onOpenShareCode: (input: string) => Promise<boolean>;
}

const KIND_LABELS: Record<string, string> = {
  full: 'history',
  reduced: 'preview',
};
function formatKind(kind: string): string {
  return KIND_LABELS[kind] ?? kind;
}

/**
 * Extract a short display name from the full filename.
 *
 * Capsule files from share downloads have the pattern:
 *   atomdojo-capsule-{SHARE_CODE}.atomdojo
 * where SHARE_CODE is 12 Crockford Base32 chars. Show as grouped
 * code: "7M4K-2D8Q-9T1V".
 *
 * Local files with embedded timestamps have the pattern:
 *   atomdojo-capsule-YYYYMMDD-HHMMSS.atomdojo
 * Show as "YYYY-MM-DD HH:MM".
 *
 * Everything else: strip the .atomdojo extension and truncate.
 */
function formatDisplayName(fileName: string, compact = false): string {
  const base = fileName.replace(/\.atomdojo$/i, '').replace(/\.json$/i, '');

  // Share-code capsule: atomdojo-capsule-{12 alphanum chars}
  const shareMatch = base.match(/^atomdojo-capsule-([0-9A-Za-z]{12})$/);
  if (shareMatch) {
    const c = shareMatch[1].toUpperCase();
    if (compact) return `${c.slice(0, 4)}…${c.slice(8, 12)}`;
    return `${c.slice(0, 4)}-${c.slice(4, 8)}-${c.slice(8, 12)}`;
  }

  // Timestamped capsule: atomdojo-capsule-YYYYMMDD-HHMMSS
  const tsMatch = base.match(/^atomdojo-capsule-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})$/);
  if (tsMatch) {
    const [, y, m, d, hh, mm] = tsMatch;
    if (compact) return `${m}/${d} ${hh}:${mm}`;
    return `${y}-${m}-${d} ${hh}:${mm}`;
  }

  // Generic: strip common prefix, keep short
  const short = base.replace(/^atomdojo-/, '');
  const limit = compact ? 12 : 20;
  return short.length > limit ? short.slice(0, limit) + '…' : short;
}

export function WatchTopBar({
  fileKind, fileName, loadingShareCode, onOpenFile, onOpenShareCode,
}: WatchTopBarProps) {
  const [shareInput, setShareInput] = useState('');
  const [showShareInput, setShowShareInput] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const isLoading = loadingShareCode !== null;
  const busy = isLoading || submitting;
  const submittingRef = useRef(false);

  const handleSubmit = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = shareInput.trim();
    if (!trimmed || busy || submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    try {
      const success = await onOpenShareCode(trimmed);
      if (success) {
        setShareInput('');
        setShowShareInput(false);
      }
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }, [shareInput, busy, onOpenShareCode]);

  const displayName = fileName ? formatDisplayName(fileName) : null;
  const compactName = fileName ? formatDisplayName(fileName, true) : null;

  return (
    <div className="watch-topbar" role="region" aria-label="Currently watching">
      {showShareInput ? (
        <form className="watch-topbar__form" onSubmit={handleSubmit}>
          <input
            className="watch-topbar__input"
            type="text"
            placeholder="Paste share link or code"
            value={shareInput}
            onChange={(e) => setShareInput(e.target.value)}
            autoFocus
            aria-label="Share link or code"
            disabled={busy}
          />
          <button
            className="watch-topbar__action"
            type="submit"
            disabled={!shareInput.trim() || busy}
          >
            {busy ? '…' : 'Go'}
          </button>
          <button
            className="watch-topbar__action"
            type="button"
            onClick={() => setShowShareInput(false)}
            disabled={busy}
          >
            ✕
          </button>
        </form>
      ) : (
        <>
          <div className="watch-topbar__identity">
            {fileKind && <span className="watch-topbar__kind">{formatKind(fileKind)}</span>}
            {displayName && (
              <>
                <span className="watch-topbar__filename watch-topbar__filename--full" title={fileName ?? ''}>
                  {displayName}
                </span>
                <span className="watch-topbar__filename watch-topbar__filename--compact" title={fileName ?? ''}>
                  {compactName}
                </span>
              </>
            )}
          </div>
          <div className="watch-topbar__actions">
            <button
              className="watch-topbar__action"
              type="button"
              onClick={() => setShowShareInput(true)}
              disabled={busy}
              aria-label="Open share link"
              title="Open Link"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
                <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
              </svg>
            </button>
            <button
              className="watch-topbar__action"
              type="button"
              onClick={onOpenFile}
              disabled={busy}
              aria-label="Open file"
              title="Open File"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
              </svg>
            </button>
          </div>
        </>
      )}
    </div>
  );
}
