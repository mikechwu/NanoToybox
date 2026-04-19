/** Clear confirmation dialog and hook for the timeline bar.
 *  Destructive clear always requires confirmation — the icon-only control is too
 *  ambiguous for an irreversible erase action on any device. */

import React, { useCallback, useRef, useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { ActionHint } from '../ActionHint';
import { TIMELINE_HINTS } from './timeline-hints';

// ── Hook ──

export function useClearConfirm(onConfirm: () => void) {
  const [open, setOpen] = useState(false);
  const request = useCallback(() => { setOpen(true); }, []);
  const cancel = useCallback(() => { setOpen(false); }, []);
  const confirm = useCallback(() => { setOpen(false); onConfirm(); }, [onConfirm]);
  return { open, request, cancel, confirm, reset: cancel };
}

// ── Dialog ──

interface TimelineClearDialogProps {
  open: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

export function TimelineClearDialog({ open, onCancel, onConfirm }: TimelineClearDialogProps) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const prevOpen = useRef(false);

  useEffect(() => {
    if (open && !prevOpen.current) {
      cancelRef.current?.focus();
    }
    prevOpen.current = open;
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        e.preventDefault();
        onCancel();
      }
      if (e.key === 'Tab') {
        const dialog = cancelRef.current?.closest('.timeline-clear-dialog');
        if (!dialog) return;
        const focusable = dialog.querySelectorAll<HTMLElement>('button');
        if (focusable.length < 2) return;
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
      <div className="timeline-clear-backdrop" onClick={onCancel} />
      <div className="timeline-modal-card timeline-clear-dialog" role="alertdialog" aria-modal="true" aria-label="Stop recording?">
        <p className="timeline-clear-dialog__title">Stop recording?</p>
        <p className="timeline-clear-dialog__body">This will stop recording and clear timeline history.</p>
        <div className="timeline-clear-dialog__actions">
          <button ref={cancelRef} className="timeline-clear-dialog__cancel" onClick={onCancel}>Cancel</button>
          <button className="timeline-clear-dialog__confirm" onClick={onConfirm}>Continue</button>
        </div>
      </div>
    </>,
    document.body,
  );
}

// ── Close icon ──

function TimelineCloseIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <line x1="3" y1="3" x2="11" y2="11" />
      <line x1="11" y1="3" x2="3" y2="11" />
    </svg>
  );
}

export function ClearTrigger({ onClick }: { onClick: () => void }) {
  return (
    <ActionHint text={TIMELINE_HINTS.clearHistory}>
      <button
        className="timeline-clear-trigger"
        onClick={onClick}
        aria-label="Stop recording and clear history"
      >
        <TimelineCloseIcon />
      </button>
    </ActionHint>
  );
}
