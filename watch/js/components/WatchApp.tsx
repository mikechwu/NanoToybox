/**
 * WatchApp — top-level watch app shell.
 *
 * Round 5: dock + timeline in bottom chrome, settings sheet, transport commands.
 */

import React, { useState, useCallback, useEffect, useRef, useSyncExternalStore } from 'react';
import type { WatchController } from '../watch-controller';
import { WatchOpenPanel } from './WatchOpenPanel';
import { WatchTopBar } from './WatchTopBar';
import { WatchCanvas } from './WatchCanvas';
import { WatchBondedGroupsPanel } from './WatchBondedGroupsPanel';
import { WatchCinematicCameraToggle } from './WatchCinematicCameraToggle';
import { WatchDock } from './WatchDock';
import { WatchTimeline } from './WatchTimeline';
import { WatchSettingsSheet } from './WatchSettingsSheet';
import { WatchLabEntryControl } from './WatchLabEntryControl';
import { WatchLabHint } from './WatchLabHint';

interface WatchAppProps {
  controller: WatchController;
}

export function WatchApp({ controller }: WatchAppProps) {
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const [panelExpanded, setPanelExpanded] = useState(true);
  const [smallExpanded, setSmallExpanded] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  // Memoized transport callbacks (secondary hardening for dock hold-play stability)
  const handleTogglePlay = useCallback(() => controller.togglePlay(), [controller]);
  const handleStepForward = useCallback(() => controller.stepForward(), [controller]);
  const handleStepBackward = useCallback(() => controller.stepBackward(), [controller]);
  const handleSetSpeed = useCallback((s: number) => controller.setSpeed(s), [controller]);
  const handleToggleRepeat = useCallback(() => controller.toggleRepeat(), [controller]);
  const handleStartDirectional = useCallback((d: 1 | -1) => controller.startDirectionalPlayback(d), [controller]);
  const handleStopDirectional = useCallback(() => controller.stopDirectionalPlayback(), [controller]);
  const handleOpenSettings = useCallback(() => setSettingsOpen(true), []);

  // Round 6: smooth playback commands
  const handleToggleSmoothPlayback = useCallback(
    () => controller.setSmoothPlayback(!snapshot.smoothPlayback),
    [controller, snapshot.smoothPlayback],
  );
  const handleSetInterpolationMode = useCallback(
    (mode: import('../watch-settings').WatchInterpolationMode) => controller.setInterpolationMode(mode),
    [controller],
  );

  const handleOpenFile = useCallback(() => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.atomdojo,.json,application/json';
    input.onchange = () => {
      if (input.files?.[0]) {
        controller.openFile(input.files[0]).catch(e => {
          console.error('[watch] openFile error:', e);
        });
      }
    };
    input.click();
  }, [controller]);

  const handleDrop = useCallback((file: File) => {
    controller.openFile(file).catch(e => {
      console.error('[watch] drop error:', e);
    });
  }, [controller]);

  /** Returns true iff the controller finished the open without setting
   *  `snapshot.error`. WatchTopBar uses the return value to decide
   *  whether to dismiss its share-input form: on failure we keep the
   *  form mounted with the user's input intact so they can edit + retry
   *  (previously the form cleared + closed unconditionally, trashing
   *  the pasted code on recoverable failures like a 404 typo). */
  const handleOpenShareCode = useCallback(async (input: string): Promise<boolean> => {
    try {
      await controller.openSharedCapsule(input);
    } catch (e) {
      console.error('[watch] share open error:', e);
      return false;
    }
    return !controller.getSnapshot().error;
  }, [controller]);

  // Auto-dismiss error banner: show for 5s then fade out over 0.4s.
  const [visibleError, setVisibleError] = useState<string | null>(null);
  const [errorFading, setErrorFading] = useState(false);
  const errorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (errorTimerRef.current) {
      clearTimeout(errorTimerRef.current);
      errorTimerRef.current = null;
    }
    if (snapshot.error) {
      setVisibleError(snapshot.error);
      setErrorFading(false);
      errorTimerRef.current = setTimeout(() => {
        setErrorFading(true);
        errorTimerRef.current = setTimeout(() => {
          setVisibleError(null);
          setErrorFading(false);
        }, 400);
      }, 5000);
    } else {
      setVisibleError(null);
      setErrorFading(false);
    }
    return () => {
      if (errorTimerRef.current) clearTimeout(errorTimerRef.current);
    };
  }, [snapshot.error, snapshot.errorGeneration]);

  // Rev 6 Ax11 / pre-PR 2 audit: the error surface MUST be a live
  // region so screen readers announce §10 failure toasts (private-
  // mode, quota, stale-handoff, hydrate-failure). `role="status"` +
  // `aria-live="polite"` follows the plan's §9.6 contract.
  // `aria-atomic="true"` makes the whole message read as one unit
  // (the banner copy is short and self-contained).
  const errorBanner = visibleError ? (
    <div
      className={`watch-error-banner${errorFading ? ' watch-error-banner--fading' : ''}`}
      role="status"
      aria-live="polite"
      aria-atomic="true"
    >
      <div className="review-status-msg review-status-msg--error">{visibleError}</div>
    </div>
  ) : null;

  // Workspace-first rendering: canvas area + bottom chrome are always
  // mounted. Right-rail info panel + bonded-groups inspector are
  // conditionally rendered only when a file is loaded (they have no
  // content or context in empty state). The open panel overlays
  // `.watch-canvas-area` while `!snapshot.loaded`. The dock's
  // non-playback controls are disabled via `emptyStateBlocked` so the
  // open panel's `role="region"` a11y claim (nothing behind it to
  // trap) actually holds.
  const isLoaded = snapshot.loaded;

  return (
    <>
      {errorBanner}
      <div className="watch-workspace">
        <div className="watch-canvas-area">
          <WatchCanvas controller={controller} />
          {isLoaded && (
            /* Right rail — bonded-clusters panel only (file info +
               cinematic toggle moved to the bottom chrome toolbar). */
            <div className="watch-analysis">
              <WatchBondedGroupsPanel
                groups={snapshot.groups}
                expanded={panelExpanded}
                smallExpanded={smallExpanded}
                onToggleExpanded={() => setPanelExpanded(e => !e)}
                onToggleSmallExpanded={() => setSmallExpanded(e => !e)}
                following={snapshot.following}
                followedGroupId={snapshot.followedGroupId}
                onHover={(id) => controller.hoverGroup(id)}
                onCenter={(id) => controller.centerOnGroup(id)}
                onFollow={(id) => controller.followGroup(id)}
                onUnfollow={() => controller.unfollowGroup()}
                onApplyGroupColor={(id, hex) => controller.applyGroupColor(id, hex)}
                onClearGroupColor={(id) => controller.clearGroupColor(id)}
                getGroupColorState={(id) => controller.getGroupColorState(id)}
              />
            </div>
          )}
          <WatchOpenPanel
            visible={!isLoaded}
            openProgress={snapshot.openProgress}
            error={snapshot.error}
            onOpenShareCode={handleOpenShareCode}
            onOpenFile={handleOpenFile}
            onDrop={handleDrop}
          />
        </div>
        {/* Bottom region: toolbar + timeline + dock stacked vertically. */}
        <div className="bottom-region" data-watch-bottom-chrome>
          {isLoaded && (
            <div className="watch-toolbar">
              <div className="watch-toolbar__left">
                <WatchTopBar
                  fileKind={snapshot.fileKind}
                  fileName={snapshot.fileName}
                  loadingShareCode={snapshot.loadingShareCode}
                  onOpenFile={handleOpenFile}
                  onOpenShareCode={handleOpenShareCode}
                />
              </div>
              <div className="watch-toolbar__right">
                <div className="watch-lab-entry-anchor">
                  <WatchLabEntryControl
                    enabled={snapshot.labEntryEnabled}
                    currentFrameAvailable={snapshot.labCurrentFrameAvailable}
                    plainLabHref={snapshot.labHref}
                    currentFrameLabHref={snapshot.labCurrentFrameHref}
                    // No onOpenPlainLab — the anchor's target="_blank"
                    // is the sole navigation owner for the primary
                    // path (see WatchLabEntryControlProps docstring).
                    // Wiring a controller nav call here would cause a
                    // duplicate-tab regression. Add only non-
                    // navigating side effects if ever needed.
                    onOpenCurrentFrameLab={() => controller.openLabFromCurrentFrame()}
                    onCaretOpen={() => controller.buildCurrentFrameLabHref()}
                    onCaretClose={() => controller.notifyLabMenuClosed()}
                  />
                  <WatchLabHint
                    hint={snapshot.labHint}
                    onDismiss={(id) => controller.dismissLabHint(id)}
                  />
                </div>
                <WatchCinematicCameraToggle
                  enabled={snapshot.cinematicCameraEnabled}
                  active={snapshot.cinematicCameraActive}
                  status={snapshot.cinematicCameraStatus}
                  onToggle={() => controller.setCinematicCameraEnabled(!snapshot.cinematicCameraEnabled)}
                />
              </div>
            </div>
          )}
          <WatchTimeline
            currentTimePs={snapshot.currentTimePs}
            startTimePs={snapshot.startTimePs}
            endTimePs={snapshot.endTimePs}
            onScrub={(t) => controller.scrub(t)}
          />
          <WatchDock
            playing={snapshot.playing}
            canPlay={snapshot.endTimePs > snapshot.startTimePs}
            speed={snapshot.speed}
            repeat={snapshot.repeat}
            playDirection={snapshot.playDirection}
            onTogglePlay={handleTogglePlay}
            onStepForward={handleStepForward}
            onStepBackward={handleStepBackward}
            onSpeedChange={handleSetSpeed}
            onToggleRepeat={handleToggleRepeat}
            onOpenSettings={handleOpenSettings}
            onStartDirectionalPlayback={handleStartDirectional}
            onStopDirectionalPlayback={handleStopDirectional}
            emptyStateBlocked={!isLoaded}
          />
        </div>
      </div>

      <WatchSettingsSheet
        isOpen={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        theme={snapshot.theme}
        textSize={snapshot.textSize}
        onSetTheme={(t) => controller.setTheme(t)}
        onSetTextSize={(s) => controller.setTextSize(s)}
        smoothPlayback={snapshot.smoothPlayback}
        interpolationMode={snapshot.interpolationMode}
        activeInterpolationMethod={snapshot.activeInterpolationMethod}
        lastFallbackReason={snapshot.lastFallbackReason}
        registeredMethods={controller.getRegisteredInterpolationMethods()}
        onToggleSmoothPlayback={handleToggleSmoothPlayback}
        onSetInterpolationMode={handleSetInterpolationMode}
        atomCount={snapshot.atomCount}
        frameCount={snapshot.frameCount}
        fileKind={snapshot.fileKind}
        endTimePs={snapshot.endTimePs}
        startTimePs={snapshot.startTimePs}
      />
    </>
  );
}
