/** Timeline export dialog — trigger icon, format selection dialog, and open/close hook.
 *  Used by TimelineBar for the export action zone slot.
 *  Mirrors the clear-dialog accessibility contract (focus trap, Escape, backdrop). */

import React, { useCallback, useRef, useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { ActionHint } from './ActionHint';
import { TIMELINE_HINTS } from './timeline-hints';

// ── Types ──

export type TimelineExportKind = 'replay' | 'full';

// ── Hook ──

export function useExportDialog() {
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<TimelineExportKind>('replay');
  const request = useCallback(() => { setOpen(true); }, []);
  const cancel = useCallback(() => { setOpen(false); }, []);
  const reset = useCallback(() => { setOpen(false); setKind('replay'); }, []);
  return { open, kind, request, cancel, reset, setKind };
}

// ── Export trigger icon ──

function ExportIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M7 2v7" />
      <path d="M4 6l3 3 3-3" />
      <path d="M2 11h10" />
    </svg>
  );
}

export function ExportTrigger({ onClick }: { onClick: () => void }) {
  return (
    <ActionHint text={TIMELINE_HINTS.exportHistory}>
      <button
        className="timeline-export-trigger"
        onClick={onClick}
        aria-label="Export timeline history"
      >
        <ExportIcon />
      </button>
    </ActionHint>
  );
}

// ── Dialog ──

interface TimelineExportDialogProps {
  open: boolean;
  availableKinds: { replay: boolean; full: boolean };
  kind: TimelineExportKind;
  submitting: boolean;
  /** True when the export action is reachable (callback + capability both present). */
  confirmEnabled: boolean;
  error: string | null;
  replayEstimate?: string;
  fullEstimate?: string;
  onSelectKind: (kind: TimelineExportKind) => void;
  onCancel: () => void;
  onConfirm: () => void;
}

export function TimelineExportDialog({
  open, availableKinds, kind, submitting, confirmEnabled, error,
  replayEstimate, fullEstimate,
  onSelectKind, onCancel, onConfirm,
}: TimelineExportDialogProps) {
  const firstEnabledRef = useRef<HTMLInputElement>(null);
  const secondRef = useRef<HTMLInputElement>(null);
  const prevOpen = useRef(false);

  // Focus first enabled option on open transition
  useEffect(() => {
    if (open && !prevOpen.current) {
      // Delay to ensure DOM is ready
      requestAnimationFrame(() => {
        if (kind === 'replay' && availableKinds.replay) {
          firstEnabledRef.current?.focus();
        } else if (kind === 'full' && availableKinds.full) {
          secondRef.current?.focus();
        } else if (availableKinds.replay) {
          firstEnabledRef.current?.focus();
        } else if (availableKinds.full) {
          secondRef.current?.focus();
        } else {
          // Fallback: focus Cancel when no radio is enabled
          const dialog = firstEnabledRef.current?.closest('.timeline-export-dialog')
            ?? document.querySelector('.timeline-export-dialog');
          dialog?.querySelector<HTMLButtonElement>('.timeline-export-dialog__cancel')?.focus();
        }
      });
    }
    prevOpen.current = open;
  }, [open, kind, availableKinds]);

  // Escape key + focus trap
  useEffect(() => {
    if (!open) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        e.preventDefault();
        onCancel();
      }
      if (e.key === 'Tab') {
        const dialog = firstEnabledRef.current?.closest('.timeline-export-dialog');
        if (!dialog) return;
        const focusable = dialog.querySelectorAll<HTMLElement>('button:not(:disabled)');
        if (focusable.length === 0) return;
        if (focusable.length === 1) { e.preventDefault(); focusable[0].focus(); return; }
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault(); last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault(); first.focus();
        }
      }
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [open, onCancel]);

  if (!open) return null;
  return createPortal(
    <>
      <div className="timeline-dialog-backdrop" onClick={onCancel} />
      <div className="timeline-modal-card timeline-export-dialog" role="dialog" aria-modal="true" aria-label="Export History">
        <p className="timeline-export-dialog__title">Export History</p>
        <div className="timeline-export-dialog__options" role="radiogroup" aria-label="Export format">
          <label className={`timeline-export-dialog__option${!availableKinds.replay ? ' timeline-export-dialog__option--disabled' : ''}`}>
            <input
              ref={firstEnabledRef}
              className="timeline-export-dialog__radio-native"
              type="radio"
              name="export-kind"
              value="replay"
              checked={kind === 'replay'}
              disabled={!availableKinds.replay}
              onChange={() => onSelectKind('replay')}
              tabIndex={-1}
            />
            <span className="timeline-export-dialog__radio-ui" aria-hidden="true" />
            <span className="timeline-export-dialog__option-text">
              <strong>Replay</strong>
              <span>Small file, playback only</span>
              {replayEstimate ? <span className="timeline-export-dialog__estimate">{replayEstimate}</span> : null}
            </span>
          </label>
          <label className={`timeline-export-dialog__option${!availableKinds.full ? ' timeline-export-dialog__option--disabled' : ''}`}>
            <input
              ref={secondRef}
              className="timeline-export-dialog__radio-native"
              type="radio"
              name="export-kind"
              value="full"
              checked={kind === 'full'}
              disabled={!availableKinds.full}
              onChange={() => onSelectKind('full')}
              tabIndex={-1}
            />
            <span className="timeline-export-dialog__radio-ui" aria-hidden="true" />
            <span className="timeline-export-dialog__option-text">
              <strong>Full</strong>
              <span>Review-complete playback</span>
              {fullEstimate ? <span className="timeline-export-dialog__estimate">{fullEstimate}</span> : null}
            </span>
          </label>
        </div>
        {error && <p className="timeline-export-dialog__error">{error}</p>}
        <div className="timeline-export-dialog__actions">
          <button className="timeline-export-dialog__cancel" onClick={onCancel}>Cancel</button>
          <button className="timeline-export-dialog__confirm" onClick={onConfirm} disabled={submitting || !confirmEnabled}>
            {submitting ? 'Exporting…' : 'Download'}
          </button>
        </div>
      </div>
    </>,
    document.body,
  );
}
