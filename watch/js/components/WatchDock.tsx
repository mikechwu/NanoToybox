/**
 * WatchDock — playback dock with hierarchical control zones.
 *
 * Transport: tap = step, hold = directional play, release = stop.
 * Uses pointer events + capture for cross-device consistency.
 */

import React, { useRef, useCallback, useEffect } from 'react';
import {
  IconPause, IconResume, IconSettings,
  IconStepBack, IconStepForward, IconRepeat,
} from '../../../lab/js/components/Icons';
import { PlaybackSpeedControl } from './PlaybackSpeedControl';
import { HOLD_PLAY_THRESHOLD_MS } from '../../../src/config/playback-speed-constants';

interface WatchDockProps {
  playing: boolean;
  canPlay: boolean;
  speed: number;
  repeat: boolean;
  playDirection: 1 | -1 | 0;
  onTogglePlay: () => void;
  onStepForward: () => void;
  onStepBackward: () => void;
  onSpeedChange: (speed: number) => void;
  onToggleRepeat: () => void;
  onOpenSettings: () => void;
  onStartDirectionalPlayback: (direction: 1 | -1) => void;
  onStopDirectionalPlayback: () => void;
  /** Empty-state a11y gate. When true, the non-playback dock
   *  controls (Repeat, speed range input + reset-to-1x button,
   *  Settings) are disabled regardless of `canPlay`. Set by
   *  `WatchApp` as `!snapshot.loaded` so the `role="region"`
   *  open-panel's "nothing behind me to trap" claim actually holds.
   *  Back/Play/Fwd are unaffected — they're already disabled via
   *  `canPlay=false`. When false (loaded files), all current
   *  behavior is preserved including Repeat pre-arm. */
  emptyStateBlocked?: boolean;
}

/**
 * Hook: tap-step vs hold-play state machine for a transport button.
 *
 * States: idle → armed (timer running) → holding (directional playback active)
 * Tap = release before threshold → single step
 * Hold = threshold crossed → immediate nudge + continuous directional playback
 * Release/cancel/blur/visibility = stop
 *
 * Callbacks are stored in refs so React re-renders (which create new callback
 * identities from snapshot updates) do NOT trigger effect cleanup that would
 * kill an active hold.
 *
 * Pointer capture is optional (try/catch). Global fallback listeners ensure
 * release is always detected regardless of capture support.
 */
function useTransportButton(
  direction: 1 | -1,
  canPlay: boolean,
  onStep: () => void,
  onStartPlay: (d: 1 | -1) => void,
  onStopPlay: () => void,
) {
  // Stable refs for callbacks — prevents re-render from killing active gestures
  const onStepRef = useRef(onStep);
  const onStartPlayRef = useRef(onStartPlay);
  const onStopPlayRef = useRef(onStopPlay);
  const directionRef = useRef(direction);
  const canPlayRef = useRef(canPlay);
  useEffect(() => { onStepRef.current = onStep; }, [onStep]);
  useEffect(() => { onStartPlayRef.current = onStartPlay; }, [onStartPlay]);
  useEffect(() => { onStopPlayRef.current = onStopPlay; }, [onStopPlay]);
  useEffect(() => { directionRef.current = direction; }, [direction]);
  useEffect(() => { canPlayRef.current = canPlay; }, [canPlay]);

  // State: 'idle' | 'armed' | 'holding'
  const state = useRef<'idle' | 'armed' | 'holding'>('idle');
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const globalCleanupRef = useRef<(() => void) | null>(null);

  // Cancel active gesture — used by release, cancel, blur, unmount
  const cancelGesture = useCallback(() => {
    if (holdTimer.current) { clearTimeout(holdTimer.current); holdTimer.current = null; }
    if (state.current === 'holding') onStopPlayRef.current();
    state.current = 'idle';
    globalCleanupRef.current?.();
    globalCleanupRef.current = null;
  }, []); // stable — no deps, uses refs

  // Register global fallbacks while armed or holding
  const registerGlobalFallbacks = useCallback(() => {
    if (globalCleanupRef.current) return;
    const handleRelease = () => cancelGesture();
    const handleVisibility = () => { if (document.hidden) cancelGesture(); };
    window.addEventListener('pointerup', handleRelease);
    window.addEventListener('pointercancel', handleRelease);
    window.addEventListener('blur', handleRelease);
    document.addEventListener('visibilitychange', handleVisibility);
    globalCleanupRef.current = () => {
      window.removeEventListener('pointerup', handleRelease);
      window.removeEventListener('pointercancel', handleRelease);
      window.removeEventListener('blur', handleRelease);
      document.removeEventListener('visibilitychange', handleVisibility);
      globalCleanupRef.current = null;
    };
  }, [cancelGesture]); // stable — cancelGesture has no deps

  // Unmount-only cleanup (stable [] — never re-runs from prop changes)
  useEffect(() => () => cancelGesture(), [cancelGesture]);

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    if (!canPlayRef.current || state.current !== 'idle') return;
    e.preventDefault();
    try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); } catch {}
    state.current = 'armed';
    registerGlobalFallbacks();
    holdTimer.current = setTimeout(() => {
      holdTimer.current = null;
      state.current = 'holding';
      onStepRef.current(); // immediate nudge
      onStartPlayRef.current(directionRef.current); // continuous play
    }, HOLD_PLAY_THRESHOLD_MS);
  }, [registerGlobalFallbacks]); // stable

  const onPointerUp = useCallback(() => {
    if (state.current === 'armed') {
      if (holdTimer.current) { clearTimeout(holdTimer.current); holdTimer.current = null; }
      onStepRef.current(); // tap = single step
    } else if (state.current === 'holding') {
      onStopPlayRef.current();
    }
    state.current = 'idle';
    globalCleanupRef.current?.();
    globalCleanupRef.current = null;
  }, []); // stable

  const onPointerCancel = useCallback(() => cancelGesture(), [cancelGesture]);

  return { onPointerDown, onPointerUp, onPointerCancel };
}

export function WatchDock({
  playing, canPlay, speed, repeat, playDirection,
  onTogglePlay, onStepForward, onStepBackward,
  onSpeedChange, onToggleRepeat, onOpenSettings,
  onStartDirectionalPlayback, onStopDirectionalPlayback,
  emptyStateBlocked = false,
}: WatchDockProps) {
  const backHandlers = useTransportButton(-1, canPlay, onStepBackward, onStartDirectionalPlayback, onStopDirectionalPlayback);
  const fwdHandlers = useTransportButton(1, canPlay, onStepForward, onStartDirectionalPlayback, onStopDirectionalPlayback);

  return (
    <div className="dock-bar watch-dock-bar" role="toolbar" aria-label="Playback controls">
      {/* Zone 1: Transport cluster — Back, Play, Fwd, Repeat.
          Repeat sits adjacent to Fwd (playback-semantic grouping) and
          adopts the icon+label column format of the other transport
          items for visual parity. */}
      <div className="dock-slot watch-dock__transport">
        <button
          className={`dock-item${playDirection === -1 ? ' active' : ''}`}
          disabled={!canPlay}
          type="button"
          {...backHandlers}
        >
          <span className="dock-icon"><IconStepBack /></span>
          <span className="dock-label">Back</span>
        </button>
        <button className="dock-item" onClick={onTogglePlay} disabled={!canPlay} type="button">
          <span className="dock-icon">{playing && playDirection >= 0 ? <IconPause /> : <IconResume />}</span>
          <span className="dock-label">{playing && playDirection >= 0 ? 'Pause' : 'Play'}</span>
        </button>
        <button
          className={`dock-item${playDirection === 1 && playing ? ' active' : ''}`}
          disabled={!canPlay}
          type="button"
          {...fwdHandlers}
        >
          <span className="dock-icon"><IconStepForward /></span>
          <span className="dock-label">Fwd</span>
        </button>
        {/* Repeat is a preference toggle, not a playback control —
            it stays enabled under canPlay=false so users can pre-arm
            the loop before loading a file. `emptyStateBlocked` is a
            stricter empty-state gate (no file loaded AND open panel
            visible) that also disables Repeat so nothing is focusable
            behind the role="region" panel. */}
        <button
          className={`dock-item${repeat ? ' active' : ''}`}
          onClick={onToggleRepeat}
          aria-pressed={repeat}
          aria-label="Repeat"
          type="button"
          disabled={emptyStateBlocked}
        >
          <span className="dock-icon"><IconRepeat /></span>
          <span className="dock-label">Repeat</span>
        </button>
      </div>

      {/* Zone 2: Speed column — PlaybackSpeedControl owns the slider + meta row. */}
      <div className="dock-slot watch-dock__utility">
        <PlaybackSpeedControl
          speed={speed}
          onSpeedChange={onSpeedChange}
          disabled={emptyStateBlocked}
        />
      </div>

      {/* Zone 3: Settings */}
      <div className="dock-slot">
        <button
          className="dock-item"
          onClick={onOpenSettings}
          type="button"
          disabled={emptyStateBlocked}
        >
          <span className="dock-icon"><IconSettings /></span>
          <span className="dock-label">Settings</span>
        </button>
      </div>
    </div>
  );
}
