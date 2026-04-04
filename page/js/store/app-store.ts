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
import { CONFIG, DEFAULT_THEME } from '../config';

export interface MoleculeMetadata {
  id: number;
  name: string;
  structureFile: string;
  atomCount: number;
  atomOffset: number;
}

/** Generic camera target identity — supports molecule and bonded-group targets. */
export type CameraTargetRef =
  | { kind: 'molecule'; moleculeId: number }
  | { kind: 'bonded-group'; groupId: string };

/** Persistent follow target — frozen at click time, survives topology changes. */
export type FollowTargetRef =
  | { kind: 'molecule'; moleculeId: number }
  | { kind: 'atom-set'; atomIndices: number[] };

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
  onModeChange: (mode: 'atom' | 'move' | 'rotate') => void;
}

/** Imperative callbacks registered by main.ts, invoked by React SettingsSheet. */
export interface SettingsCallbacks {
  onSpeedChange: (val: '0.5' | '1' | '2' | '4' | 'max') => void;
  onThemeChange: (theme: 'dark' | 'light') => void;
  onBoundaryChange: (mode: 'contain' | 'remove') => void;
  onDragChange: (v: number) => void;
  onRotateChange: (v: number) => void;
  onDampingChange: (d: number) => void;
  onTextSizeChange: (size: 'normal' | 'large') => void;
  onAddMolecule: () => void;
  onClear: () => void;
  onResetView: () => void;
}

/** Imperative callbacks registered by main.ts, invoked by React StructureChooser. */
export interface ChooserCallbacks {
  onSelectStructure: (file: string, description: string) => void;
}

/** Imperative callbacks for the timeline bar, registered by main.ts. */
export interface TimelineCallbacks {
  onScrub: (timePs: number) => void;
  onReturnToLive: () => void;
  onRestartFromHere: () => void;
  onStartRecordingNow: () => void;
  onTurnRecordingOff: () => void;
}

/** Imperative callbacks for the bonded-group panel, registered by main.ts. */
export interface BondedGroupCallbacks {
  onToggleSelect: (id: string) => void;
  onHover: (id: string | null) => void;
  onClearHighlight: () => void;
  onCenterGroup?: (id: string) => void;
  onFollowGroup?: (id: string) => void;
  /** Apply a color to all atoms in the given bonded group (stores intent + immediate override). */
  onApplyGroupColor?: (id: string, colorHex: string) => void;
  /** Remove the color override and intent for the given bonded group. */
  onClearGroupColor?: (id: string) => void;
  /** Read-only: returns atom indices for a group (used by color editor to detect current color). */
  getGroupAtoms?: (id: string) => number[] | null;
}

/** Atom color value for authored appearance overrides. */
export interface AtomColorValue {
  hex: string;
}

/** Map of atom index → color override. Authored by the user, separate from transient highlight. */
export type AtomColorOverrideMap = Record<number, AtomColorValue>;

/** Summary of a bonded connected component — projected from physics topology, not scene metadata.
 *  id: stable topology identity (survives merge/split via overlap reconciliation)
 *  displayIndex: 1-based visible index after sorting (for UI labels and future selection)
 *  atomCount: number of atoms in this cluster
 *  minAtomIndex: lowest atom index (deterministic fallback sort key)
 *  orderKey: internal reconciliation key (not user-facing — use displayIndex for UI)
 */
export interface BondedGroupSummary {
  id: string;
  displayIndex: number;
  atomCount: number;
  minAtomIndex: number;
  orderKey: number;
}

export interface AppStore {
  // UI chrome state
  theme: 'dark' | 'light';
  textSize: 'normal' | 'large';
  activeSheet: 'settings' | 'chooser' | null;
  interactionMode: 'atom' | 'move' | 'rotate';

  // Camera mode (store is sole authority — renderer/input are consumers only)
  cameraMode: 'orbit' | 'freelook';
  setCameraMode: (mode: 'orbit' | 'freelook') => void;

  // Orbit follow mode: camera target tracks the focused molecule continuously.
  // Toggled via Follow button. Direct toggle, no long-press discovery.
  orbitFollowEnabled: boolean;
  setOrbitFollowEnabled: (enabled: boolean) => void;

  // Onboarding overlay (page-load welcome card, page-lifetime dismissal)
  // onboardingVisible is derived from onboardingPhase — use setOnboardingPhase only.
  onboardingVisible: boolean;
  onboardingPhase: 'visible' | 'exiting' | 'dismissed';
  setOnboardingPhase: (phase: 'visible' | 'exiting' | 'dismissed') => void;

  // Camera control callbacks (registered by main.ts, consumed by CameraControls for Free-Look)
  // Center/Follow moved to BondedGroupCallbacks (Phase 10 legacy cleanup)
  cameraCallbacks: { onReturnToObject?: () => void; onFreeze?: () => void } | null;
  setCameraCallbacks: (cbs: { onReturnToObject?: () => void; onFreeze?: () => void }) => void;

  // Focus handle for camera pivot (validated before use — molecule may be removed)
  // TODO: Remove lastFocusedMoleculeId once focus-runtime.ts and orbit-follow-update.ts
  // migrate to cameraTargetRef exclusively. Bonded-group Center/Follow and CameraControls
  // cleanup are complete — this is the last legacy fallback path.
  lastFocusedMoleculeId: number | null;
  setLastFocusedMoleculeId: (id: number | null) => void;
  /** Generic camera target — replaces molecule-only lastFocusedMoleculeId for new paths. */
  cameraTargetRef: CameraTargetRef | null;
  setCameraTargetRef: (ref: CameraTargetRef | null) => void;
  /** Persistent follow target — frozen atom set that survives topology changes. */
  orbitFollowTargetRef: FollowTargetRef | null;
  setOrbitFollowTargetRef: (ref: FollowTargetRef | null) => void;

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

  // Free-Look flight state (derived from renderer, transition-gated)
  flightActive: boolean;
  farDrift: boolean;

  // Bonded groups (physics-topology-derived, separate from scene molecules)
  // Highlight contract:
  //   - selectedBondedGroupId: selected row in the live cluster list
  //   - hasTrackedBondedHighlight: true when frozen atom set exists (atoms owned by runtime, not store)
  //   - hoveredBondedGroupId: transient hover preview (always live membership)
  //   - Renderer authority: tracked atoms first, hover second, else none
  //   - Tracked atoms persist even if the original group disappears from the list
  bondedGroups: BondedGroupSummary[];
  bondedGroupsExpanded: boolean;
  bondedSmallGroupsExpanded: boolean;
  bondedGroupsSide: 'left' | 'right';
  selectedBondedGroupId: string | null;
  hoveredBondedGroupId: string | null;
  hasTrackedBondedHighlight: boolean;
  /** Which group's color editor popover is open (null = closed).
   *  Cleared automatically by setBondedGroups when the open group disappears
   *  from the projected topology (e.g. after a merge or split). */
  colorEditorOpenForGroupId: string | null;
  setBondedGroups: (groups: BondedGroupSummary[]) => void;
  toggleBondedGroupsExpanded: () => void;
  toggleBondedSmallGroupsExpanded: () => void;
  setBondedGroupsSide: (side: 'left' | 'right') => void;
  setSelectedBondedGroup: (id: string | null) => void;
  setHoveredBondedGroup: (id: string | null) => void;
  setColorEditorOpenForGroupId: (id: string | null) => void;
  // hasTrackedBondedHighlight is read-only from the public interface.
  // Only bonded-group-highlight-runtime may write highlight state (via useAppStore.setState).
  // No public clear action — use highlight runtime's clearHighlight() instead.

  // Timeline
  timelineInstalled: boolean;
  timelineRecordingMode: 'off' | 'ready' | 'active';
  timelineMode: 'live' | 'review';
  timelineCurrentTimePs: number;
  timelineReviewTimePs: number | null;
  timelineRangePs: { start: number; end: number } | null;
  timelineCanReturnToLive: boolean;
  timelineCanRestart: boolean;
  /** The actual checkpoint time restart will use (null if no checkpoint available). */
  timelineRestartTargetPs: number | null;
  timelineCallbacks: TimelineCallbacks | null;
  setTimelineInstalled: (v: boolean) => void;
  setTimelineRecordingMode: (mode: 'off' | 'ready' | 'active') => void;
  setTimelineMode: (mode: 'live' | 'review') => void;
  setTimelineCurrentTimePs: (t: number) => void;
  setTimelineReviewTimePs: (t: number | null) => void;
  setTimelineRangePs: (range: { start: number; end: number } | null) => void;
  setTimelineCanReturnToLive: (v: boolean) => void;
  setTimelineCanRestart: (v: boolean) => void;
  setTimelineCallbacks: (cbs: TimelineCallbacks | null) => void;
  updateTimelineState: (state: {
    mode: 'live' | 'review';
    currentTimePs: number;
    reviewTimePs: number | null;
    rangePs: { start: number; end: number } | null;
    canReturnToLive: boolean;
    canRestart: boolean;
    restartTargetPs: number | null;
  }) => void;
  /** Atomic batch: install timeline UI in one store write (no intermediate states). */
  installTimelineUI: (callbacks: TimelineCallbacks, mode: 'off' | 'ready' | 'active') => void;
  /** Atomic batch: uninstall timeline UI in one store write. */
  uninstallTimelineUI: () => void;

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
  setFlightActive: (active: boolean) => void;
  setFarDrift: (drift: boolean) => void;
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
  bondedGroupCallbacks: BondedGroupCallbacks | null;
  setBondedGroupCallbacks: (cbs: BondedGroupCallbacks | null) => void;
  /** Authored atom color overrides — global annotations (persist across live/review). */
  bondedGroupColorOverrides: AtomColorOverrideMap;
  setBondedGroupColorOverrides: (overrides: AtomColorOverrideMap) => void;
  clearBondedGroupColorOverrides: () => void;

  // Lifecycle
  resetTransientState: () => void;
}

export const useAppStore = create<AppStore>((set) => ({
  // Initial state
  theme: DEFAULT_THEME,
  textSize: 'normal',
  activeSheet: null,
  interactionMode: 'atom',
  cameraMode: 'orbit',
  orbitFollowEnabled: false,
  onboardingVisible: false,
  onboardingPhase: 'dismissed' as const,
  cameraCallbacks: null,
  lastFocusedMoleculeId: null,
  cameraTargetRef: null,
  orbitFollowTargetRef: null,
  bondedGroups: [],
  bondedGroupsExpanded: false,
  bondedSmallGroupsExpanded: false,
  bondedGroupsSide: 'right',
  selectedBondedGroupId: null,
  hoveredBondedGroupId: null,
  hasTrackedBondedHighlight: false,
  colorEditorOpenForGroupId: null,
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
  flightActive: false,
  farDrift: false,
  timelineInstalled: false,
  timelineRecordingMode: 'off' as const,
  timelineMode: 'live',
  timelineCurrentTimePs: 0,
  timelineReviewTimePs: null,
  timelineRangePs: null,
  timelineCanReturnToLive: false,
  timelineCanRestart: false,
  timelineRestartTargetPs: null,
  timelineCallbacks: null,
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
  bondedGroupCallbacks: null,
  bondedGroupColorOverrides: {},

  // Actions
  setTheme: (theme) => set({ theme }),
  setTextSize: (size) => set({ textSize: size }),
  openSheet: (sheet) => set({ activeSheet: sheet }),
  closeSheet: () => set({ activeSheet: null }),
  setInteractionMode: (mode) => set({ interactionMode: mode }),
  setCameraMode: (mode) => {
    // Guard: reject Free-Look when feature flag is off
    if (mode === 'freelook' && !CONFIG.camera.freeLookEnabled) return;
    set({ cameraMode: mode });
  },
  setOrbitFollowEnabled: (enabled) => set({ orbitFollowEnabled: enabled }),
  setOnboardingPhase: (phase) => set({
    onboardingPhase: phase,
    onboardingVisible: phase !== 'dismissed',
  }),
  setCameraCallbacks: (cbs) => set({ cameraCallbacks: cbs }),
  setLastFocusedMoleculeId: (id) => set({ lastFocusedMoleculeId: id }),
  setCameraTargetRef: (ref) => set({ cameraTargetRef: ref }),
  setOrbitFollowTargetRef: (ref) => set({ orbitFollowTargetRef: ref }),
  setTargetSpeed: (speed) => set({ targetSpeed: speed }),
  togglePause: () => set((s) => ({ paused: !s.paused })),

  setBondedGroups: (groups) => set((s) => {
    const openId = s.colorEditorOpenForGroupId;
    return {
      bondedGroups: groups,
      colorEditorOpenForGroupId: openId && groups.some(g => g.id === openId) ? openId : null,
    };
  }),
  toggleBondedGroupsExpanded: () => set((s) => ({ bondedGroupsExpanded: !s.bondedGroupsExpanded })),
  toggleBondedSmallGroupsExpanded: () => set((s) => ({ bondedSmallGroupsExpanded: !s.bondedSmallGroupsExpanded })),
  setBondedGroupsSide: (side) => set({ bondedGroupsSide: side }),
  setSelectedBondedGroup: (id) => set({ selectedBondedGroupId: id }),
  setHoveredBondedGroup: (id) => set({ hoveredBondedGroupId: id }),
  setColorEditorOpenForGroupId: (id) => set({ colorEditorOpenForGroupId: id }),
  // clearBondedGroupHighlightState removed — highlight runtime owns the full clear path via useAppStore.setState()

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
  setTimelineInstalled: (v) => set({ timelineInstalled: v }),
  setTimelineRecordingMode: (mode) => set({ timelineRecordingMode: mode }),
  setTimelineMode: (mode) => set({ timelineMode: mode }),
  setTimelineCurrentTimePs: (t) => set({ timelineCurrentTimePs: t }),
  setTimelineReviewTimePs: (t) => set({ timelineReviewTimePs: t }),
  setTimelineRangePs: (range) => set({ timelineRangePs: range }),
  setTimelineCanReturnToLive: (v) => set({ timelineCanReturnToLive: v }),
  setTimelineCanRestart: (v) => set({ timelineCanRestart: v }),
  setTimelineCallbacks: (cbs) => set({ timelineCallbacks: cbs }),
  updateTimelineState: (state) => set({
    timelineMode: state.mode,
    timelineCurrentTimePs: state.currentTimePs,
    timelineReviewTimePs: state.reviewTimePs,
    timelineRangePs: state.rangePs,
    timelineCanReturnToLive: state.canReturnToLive,
    timelineCanRestart: state.canRestart,
    timelineRestartTargetPs: state.restartTargetPs,
  }),
  installTimelineUI: (callbacks, mode) => set({
    timelineCallbacks: callbacks,
    timelineRecordingMode: mode,
    timelineInstalled: true,
  }),
  uninstallTimelineUI: () => set({
    timelineCallbacks: null,
    timelineInstalled: false,
    timelineRecordingMode: 'off' as const,
    timelineMode: 'live',
    timelineCurrentTimePs: 0,
    timelineReviewTimePs: null,
    timelineRangePs: null,
    timelineCanReturnToLive: false,
    timelineCanRestart: false,
    timelineRestartTargetPs: null,
  }),
  setFlightActive: (active) => set({ flightActive: active }),
  setFarDrift: (drift) => set({ farDrift: drift }),
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
  setBondedGroupCallbacks: (cbs) => set({ bondedGroupCallbacks: cbs }),
  setBondedGroupColorOverrides: (overrides) => set({ bondedGroupColorOverrides: overrides }),
  clearBondedGroupColorOverrides: () => set({ bondedGroupColorOverrides: {} }),

  resetTransientState: () => set({
    // Callbacks
    closeOverlay: null,
    dockCallbacks: null,
    settingsCallbacks: null,
    chooserCallbacks: null,
    bondedGroupCallbacks: null,
    bondedGroupColorOverrides: {},
    // UI chrome
    activeSheet: null,
    helpPageActive: false,
    recentStructure: null,
    interactionMode: 'atom',
    cameraMode: 'orbit',
    orbitFollowEnabled: false,
    onboardingVisible: false,
    onboardingPhase: 'dismissed' as const,
    cameraCallbacks: null,
    lastFocusedMoleculeId: null,
    cameraTargetRef: null,
    orbitFollowTargetRef: null,
    // Bonded groups (side preference preserved across reset)
    bondedGroups: [],
    bondedGroupsExpanded: false,
    bondedSmallGroupsExpanded: false,
    selectedBondedGroupId: null,
    hoveredBondedGroupId: null,
    hasTrackedBondedHighlight: false,
    colorEditorOpenForGroupId: null,
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
    // Flight
    flightActive: false,
    farDrift: false,
    // Timeline
    timelineInstalled: false,
    timelineRecordingMode: 'off' as const,
    timelineMode: 'live',
    timelineCurrentTimePs: 0,
    timelineReviewTimePs: null,
    timelineRangePs: null,
    timelineCanReturnToLive: false,
    timelineCanRestart: false,
    timelineRestartTargetPs: null,
    timelineCallbacks: null,
    // Debug
    reconciliationState: 'none',
    // Status channels
    statusText: null,
    statusError: null,
  }),
}));
