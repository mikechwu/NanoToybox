/**
 * WatchApp — top-level watch app shell. Switches between landing and workspace.
 */

import React, { useState, useCallback, useSyncExternalStore } from 'react';
import type { WatchController } from '../watch-controller';
import { WatchLanding } from './WatchLanding';
import { WatchTopBar } from './WatchTopBar';
import { WatchCanvas } from './WatchCanvas';
import { WatchPlaybackBar } from './WatchPlaybackBar';
import { WatchBondedGroupsPanel } from './WatchBondedGroupsPanel';

interface WatchAppProps {
  controller: WatchController;
}

export function WatchApp({ controller }: WatchAppProps) {
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const [panelExpanded, setPanelExpanded] = useState(true);
  const [smallExpanded, setSmallExpanded] = useState(false);

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
              atomCount={snapshot.atomCount}
              frameCount={snapshot.frameCount}
            />
          </div>
        </div>
        <WatchPlaybackBar
          currentTimePs={snapshot.currentTimePs}
          startTimePs={snapshot.startTimePs}
          endTimePs={snapshot.endTimePs}
          playing={snapshot.playing}
          canPlay={snapshot.endTimePs > snapshot.startTimePs}
          onTogglePlay={() => controller.togglePlay()}
          onScrub={(t) => controller.scrub(t)}
          onOpenFile={handleOpenFile}
        />
      </div>
    </>
  );
}
