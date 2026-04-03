/**
 * StructureChooser — React-authoritative structure picker sheet.
 *
 * Replaces imperative #chooser-sheet and populateStructureDrawer() in main.ts.
 * Renders the full sheet markup with same CSS classes for visual parity.
 * Uses useSheetAnimation for open/close CSS transitions.
 */

import React, { useCallback } from 'react';
import { useAppStore } from '../store/app-store';
import { selectIsReviewLocked } from '../store/selectors/review-ui-lock';
import { showReviewModeActionHint } from '../runtime/review-mode-action-hints';
import { ReviewLockedControl } from './ReviewLockedControl';
import { useSheetAnimation } from '../hooks/useSheetAnimation';

export function StructureChooser() {
  const activeSheet = useAppStore((s) => s.activeSheet);
  const structures = useAppStore((s) => s.availableStructures);
  const recentStructure = useAppStore((s) => s.recentStructure);
  const chooserCallbacks = useAppStore((s) => s.chooserCallbacks);
  const closeOverlay = useAppStore((s) => s.closeOverlay);
  const isReviewLocked = useAppStore(selectIsReviewLocked);

  const isOpen = activeSheet === 'chooser';
  const { ref, mounted, animating, onTransitionEnd } = useSheetAnimation(isOpen);

  const handleSelect = useCallback((file: string, description: string) => {
    if (isReviewLocked) { showReviewModeActionHint(); return; }
    closeOverlay?.();
    chooserCallbacks?.onSelectStructure(file, description);
  }, [closeOverlay, chooserCallbacks, isReviewLocked]);

  const handleRecent = useCallback(() => {
    if (!recentStructure) return;
    if (isReviewLocked) { showReviewModeActionHint(); return; }
    closeOverlay?.();
    chooserCallbacks?.onSelectStructure(recentStructure.file, recentStructure.name);
  }, [closeOverlay, chooserCallbacks, recentStructure, isReviewLocked]);

  if (!mounted) return null;

  const sheetClass = `sheet${animating ? ' open' : ''}`;

  return (
    <aside
      ref={ref as React.RefObject<HTMLElement>}
      className={sheetClass}
      aria-hidden={!isOpen}
      inert={!isOpen ? true : undefined}
      onTransitionEnd={onTransitionEnd}
    >
      <div className="sheet-handle" />
      <div className="sheet-header">Choose Structure</div>
      <div style={{
        padding: 'var(--space-md) var(--space-lg)',
        paddingBottom: 'calc(var(--space-lg) + env(safe-area-inset-bottom, 0px))',
      }}>
        {/* Recent row */}
        {recentStructure && (
          isReviewLocked ? (
            <ReviewLockedControl label={`${recentStructure.name} (unavailable in Review)`}>
              <div className="chooser-recent review-locked" onClick={handleRecent}>
                <span className="chooser-recent-label">Recent</span>
                <span className="chooser-recent-name">{recentStructure.name}</span>
              </div>
            </ReviewLockedControl>
          ) : (
            <div className="chooser-recent" onClick={handleRecent}>
              <span className="chooser-recent-label">Recent</span>
              <span className="chooser-recent-name">{recentStructure.name}</span>
            </div>
          )
        )}
        {/* Structure list */}
        {structures.map((s) => (
          isReviewLocked ? (
            <ReviewLockedControl key={s.key} label={`${s.description} (unavailable in Review)`}>
              <div className="drawer-item review-locked" onClick={() => handleSelect(s.file, s.description)}>
                {s.description} ({s.atomCount} atoms)
              </div>
            </ReviewLockedControl>
          ) : (
            <div
              key={s.key}
              className="drawer-item"
              onClick={() => handleSelect(s.file, s.description)}
            >
              {s.description} ({s.atomCount} atoms)
            </div>
          )
        ))}
      </div>
    </aside>
  );
}
