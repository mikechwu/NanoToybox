/**
 * Watch React root — mounts the React component tree.
 * Mount point is div#watch-root in watch/index.html.
 */

import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { WatchApp } from '../components/WatchApp';
import type { WatchController } from './watch-controller';

let root: Root | null = null;

export function mountWatchUI(controller: WatchController) {
  const container = document.getElementById('watch-root');
  if (!container) {
    console.warn('[watch] #watch-root not found — React UI not mounted');
    return;
  }
  root = createRoot(container);
  root.render(
    <React.StrictMode>
      <WatchApp controller={controller} />
    </React.StrictMode>
  );
}

export function unmountWatchUI() {
  if (root) {
    root.unmount();
    root = null;
  }
}
