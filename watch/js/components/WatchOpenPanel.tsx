/**
 * WatchOpenPanel — centered empty-state overlay that replaces the
 * former `WatchLanding` page.
 *
 * The Watch workspace (canvas + bottom chrome) is always rendered;
 * this panel floats above `.watch-canvas-area` until a file or share
 * is loaded. Share link is the primary path; Open File is secondary.
 *
 * Accessibility contract: `role="region" aria-labelledby`. Not a
 * modal — the workspace behind the panel is intentionally non-
 * interactive while `visible === true` (right rail hidden, timeline
 * disabled, dock non-playback controls disabled via
 * `emptyStateBlocked`), so there is nothing to trap focus away from.
 * Adding `aria-modal="true"` without a real focus trap would be an
 * a11y regression, not a neutral markup choice.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { WatchOpenProgress } from '../app/watch-controller';
import { formatBytes } from '../../../src/format/bytes';

export interface WatchOpenPanelProps {
  visible: boolean;
  /** Controller-owned open-flow state (discriminated union). */
  openProgress: WatchOpenProgress;
  /** Latest controller error message, if any. Rendered as
   *  `aria-describedby` against the share input. */
  error: string | null;
  /** Resolves `true` when the open completed without setting
   *  `snapshot.error`, `false` on any failure. The panel only clears
   *  its input draft on `true` — a 404 typo is preserved for retry. */
  onOpenShareCode: (input: string) => Promise<boolean>;
  onOpenFile: () => void;
  onDrop: (file: File) => void;
}

const PANEL_TITLE_ID = 'watch-open-panel-title';
const SHARE_ERROR_ID = 'watch-open-panel-error';

function isLoading(progress: WatchOpenProgress): boolean {
  return progress.kind !== 'idle';
}

/** Source-aware panel title. The heading tells the user WHICH path
 *  is in flight (shared capsule via link/code vs. local file) — the
 *  body copy below it reports the stage. */
function panelTitle(progress: WatchOpenProgress): string {
  if (progress.kind === 'share') return 'Opening shared capsule';
  if (progress.kind === 'file') return 'Opening local file';
  return 'Open a shared capsule';
}

/** Normalized share code when a share open is in flight. */
function loadingShareCode(progress: WatchOpenProgress): string | null {
  return progress.kind === 'share' ? progress.code : null;
}

/** Present the share code with dash separators every 4 chars so
 *  `4K53DWWF5DHS` reads as `4K53-DWWF-5DHS` in the detail line. */
function formatShareCodeForDisplay(code: string): string {
  return code.replace(/(.{4})(?=.)/g, '$1-');
}

interface StageCopy {
  /** Stable stage label — this is what the aria-live region
   *  announces. Must NOT include frequently-changing numeric values
   *  (percent, loaded bytes) because the live region would otherwise
   *  chatter "Downloading 10%… 13%… 17%…" at ~3 fps. Stage copy
   *  rotates at most ~3 times per open flow. */
  body: string;
  /** Visual-only detail rendered outside the live region — the
   *  percent string during determinate download, the bytes-loaded
   *  string during unknown-size download. Empty when nothing extra
   *  should render. */
  detail: string;
  /** Percent (0-100) when a determinate bar can be drawn; otherwise
   *  null (indeterminate bar). Carried separately from `body` for
   *  `aria-valuenow` on the progress bar. */
  percent: number | null;
  /** Data attribute for E2E selectors. */
  mode: 'determinate' | 'indeterminate';
}

function describeStage(progress: WatchOpenProgress): StageCopy | null {
  if (progress.kind === 'idle') return null;
  if (progress.kind === 'file') {
    return { body: 'Preparing interactive playback…', detail: '', percent: null, mode: 'indeterminate' };
  }
  // share
  if (progress.stage === 'metadata') {
    return { body: 'Finding shared capsule…', detail: '', percent: null, mode: 'indeterminate' };
  }
  if (progress.stage === 'prepare') {
    return { body: 'Preparing interactive playback…', detail: '', percent: null, mode: 'indeterminate' };
  }
  // stage === 'download'
  if (progress.totalBytes != null && progress.totalBytes > 0) {
    const pct = Math.max(0, Math.min(100, Math.round((progress.loadedBytes / progress.totalBytes) * 100)));
    return {
      body: 'Downloading capsule…',
      detail: `${pct}%`,
      percent: pct,
      mode: 'determinate',
    };
  }
  return {
    body: 'Downloading capsule…',
    detail: formatBytes(progress.loadedBytes),
    percent: null,
    mode: 'indeterminate',
  };
}

export function WatchOpenPanel({
  visible, openProgress, error,
  onOpenShareCode, onOpenFile, onDrop,
}: WatchOpenPanelProps) {
  const [shareInput, setShareInput] = useState('');
  const [dragActive, setDragActive] = useState(false);
  // Local submitting flag — gives instant button feedback before
  // the controller snapshot propagates (avoids a 1-frame "freeze"
  // where the button looks clickable but the async flow has started).
  const [submitting, setSubmitting] = useState(false);
  const dragDepth = useRef(0);
  // Ref-level re-entry guard — closes the microtask gap between the
  // first submit firing `onOpenShareCode` (which updates the store
  // synchronously) and React re-rendering with `disabled={true}`.
  const submittingRef = useRef(false);
  // Mounted flag — on successful open the parent flips
  // `visible=false` and the panel unmounts while `await
  // onOpenShareCode(...)` is still in flight. The post-await
  // `setShareInput('')` would otherwise run on an unmounted
  // component and log a React dev warning.
  const mountedRef = useRef(true);
  useEffect(() => () => { mountedRef.current = false; }, []);

  const loading = isLoading(openProgress);
  const loadingCode = loadingShareCode(openProgress);

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    // Don't visually "activate" while a load is in flight — the drop
    // would be ignored anyway, so the hover cue would be misleading.
    if (loading) return;
    dragDepth.current++;
    setDragActive(true);
  }, [loading]);
  const handleDragLeave = useCallback(() => {
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragActive(false);
  }, []);
  const handleDragOver = useCallback((e: React.DragEvent) => { e.preventDefault(); }, []);
  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    dragDepth.current = 0;
    setDragActive(false);
    // Match the disabled state of the share/file buttons — a drop
    // during loading would otherwise kick off a concurrent local
    // openFile() racing the in-flight share pipeline.
    if (loading) return;
    const f = e.dataTransfer?.files?.[0];
    if (f) onDrop(f);
  }, [loading, onDrop]);

  const handleSubmit = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = shareInput.trim();
    if (!trimmed || loading || submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    try {
      const success = await onOpenShareCode(trimmed);
      if (success && mountedRef.current) setShareInput('');
    } finally {
      submittingRef.current = false;
      if (mountedRef.current) setSubmitting(false);
    }
  }, [shareInput, loading, onOpenShareCode]);

  if (!visible) return null;

  const stage = describeStage(openProgress);

  return (
    <div className="watch-open-panel-layer" data-testid="watch-open-panel-layer">
      <div
        className={`watch-open-panel${dragActive ? ' watch-open-panel--drag-active' : ''}`}
        role="region"
        aria-labelledby={PANEL_TITLE_ID}
        onDragEnter={handleDragEnter}
        onDragLeave={handleDragLeave}
        onDragOver={handleDragOver}
        onDrop={handleDrop}
      >
        <p className="watch-open-panel__eyebrow">Watch</p>
        <h2 id={PANEL_TITLE_ID} className="watch-open-panel__title">
          {panelTitle(openProgress)}
        </h2>
        <p className="watch-open-panel__body">
          {/* aria-live wraps ONLY the stable stage label — at most
              three announcements per flow ("Finding…" →
              "Downloading…" → "Preparing…"). The visual detail
              (percent or loaded-bytes) updates at ~3 fps during
              download and lives OUTSIDE the live region so screen
              readers don't chatter "Downloading 10%… 13%… 17%…"
              on every throttled publish. Determinate progress is
              conveyed to AT via the progressbar's `aria-valuenow`. */}
          <span aria-live={loading ? 'polite' : undefined}>
            {loading
              ? (stage?.body ?? 'Opening…')
              : 'Paste an AtomDojo share link or code to start watching.'}
          </span>
          {loading && stage?.detail && (
            <>
              {' '}
              <span className="watch-open-panel__detail" aria-hidden="true">
                {stage.detail}
              </span>
            </>
          )}
        </p>

        {/* Slim progress bar — present only while loading. */}
        {loading && stage && (
          <div
            className={`watch-open-panel__progress watch-open-panel__progress--${stage.mode}`}
            role="progressbar"
            aria-label={stage.body}
            aria-valuemin={stage.mode === 'determinate' ? 0 : undefined}
            aria-valuemax={stage.mode === 'determinate' ? 100 : undefined}
            aria-valuenow={stage.mode === 'determinate' && stage.percent != null ? stage.percent : undefined}
            data-progress-mode={stage.mode}
          >
            <div
              className="watch-open-panel__progress-fill"
              style={stage.mode === 'determinate' && stage.percent != null
                ? { width: `${stage.percent}%` }
                : undefined}
            />
          </div>
        )}

        {/* Loading-only detail line (share code). Not rendered when
            idle — the form below takes the space instead. This line
            does not change between stages, so it is NOT aria-live;
            the stage-copy `<span>` above carries the live region. */}
        {loading && loadingCode && (
          <p className="watch-open-panel__status">
            Share code: {formatShareCodeForDisplay(loadingCode)}
          </p>
        )}

        <form
          className="watch-open-panel__form"
          onSubmit={handleSubmit}
          aria-label="Open shared capsule"
        >
          <input
            className="watch-open-panel__input"
            type="text"
            placeholder="Paste share link or code"
            value={shareInput}
            onChange={(e) => setShareInput(e.target.value)}
            disabled={loading || submitting}
            aria-label="Share link or code"
            aria-describedby={error ? SHARE_ERROR_ID : undefined}
            autoFocus={!loading && !submitting}
          />
          <button
            className="watch-open-panel__primary"
            type="submit"
            disabled={!shareInput.trim() || loading || submitting}
          >
            {loading || submitting ? 'Opening…' : 'Open in Watch'}
          </button>
        </form>

        {error && (
          <p
            id={SHARE_ERROR_ID}
            className="watch-open-panel__error"
            role="alert"
          >
            {error}
          </p>
        )}

        <div className="watch-open-panel__secondary-row">
          <button
            className="watch-open-panel__secondary"
            type="button"
            onClick={onOpenFile}
            disabled={loading}
          >
            Open local file
          </button>
          <span className="watch-open-panel__drop-hint">
            or drop a .atomdojo file anywhere on this panel
          </span>
        </div>

        {/* Plan's UX Direction Loading State spec lists this as
            shared chrome for ALL loading stages — shown while
            loading, hidden in the idle empty state. */}
        {loading && (
          <p className="watch-open-panel__muted">
            This can take a few seconds for large capsules.
          </p>
        )}
      </div>
    </div>
  );
}
