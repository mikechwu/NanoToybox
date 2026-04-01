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
import { Segmented } from './Segmented';
import { IconAdd, IconCheck, IconCancel, IconPause, IconResume, IconSettings } from './Icons';

const MODES = [
  { value: 'atom', label: 'Atom' },
  { value: 'move', label: 'Move' },
  { value: 'rotate', label: 'Rotate' },
] as const;

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

  return (
    <div
      className="dock-bar"
      role="toolbar"
      aria-label="Simulation controls"
      ref={barRef}
      onFocusCapture={handleFocusCapture}
    >
      {/* Add / Place button — primary action ref for focus repair */}
      <button
        ref={primaryActionRef}
        className={`dock-item dock-add-btn${isPlacement ? ' dock-placement-accent' : ''}`}
        onClick={handleAdd}
      >
        <span className="dock-icon">{isPlacement ? <IconCheck /> : <IconAdd />}</span>
        <span className="dock-label">{isPlacement ? 'Place' : 'Add'}</span>
      </button>

      {/* Mode segmented control — only in primary surface */}
      {!isPlacement && (
        <Segmented
          name="interaction-mode"
          legend="Interaction mode"
          className="dock-mode"
          items={MODES}
          activeValue={interactionMode}
          onSelect={handleMode}
        />
      )}

      {/* Cancel button — only in placement surface */}
      {isPlacement && (
        <button className="dock-item dock-cancel" onClick={handleCancel}>
          <span className="dock-icon"><IconCancel /></span>
          <span className="dock-label">Cancel</span>
        </button>
      )}

      {/* Pause / Resume */}
      <button
        className="dock-item"
        onClick={handlePause}
        disabled={isPlacement}
      >
        <span className="dock-icon">{paused ? <IconResume /> : <IconPause />}</span>
        <span className="dock-label">{paused ? 'Resume' : 'Pause'}</span>
      </button>

      {/* Settings */}
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
  );
}
