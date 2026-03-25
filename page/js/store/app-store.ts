/**
 * Zustand store for NanoToybox UI state.
 *
 * This store manages UI chrome state that React components subscribe to.
 * Physics/renderer/worker state stays imperative outside the store.
 *
 * Implements the UIStateBridge interface from Milestone C — the Zustand store
 * replaces the imperative adapter, providing reactive state for React components.
 *
 * Throttling: updateDiagnostics and updatePlaybackMetrics are called at max 5 Hz
 * from the frame loop's coalesced status tick. No per-frame React re-renders.
 */

import { create } from 'zustand';

export interface MoleculeMetadata {
  id: number;
  name: string;
  structureFile: string;
  atomCount: number;
  atomOffset: number;
}

/** An entry from the loaded structure manifest — available to add. */
export interface StructureOption {
  key: string;
  description: string;
  atomCount: number;
  file: string;
}

/** Imperative callbacks registered by main.ts, invoked by React Dock component. */
export interface DockCallbacks {
  onAdd: () => void;
  onPause: () => void;
  onSettings: () => void;
  onCancel: () => void;
  onModeChange: (mode: string) => void;
}

/** Imperative callbacks registered by main.ts, invoked by React SettingsSheet. */
export interface SettingsCallbacks {
  onSpeedChange: (val: string) => void;
  onThemeChange: (theme: string) => void;
  onBoundaryChange: (mode: string) => void;
  onDragChange: (v: number) => void;
  onRotateChange: (v: number) => void;
  onDampingChange: (d: number) => void;
  onTextSizeChange: (size: string) => void;
  onAddMolecule: () => void;
  onClear: () => void;
  onResetView: () => void;
}

/** Imperative callbacks registered by main.ts, invoked by React StructureChooser. */
export interface ChooserCallbacks {
  onSelectStructure: (file: string, description: string) => void;
}

export interface AppStore {
  // UI chrome state
  theme: 'dark' | 'light';
  textSize: 'normal' | 'large';
  activeSheet: 'settings' | 'chooser' | null;
  interactionMode: 'atom' | 'move' | 'rotate';

  // Scene-authoritative state
  atomCount: number;
  activeAtomCount: number;
  wallRemovedCount: number;

  // Worker-diagnostics-sourced (updated at max 5 Hz)
  ke: number;
  wallRadius: number;
  skippedFrameCount: number;
  emergencyAllocCount: number;

  // Scheduler-computed (from frame loop, coalesced at 5 Hz)
  maxSpeed: number;
  effectiveSpeed: number;
  fps: number;
  placementActive: boolean;
  placementStale: boolean;
  warmUpComplete: boolean;
  overloaded: boolean;
  workerStalled: boolean;
  rafIntervalMs: number;

  // Reconciliation (debug-visible)
  reconciliationState: 'none' | 'awaiting_positions' | 'awaiting_bonds';

  // Playback
  paused: boolean;
  targetSpeed: number;

  // Scene metadata (UI-side only, not physics truth)
  molecules: MoleculeMetadata[];

  // Available structures from loaded manifest
  availableStructures: StructureOption[];

  // Physics-derived settings (authoritative values for React sliders)
  dragStrength: number;
  rotateStrength: number;
  dampingSliderValue: number;  // 0-100 slider position, not the computed damping

  // Status channels (replaces imperative StatusController text surface)
  statusText: string | null;   // transient UI text ("Loading...", "Placing...", etc.)
  statusError: string | null;  // error state ("Failed to load structures...")

  // Sheet UI state
  boundaryMode: 'contain' | 'remove';
  helpPageActive: boolean;
  recentStructure: { file: string; name: string } | null;

  // Imperative callbacks (registered by main.ts, consumed by React components)
  closeOverlay: (() => void) | null;  // synchronized close gateway
  dockCallbacks: DockCallbacks | null;
  settingsCallbacks: SettingsCallbacks | null;
  chooserCallbacks: ChooserCallbacks | null;

  // Actions
  setTheme: (theme: 'dark' | 'light') => void;
  setTextSize: (size: 'normal' | 'large') => void;
  openSheet: (sheet: 'settings' | 'chooser') => void;
  closeSheet: () => void;
  setInteractionMode: (mode: 'atom' | 'move' | 'rotate') => void;
  setTargetSpeed: (speed: number) => void;
  togglePause: () => void;

  // Scene-authoritative updates
  updateAtomCount: (n: number) => void;
  updateActiveCount: (active: number, removed: number) => void;
  setPlacementActive: (active: boolean) => void;
  setMolecules: (molecules: MoleculeMetadata[]) => void;
  setAvailableStructures: (structures: StructureOption[]) => void;

  // Worker-diagnostics updates (throttled to 5 Hz by caller)
  updateDiagnostics: (diag: Partial<Pick<AppStore, 'ke' | 'wallRadius' | 'skippedFrameCount' | 'emergencyAllocCount'>>) => void;
  resetDiagnostics: () => void;

  // Scheduler-computed playback metrics (throttled to 5 Hz by caller)
  // Note: placementActive and paused are NOT here — they're event-driven
  // (setPlacementActive / togglePause), not throttled telemetry.
  updatePlaybackMetrics: (metrics: {
    maxSpeed: number;
    effectiveSpeed: number;
    fps: number;
    placementStale: boolean;
    warmUpComplete: boolean;
    overloaded: boolean;
    workerStalled: boolean;
    rafIntervalMs: number;
  }) => void;

  // Reconciliation state
  setReconciliationState: (state: 'none' | 'awaiting_positions' | 'awaiting_bonds') => void;

  // Sheet UI actions
  setDragStrength: (v: number) => void;
  setRotateStrength: (v: number) => void;
  setDampingSliderValue: (v: number) => void;
  setBoundaryMode: (mode: 'contain' | 'remove') => void;
  setStatusText: (text: string | null) => void;
  setStatusError: (error: string | null) => void;
  setHelpPageActive: (active: boolean) => void;
  setRecentStructure: (recent: { file: string; name: string } | null) => void;

  // Imperative callback registration
  setCloseOverlay: (cb: () => void) => void;
  setDockCallbacks: (cbs: DockCallbacks) => void;
  setSettingsCallbacks: (cbs: SettingsCallbacks) => void;
  setChooserCallbacks: (cbs: ChooserCallbacks) => void;

  // Lifecycle
  resetTransientState: () => void;
}

export const useAppStore = create<AppStore>((set) => ({
  // Initial state
  theme: 'dark',
  textSize: 'normal',
  activeSheet: null,
  interactionMode: 'atom',
  atomCount: 0,
  activeAtomCount: 0,
  wallRemovedCount: 0,
  ke: 0,
  wallRadius: 0,
  skippedFrameCount: 0,
  emergencyAllocCount: 0,
  maxSpeed: 1,
  effectiveSpeed: 0,
  fps: 0,
  placementActive: false,
  placementStale: false,
  warmUpComplete: false,
  overloaded: false,
  workerStalled: false,
  rafIntervalMs: 16.67,
  reconciliationState: 'none',
  paused: false,
  targetSpeed: 1,
  molecules: [],
  availableStructures: [],
  dragStrength: 2.0,
  rotateStrength: 5,
  dampingSliderValue: 0,
  statusText: null,
  statusError: null,
  boundaryMode: 'contain',
  helpPageActive: false,
  recentStructure: null,
  closeOverlay: null,
  dockCallbacks: null,
  settingsCallbacks: null,
  chooserCallbacks: null,

  // Actions
  setTheme: (theme) => set({ theme }),
  setTextSize: (size) => set({ textSize: size }),
  openSheet: (sheet) => set({ activeSheet: sheet }),
  closeSheet: () => set({ activeSheet: null }),
  setInteractionMode: (mode) => set({ interactionMode: mode }),
  setTargetSpeed: (speed) => set({ targetSpeed: speed }),
  togglePause: () => set((s) => ({ paused: !s.paused })),

  updateAtomCount: (n) => set({ atomCount: n }),
  updateActiveCount: (active, removed) => set({ activeAtomCount: active, wallRemovedCount: removed }),
  setPlacementActive: (active) => set({ placementActive: active }),
  setMolecules: (molecules) => set({ molecules }),
  setAvailableStructures: (structures) => set({ availableStructures: structures }),

  updateDiagnostics: (diag) => set(diag),
  resetDiagnostics: () => set({
    ke: 0,
    wallRadius: 0,
    skippedFrameCount: 0,
    emergencyAllocCount: 0,
  }),

  updatePlaybackMetrics: (metrics) => set(metrics),
  setReconciliationState: (state) => set({ reconciliationState: state }),
  setDragStrength: (v) => set({ dragStrength: v }),
  setRotateStrength: (v) => set({ rotateStrength: v }),
  setDampingSliderValue: (v) => set({ dampingSliderValue: v }),
  setBoundaryMode: (mode) => set({ boundaryMode: mode }),
  setStatusText: (text) => set({ statusText: text }),
  setStatusError: (error) => set({ statusError: error }),
  setHelpPageActive: (active) => set({ helpPageActive: active }),
  setRecentStructure: (recent) => set({ recentStructure: recent }),
  setCloseOverlay: (cb) => set({ closeOverlay: cb }),
  setDockCallbacks: (cbs) => set({ dockCallbacks: cbs }),
  setSettingsCallbacks: (cbs) => set({ settingsCallbacks: cbs }),
  setChooserCallbacks: (cbs) => set({ chooserCallbacks: cbs }),

  resetTransientState: () => set({
    // Callbacks
    closeOverlay: null,
    dockCallbacks: null,
    settingsCallbacks: null,
    chooserCallbacks: null,
    // UI chrome
    activeSheet: null,
    helpPageActive: false,
    recentStructure: null,
    interactionMode: 'atom',
    // Scene
    atomCount: 0,
    activeAtomCount: 0,
    wallRemovedCount: 0,
    molecules: [],
    availableStructures: [],
    // Playback
    paused: false,
    targetSpeed: 1,
    placementActive: false,
    // Scheduler
    maxSpeed: 1,
    effectiveSpeed: 0,
    fps: 0,
    rafIntervalMs: 16.67,
    placementStale: false,
    warmUpComplete: false,
    overloaded: false,
    workerStalled: false,
    // Diagnostics
    ke: 0,
    wallRadius: 0,
    skippedFrameCount: 0,
    emergencyAllocCount: 0,
    // Debug
    reconciliationState: 'none',
    // Status channels
    statusText: null,
    statusError: null,
  }),
}));
