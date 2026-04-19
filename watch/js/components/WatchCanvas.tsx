/**
 * WatchCanvas — owns the Three.js Renderer lifecycle (create/destroy).
 * Does NOT own the playback clock — that's the controller's responsibility.
 * The controller's RAF loop pushes frames into the renderer directly.
 */

import React, { useRef, useEffect } from 'react';
import { VIEWER_DEFAULTS } from '../../../src/config/viewer-defaults';
import type { WatchController } from '../app/watch-controller';

interface WatchCanvasProps {
  controller: WatchController;
}

export function WatchCanvas({ controller }: WatchCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    const renderer = controller.createRenderer(containerRef.current);
    renderer.applyTheme(VIEWER_DEFAULTS.defaultTheme);
    renderer.fitCamera();

    return () => {
      // Single destruction path — detachRenderer() handles destroy + null
      controller.detachRenderer();
    };
  }, [controller]);

  return <div ref={containerRef} style={{ width: '100%', height: '100%' }} />;
}
