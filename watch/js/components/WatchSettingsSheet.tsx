/**
 * WatchSettingsSheet — settings surface using lab's sheet + group + segmented design system.
 *
 * Uses shared lifecycle hook: useSheetLifecycle (mount/animate/escape/transition).
 * Uses shared CSS: sheet-shell.css, segmented.css.
 * Uses shared component: Segmented from lab.
 *
 * Sections: Appearance, File Info, Help (viewer-specific).
 * Speed and repeat live in the dock only.
 */

import React, { useState, useEffect } from 'react';
import { formatTime } from '../../../lab/js/components/timeline-format';
import { Segmented } from '../../../lab/js/components/Segmented';
import { useSheetLifecycle } from '../../../src/ui/useSheetLifecycle';
import { WATCH_HELP_SECTIONS } from '../settings-content';

const THEME_ITEMS = [
  { value: 'dark' as const, label: 'Dark' },
  { value: 'light' as const, label: 'Light' },
];

const TEXT_SIZE_ITEMS = [
  { value: 'normal' as const, label: 'Normal' },
  { value: 'large' as const, label: 'Large' },
];

interface WatchSettingsSheetProps {
  isOpen: boolean;
  onClose: () => void;
  theme: 'dark' | 'light';
  textSize: 'normal' | 'large';
  onSetTheme: (theme: 'dark' | 'light') => void;
  onSetTextSize: (size: 'normal' | 'large') => void;
  atomCount: number;
  frameCount: number;
  fileKind: string | null;
  endTimePs: number;
  startTimePs: number;
}

export function WatchSettingsSheet({
  isOpen, onClose,
  theme, textSize, onSetTheme, onSetTextSize,
  atomCount, frameCount, fileKind, endTimePs, startTimePs,
}: WatchSettingsSheetProps) {
  const { ref, mounted, animating, onTransitionEnd } = useSheetLifecycle(isOpen, onClose);
  const [helpOpen, setHelpOpen] = useState(false);

  // Close help when sheet closes
  useEffect(() => { if (!mounted) setHelpOpen(false); }, [mounted]);

  if (!mounted) return null;

  const durationPs = endTimePs - startTimePs;

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
