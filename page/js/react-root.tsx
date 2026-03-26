/**
 * React root — mounts React components into the existing DOM.
 *
 * Called from main.ts after the app initializes. React components run
 * alongside the existing imperative DOM during the D migration.
 *
 * The mount point is a div#react-root in index.html.
 */

import React from 'react';
import { createRoot, Root } from 'react-dom/client';
import { StatusBar } from './components/StatusBar';
import { FPSDisplay } from './components/FPSDisplay';
import { DockLayout } from './components/DockLayout';
import { DockBar } from './components/DockBar';
import { CameraControls } from './components/CameraControls';
import { SheetOverlay } from './components/SheetOverlay';
import { SettingsSheet } from './components/SettingsSheet';
import { StructureChooser } from './components/StructureChooser';

let root: Root | null = null;

/** Mount the React component tree into the DOM. */
export function mountReactUI() {
  const container = document.getElementById('react-root');
  if (!container) {
    console.warn('[react] #react-root not found in DOM — React UI not mounted');
    return;
  }

  root = createRoot(container);
  root.render(
    <React.StrictMode>
      <StatusBar />
      <FPSDisplay />
      <CameraControls />
      <DockLayout>
        <DockBar />
      </DockLayout>
      <SheetOverlay />
      <SettingsSheet />
      <StructureChooser />
    </React.StrictMode>
  );
}

/** Unmount the React component tree. */
export function unmountReactUI() {
  if (root) {
    root.unmount();
    root = null;
  }
}
