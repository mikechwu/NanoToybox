/**
 * FPSDisplay — React-authoritative component for playback speed and FPS.
 *
 * Replaces imperative #fps element. Uses the shared formatStatusText()
 * function for identical text output. Manages its own compact/expanded
 * state (mobile tap-to-expand with 5s auto-collapse).
 *
 * Reads specific fields from the Zustand store via selectors (updated
 * at max 5 Hz from the frame loop's coalesced status tick).
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useAppStore } from '../store/app-store';
import { formatStatusText } from '../format-status';
import { CONFIG, getPhysicsTiming } from '../config';

const EXPAND_DURATION_MS = 5000;

export function FPSDisplay() {
  const workerStalled = useAppStore((s) => s.workerStalled);
  const paused = useAppStore((s) => s.paused);
  const placementActive = useAppStore((s) => s.placementActive);
  const placementStale = useAppStore((s) => s.placementStale);
  const warmUpComplete = useAppStore((s) => s.warmUpComplete);
  const overloaded = useAppStore((s) => s.overloaded);
  const effectiveSpeed = useAppStore((s) => s.effectiveSpeed);
  const fps = useAppStore((s) => s.fps);
  const rafIntervalMs = useAppStore((s) => s.rafIntervalMs);

  const [expanded, setExpanded] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Compact on narrow viewports (matches imperative isCompact threshold)
  const [isCompact, setIsCompact] = useState(window.innerWidth < 768);
  useEffect(() => {
    const onResize = () => setIsCompact(window.innerWidth < 768);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // Tap to expand (mobile): show full details for 5s
  const handleClick = useCallback(() => {
    setExpanded(true);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setExpanded(false), EXPAND_DURATION_MS);
  }, []);

  // Cleanup timer on unmount
  useEffect(() => {
    return () => { if (timerRef.current) clearTimeout(timerRef.current); };
  }, []);

  const text = formatStatusText({
    workerStalled,
    paused,
    placementActive,
    placementStale,
    warmUpComplete,
    overloaded,
    effectiveSpeed,
    fps,
    rafIntervalMs,
    baseStepsPerSecond: getPhysicsTiming().baseStepsPerSecond,
    dt: getPhysicsTiming().dtFs,
    compact: isCompact && !expanded,
  });

  return (
    <div className="react-fps" onClick={handleClick}>{text}</div>
  );
}
