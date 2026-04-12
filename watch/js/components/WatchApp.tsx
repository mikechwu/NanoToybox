/**
 * WatchApp — top-level watch app shell.
 *
 * Round 5: dock + timeline in bottom chrome, settings sheet, transport commands.
 */

import React, { useState, useCallback, useSyncExternalStore } from 'react';
import type { WatchController } from '../watch-controller';
import { WatchLanding } from './WatchLanding';
import { WatchTopBar } from './WatchTopBar';
import { WatchCanvas } from './WatchCanvas';
import { WatchBondedGroupsPanel } from './WatchBondedGroupsPanel';
import { WatchDock } from './WatchDock';
import { WatchTimeline } from './WatchTimeline';
import { WatchSettingsSheet } from './WatchSettingsSheet';

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

  // Global error banner (visible in both states)
  const errorBanner = snapshot.error ? (
    <div className="watch-error-banner">
      <div className="review-status-msg review-status-msg--error">{snapshot.error}</div>
    </div>
  ) : null;

  if (!snapshot.loaded) {
    return (
      <>
        {errorBanner}
        <WatchLanding onOpenFile={handleOpenFile} onDrop={handleDrop} />
      </>
    );
  }

  return (
    <>
      {errorBanner}
      <div className="watch-workspace">
        <WatchTopBar
          fileKind={snapshot.fileKind}
          fileName={snapshot.fileName}
          onOpenFile={handleOpenFile}
        />
        <div className="watch-canvas-area">
          <WatchCanvas controller={controller} />
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
        </div>
        {/* Bottom region: positioning-only root. Timeline + dock are sibling shells. */}
        <div className="bottom-region" data-watch-bottom-chrome>
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
            smoothPlayback={snapshot.smoothPlayback}
            onTogglePlay={handleTogglePlay}
            onStepForward={handleStepForward}
            onStepBackward={handleStepBackward}
            onSpeedChange={handleSetSpeed}
            onToggleRepeat={handleToggleRepeat}
            onOpenSettings={handleOpenSettings}
            onStartDirectionalPlayback={handleStartDirectional}
            onStopDirectionalPlayback={handleStopDirectional}
            onToggleSmoothPlayback={handleToggleSmoothPlayback}
          />
        </div>
      </div>

      {/* Settings sheet — local open/close state */}
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
