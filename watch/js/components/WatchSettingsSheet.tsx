/**
 * WatchSettingsSheet — settings surface using lab's sheet + group + segmented design system.
 *
 * Uses shared lifecycle hook: useSheetLifecycle (mount/animate/escape/transition).
 * Uses shared CSS: sheet-shell.css, segmented.css.
 * Uses shared component: Segmented from lab.
 *
 * Sections: Smooth Playback, Appearance, File Info, Help (viewer-specific).
 * Speed and repeat live in the dock only.
 *
 * Round 6: adds Smooth Playback group with on/off toggle + Interpolation Method
 * picker (Linear stable default + Experimental methods subgroup). Per-frame
 * diagnostic note surfaces only when the active method diverges from the
 * selected mode (experimental fallback scenarios).
 */

import React, { useState, useEffect, useMemo } from 'react';
import { formatTime } from '../../../lab/js/components/timeline/timeline-format';
import { Segmented } from '../../../lab/js/components/Segmented';
import { useSheetLifecycle } from '../../../src/ui/useSheetLifecycle';
import { WATCH_HELP_SECTIONS } from '../settings/settings-content';
import type { WatchInterpolationMode } from '../settings/watch-settings';
import type { FallbackReason, InterpolationMethodMetadata } from '../playback/watch-trajectory-interpolation';

const THEME_ITEMS = [
  { value: 'dark' as const, label: 'Dark' },
  { value: 'light' as const, label: 'Light' },
];

const TEXT_SIZE_ITEMS = [
  { value: 'normal' as const, label: 'Normal' },
  { value: 'large' as const, label: 'Large' },
];

const SMOOTH_ITEMS = [
  { value: 'off' as const, label: 'Off' },
  { value: 'on' as const, label: 'On' },
];

/** Build Segmented items from registry metadata, filtered to product-visible
 *  methods only. Stable methods first, then experimental. Dev-only methods
 *  are excluded from the user-facing picker.
 *  The discriminated union (ProductMethodMetadata.availability === 'product')
 *  guarantees that `m.id` is WatchInterpolationMode — no unsafe cast. */
function buildProductMethodItems(
  methods: readonly InterpolationMethodMetadata[],
): { value: WatchInterpolationMode; label: string }[] {
  const product = methods.filter(
    (m): m is import('../playback/watch-trajectory-interpolation').ProductMethodMetadata =>
      m.availability === 'product',
  );
  const stable = product.filter(m => m.stability === 'stable');
  const experimental = product.filter(m => m.stability === 'experimental');
  return [...stable, ...experimental].map(m => ({ value: m.id, label: m.label }));
}

/** Human-readable phrasing for per-frame diagnostic notes. Only shown when
 *  activeMethod !== selectedMode. */
function formatFallbackReason(reason: FallbackReason): string {
  switch (reason) {
    case 'none':
      return '';
    case 'disabled':
      return 'smooth playback is off';
    case 'at-boundary':
      return 'timeline edge';
    case 'single-frame':
      return 'single-frame history';
    case 'variable-n':
      return 'atom count changes in this region';
    case 'atomids-mismatch':
      return 'atom identity changes in this region';
    case 'velocities-unavailable':
      return 'velocity data is not aligned in this file';
    case 'insufficient-frames':
      return 'fewer than 4 surrounding frames available';
    case 'window-mismatch':
      return '4-frame window has mismatched atoms';
    case 'capability-declined':
      return 'interpolation capability not available';
    default:
      return '';
  }
}

interface WatchSettingsSheetProps {
  isOpen: boolean;
  onClose: () => void;
  theme: 'dark' | 'light';
  textSize: 'normal' | 'large';
  onSetTheme: (theme: 'dark' | 'light') => void;
  onSetTextSize: (size: 'normal' | 'large') => void;
  /** Round 6: smooth playback + interpolation props. */
  smoothPlayback: boolean;
  interpolationMode: WatchInterpolationMode;
  activeInterpolationMethod: string;
  lastFallbackReason: FallbackReason;
  /** Registry metadata — stable frozen reference from the controller accessor.
   *  The picker filters to availability === 'product' only. */
  registeredMethods: readonly InterpolationMethodMetadata[];
  onToggleSmoothPlayback: () => void;
  onSetInterpolationMode: (mode: WatchInterpolationMode) => void;
  atomCount: number;
  frameCount: number;
  fileKind: string | null;
  endTimePs: number;
  startTimePs: number;
}

export function WatchSettingsSheet({
  isOpen, onClose,
  theme, textSize, onSetTheme, onSetTextSize,
  smoothPlayback, interpolationMode, activeInterpolationMethod, lastFallbackReason,
  registeredMethods,
  onToggleSmoothPlayback, onSetInterpolationMode,
  atomCount, frameCount, fileKind, endTimePs, startTimePs,
}: WatchSettingsSheetProps) {
  const { ref, mounted, animating, onTransitionEnd } = useSheetLifecycle(isOpen, onClose);
  const [helpOpen, setHelpOpen] = useState(false);

  // Close help when sheet closes
  useEffect(() => { if (!mounted) setHelpOpen(false); }, [mounted]);

  const methodItems = useMemo(() => buildProductMethodItems(registeredMethods), [registeredMethods]);
  const hasExperimental = registeredMethods.some(m => m.availability === 'product' && m.stability === 'experimental');

  // Derive whether the selected method exists in the registry and its stability.
  const selectedMeta = registeredMethods.find(m => m.id === interpolationMode);
  const selectedIsNonStable = !!selectedMeta && selectedMeta.stability !== 'stable';

  if (!mounted) return null;

  const durationPs = endTimePs - startTimePs;

  // Per-frame diagnostic: only when smooth playback is actually ON and the
  // selected experimental method diverged from what ran. Never fire when
  // smoothPlayback is off (that's the user's deliberate choice, not a fallback)
  // and never when linear is selected (linear never falls back to itself).
  const showFallbackNote =
    smoothPlayback &&
    selectedIsNonStable &&
    activeInterpolationMethod !== interpolationMode &&
    lastFallbackReason !== 'none' &&
    lastFallbackReason !== 'disabled';

  // Neutral note when smooth is off and a non-stable method is selected —
  // gated on both the selection being non-stable AND the method existing in
  // the registry, so it stays robust as the experiment surface expands.
  const showDisabledNote =
    !smoothPlayback && selectedIsNonStable;

  return (
    <>
      <div className="sheet-backdrop" onClick={onClose} />
      <aside
        ref={ref as React.RefObject<HTMLElement>}
        className={`sheet${animating ? ' open' : ''}`}
        aria-hidden={!isOpen}
        onTransitionEnd={onTransitionEnd}
      >
        <div className="sheet-handle" />

        {helpOpen ? (
          <>
            <div className="sheet-header">
              <button className="watch-help-back" onClick={() => setHelpOpen(false)} type="button">
                &larr; Back
              </button>
            </div>
            {WATCH_HELP_SECTIONS.map(section => (
              <div className="group" key={section.title}>
                <div className="group-header">{section.title}</div>
                <div className="group-list">
                  <div className="group-item">{section.content}</div>
                </div>
              </div>
            ))}
          </>
        ) : (
          <>
            <div className="sheet-header">Settings</div>

            {/* Round 6: Smooth Playback group */}
            <div className="group" data-testid="watch-settings-smooth-group">
              <div className="group-header">Smooth Playback</div>
              <div className="group-list">
                <div className="group-item">
                  <span>Smooth Playback</span>
                  <Segmented
                    name="watch-smooth-playback"
                    legend="Smooth Playback"
                    items={SMOOTH_ITEMS}
                    activeValue={smoothPlayback ? 'on' : 'off'}
                    onSelect={(v) => {
                      if ((v === 'on') !== smoothPlayback) onToggleSmoothPlayback();
                    }}
                  />
                </div>
                <div className="group-item">
                  <span>
                    Interpolation Method
                    {hasExperimental && (
                      <span className="watch-experimental-label" aria-hidden="true"> · experimental methods available</span>
                    )}
                  </span>
                  <Segmented
                    name="watch-interpolation-method"
                    legend="Interpolation Method"
                    items={methodItems}
                    activeValue={interpolationMode}
                    onSelect={onSetInterpolationMode}
                  />
                </div>
                {hasExperimental && (
                  <div className="group-item group-item--note" data-testid="watch-experimental-note">
                    Experimental methods may fall back to Linear automatically when frame data is not safely interpolatable.
                  </div>
                )}
                {showFallbackNote ? (
                  <div className="group-item group-item--note watch-fallback-note" data-testid="watch-fallback-note">
                    Running as <strong>Linear</strong> for this frame — {formatFallbackReason(lastFallbackReason)}.
                  </div>
                ) : null}
                {showDisabledNote ? (
                  <div className="group-item group-item--note" data-testid="watch-disabled-note">
                    Smooth Playback is currently off.
                  </div>
                ) : null}
              </div>
            </div>

            <div className="group">
              <div className="group-header">Appearance</div>
              <div className="group-list">
                <div className="group-item">
                  <span>Theme</span>
                  <Segmented name="watch-theme" legend="Theme" items={THEME_ITEMS} activeValue={theme} onSelect={onSetTheme} />
                </div>
                <div className="group-item">
                  <span>Text Size</span>
                  <Segmented name="watch-text-size" legend="Text Size" items={TEXT_SIZE_ITEMS} activeValue={textSize} onSelect={onSetTextSize} />
                </div>
              </div>
            </div>

            <div className="group">
              <div className="group-header">File Info</div>
              <div className="group-list">
                <div className="group-item"><span>Kind</span><span className="group-value">{fileKind ?? '—'}</span></div>
                <div className="group-item"><span>Atoms</span><span className="group-value">{atomCount}</span></div>
                <div className="group-item"><span>Frames</span><span className="group-value">{frameCount}</span></div>
                <div className="group-item"><span>Duration</span><span className="group-value">{formatTime(durationPs)}</span></div>
              </div>
            </div>

            <div className="group">
              <div className="group-header">Help</div>
              <div className="group-list">
                <button className="group-item group-item--action" onClick={() => setHelpOpen(true)} type="button">
                  <span>Controls</span>
                  <span className="group-value">&rarr;</span>
                </button>
              </div>
            </div>
          </>
        )}
      </aside>
    </>
  );
}
