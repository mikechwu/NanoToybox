/**
 * DockBar — the always-visible toolbar with primary simulation controls.
 *
 * Uses selectDockSurface to derive the active surface ('primary' | 'placement')
 * and renders surface-specific structure via JSX conditionals, not CSS hiding.
 * Controls not relevant to the current surface are removed from the DOM entirely.
 *
 * Focus repair: when a surface change removes or disables the focused control,
 * focus is moved to the primary action button. Only fires when focus was inside
 * the dock — never steals focus from outside (canvas, sheets, etc.).
 *
 * Semantics: role="toolbar" (operational controls, not navigation destinations).
 */

import React, { useCallback, useLayoutEffect, useRef } from 'react';
import { useAppStore } from '../store/app-store';
import { selectDockSurface } from '../store/selectors/dock';
import { selectIsReviewLocked, REVIEW_LOCK_TOOLTIP } from '../store/selectors/review-ui-lock';
import { showReviewModeActionHint } from '../runtime/overlay/review-mode-action-hints';
import { Segmented } from './Segmented';
import { ReviewLockedControl } from './ReviewLockedControl';
import { IconAdd, IconCheck, IconCancel, IconPause, IconResume, IconSettings } from './Icons';

/** Dock-local helper: renders a button inside ReviewLockedControl when review-locked. */
function DockLockedButton({ label, icon, text, buttonRef, className }: {
  label: string; icon: React.ReactNode; text: string;
  buttonRef?: React.Ref<HTMLButtonElement>; className?: string;
}) {
  return (
    <ReviewLockedControl label={label}>
      <button ref={buttonRef} className={`dock-item${className ? ` ${className}` : ''}`} aria-disabled="true">
        <span className="dock-icon">{icon}</span>
        <span className="dock-label">{text}</span>
      </button>
    </ReviewLockedControl>
  );
}

const BASE_MODES = [
  { value: 'atom' as const, label: 'Atom' },
  { value: 'move' as const, label: 'Move' },
  { value: 'rotate' as const, label: 'Rotate' },
];

/** Check if an element is still keyboard-focusable in its current DOM state. */
function isStillKeyboardFocusable(el: HTMLElement): boolean {
  if (!document.contains(el)) return false;
  if ((el as HTMLButtonElement).disabled) return false;
  if (el.closest('[inert]')) return false;
  if (el.getAttribute('aria-hidden') === 'true') return false;
  if (el.tabIndex < 0) return false;
  if (el.offsetParent === null && getComputedStyle(el).position !== 'fixed') return false;
  return true;
}

export function DockBar() {
  const interactionMode = useAppStore((s) => s.interactionMode);
  const paused = useAppStore((s) => s.paused);
  const dockSurface = useAppStore(selectDockSurface);
  const dockCallbacks = useAppStore((s) => s.dockCallbacks);
  const isReviewLocked = useAppStore(selectIsReviewLocked);

  const isPlacement = dockSurface === 'placement';

  // Focus repair refs
  const barRef = useRef<HTMLDivElement>(null);
  const primaryActionRef = useRef<HTMLButtonElement>(null);
  const lastDockFocusRef = useRef<HTMLElement | null>(null);
  const mountedRef = useRef(false);

  // Track last-focused dock element via capture-phase focus handler
  const handleFocusCapture = useCallback((e: React.FocusEvent) => {
    lastDockFocusRef.current = e.target as HTMLElement;
  }, []);

  // Focus repair: only fires when the focused dock control is removed or disabled
  useLayoutEffect(() => {
    if (!mountedRef.current) { mountedRef.current = true; return; }
    const lastFocused = lastDockFocusRef.current;
    if (!lastFocused) return;
    // Only repair if focus is currently inside the dock or lost to <body>
    const active = document.activeElement;
    const focusInDock = barRef.current?.contains(active);
    const focusLost = active === document.body || active === null;
    if (!focusInDock && !focusLost) return;
    if (!isStillKeyboardFocusable(lastFocused)) {
      primaryActionRef.current?.focus();
    }
  }, [dockSurface]);

  const handleAdd = useCallback(() => dockCallbacks?.onAdd(), [dockCallbacks]);
  const handlePause = useCallback(() => dockCallbacks?.onPause(), [dockCallbacks]);
  const handleSettings = useCallback(() => dockCallbacks?.onSettings(), [dockCallbacks]);
  const handleCancel = useCallback(() => dockCallbacks?.onCancel(), [dockCallbacks]);
  const handleMode = useCallback(
    (mode: 'atom' | 'move' | 'rotate') => dockCallbacks?.onModeChange(mode),
    [dockCallbacks],
  );
  const handleDisabledMode = useCallback(() => showReviewModeActionHint(), []);

  const modes = isReviewLocked
    ? BASE_MODES.map(m => ({ ...m, disabled: true, disabledReason: REVIEW_LOCK_TOOLTIP }))
    : BASE_MODES;

  return (
    <div
      className="dock-bar"
      role="toolbar"
      aria-label="Simulation controls"
      ref={barRef}
      onFocusCapture={handleFocusCapture}
    >
      {/* Slot A: Add / Place */}
      <div className="dock-slot dock-slot--add">
        {isReviewLocked && !isPlacement ? (
          <DockLockedButton label="Add (unavailable in Review)" icon={<IconAdd />} text="Add" buttonRef={primaryActionRef} className="dock-add-btn" />
        ) : (
          <button
            ref={primaryActionRef}
            className={`dock-item dock-add-btn${isPlacement ? ' dock-placement-accent' : ''}`}
            onClick={handleAdd}
          >
            <span className="dock-icon">{isPlacement ? <IconCheck /> : <IconAdd />}</span>
            <span className="dock-label">{isPlacement ? 'Place' : 'Add'}</span>
          </button>
        )}
      </div>

      {/* Slot B: Mode segmented / Cancel */}
      <div className="dock-slot dock-slot--mode">
        {!isPlacement ? (
          <Segmented
            name="interaction-mode"
            legend="Interaction mode"
            className="dock-mode"
            items={modes}
            activeValue={interactionMode}
            onSelect={handleMode}
            onDisabledSelect={handleDisabledMode}
          />
        ) : (
          <button className="dock-item dock-cancel" onClick={handleCancel}>
            <span className="dock-icon"><IconCancel /></span>
            <span className="dock-label">Cancel</span>
          </button>
        )}
      </div>

      {/* Slot C: Pause / Resume */}
      <div className="dock-slot dock-slot--pause">
        {isReviewLocked ? (
          <DockLockedButton label={`${paused ? 'Resume' : 'Pause'} (unavailable in Review)`} icon={paused ? <IconResume /> : <IconPause />} text={paused ? 'Resume' : 'Pause'} />
        ) : (
          <button
            className="dock-item"
            onClick={handlePause}
            disabled={isPlacement}
          >
            <span className="dock-icon">{paused ? <IconResume /> : <IconPause />}</span>
            <span className="dock-label">{paused ? 'Resume' : 'Pause'}</span>
          </button>
        )}
      </div>

      {/* Slot D: Settings */}
      <div className="dock-slot dock-slot--aux">
        <button
          className="dock-item"
          onClick={handleSettings}
          disabled={isPlacement}
          data-dock-settings
        >
          <span className="dock-icon"><IconSettings /></span>
          <span className="dock-label">Settings</span>
        </button>
      </div>
    </div>
  );
}
