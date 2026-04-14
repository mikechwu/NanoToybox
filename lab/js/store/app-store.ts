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

/** Imperative callbacks for the timeline bar, installed by the timeline subsystem. */
export interface TimelineCallbacks {
  onScrub: (timePs: number) => void;
  onReturnToLive: () => void;
  onEnterReview: () => void;
  onRestartFromHere: () => void;
  onStartRecordingNow: () => void;
  onTurnRecordingOff: () => void;
  onExportHistory?: (kind: 'full' | 'capsule') => Promise<'saved' | 'picker-cancelled'>;
  onPauseForExport?: () => boolean;
  onResumeFromExport?: () => void;
  getExportEstimates?: () => { capsule: string | null; full: string | null };
  onPublishCapsule?: () => Promise<{ shareCode: string; shareUrl: string }>;
}

/** Imperative callbacks for the bonded-group panel, registered by main.ts. */
export interface BondedGroupCallbacks {
  // ── Active shipped actions ──
  onHover: (id: string | null) => void;
  onCenterGroup?: (id: string) => void;
  onFollowGroup?: (id: string) => void;
  /** Apply a color to all atoms in the given bonded group (freezes atom set into assignment). */
  onApplyGroupColor?: (id: string, colorHex: string) => void;
  /** Remove the color assignment for the given bonded group. */
  onClearGroupColor?: (id: string) => void;
  /** Remove a specific color assignment by its unique id (survives source group disappearing).
   *  Wired in main.ts. UI surface deferred — use this seam for a future "authored colors"
   *  management affordance rather than inventing a second runtime path. */
  onClearColorAssignment?: (assignmentId: string) => void;
  /** Read-only: returns atom indices for a group (used by color editor to detect current color). */
  getGroupAtoms?: (id: string) => number[] | null;

  // ── Legacy-hidden: persistent tracked highlight (feature-gated off) ──
  // Retained for future re-enablement or full removal.
  // Next cleanup: group into trackedHighlightCallbacks?: { ... }
  onToggleSelect?: (id: string) => void;
  onClearHighlight?: () => void;
}

// Shared base type — canonical definition in src/appearance/bonded-group-color-assignments.ts
import type { AtomColorOverrideMap as _AtomColorOverrideMap } from '../../../src/appearance/bonded-group-color-assignments';
export type AtomColorOverrideMap = _AtomColorOverrideMap;

/** Frozen color assignment — captures the exact atom set at the time of coloring.
 *  atomIds is the canonical source of truth for rendering and export.
 *  atomIndices is an authoring-time snapshot for UI chip state — it is never
 *  mutated after creation and does not drive renderer or export behavior. */
export interface BondedGroupColorAssignment {
  id: string;
  /** Authoring-time dense slot snapshot. Historical only — does not drive rendering. */
  atomIndices: number[];
  /** Stable atom IDs captured at authoring time. Canonical for rendering and export. */
  atomIds: number[];
  colorHex: string;
  sourceGroupId: string;
}

/** Summary of a bonded connected component — projected from physics topology, not scene metadata.
 *  id: stable topology identity (survives merge/split via overlap reconciliation)
 *  displayIndex: 1-based visible index after sorting (for UI labels and future selection)
 *  atomCount: number of atoms in this cluster
 *  minAtomIndex: lowest atom index (deterministic fallback sort key)
 *  orderKey: internal reconciliation key (not user-facing — use displayIndex for UI)
 */
// Canonical type lives in src/history/bonded-group-projection.ts.
// Imported and re-exported here so existing lab consumers keep their import paths.
import type { BondedGroupSummary as _BondedGroupSummary } from '../../../src/history/bonded-group-projection';
export type BondedGroupSummary = _BondedGroupSummary;

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
  //   - selectedBondedGroupId: legacy-hidden — persistent selection (feature-gated off via canTrackBondedGroupHighlight)
  //   - hasTrackedBondedHighlight: legacy-hidden — true when frozen atom set exists (runtime-owned)
  //   - hoveredBondedGroupId: active — transient hover preview (always live membership)
  //   - Renderer authority: tracked atoms first, hover second, else none
  //   - Tracked highlight fields retained for future re-enablement or full removal
  bondedGroups: BondedGroupSummary[];
  /** Whether the bonded-groups panel is expanded. Defaults to true.
   *  Preserved across resetTransientState — user's collapse/expand choice survives resets. */
  bondedGroupsExpanded: boolean;
  bondedSmallGroupsExpanded: boolean;
  bondedGroupsSide: 'left' | 'right';
  /** Legacy-hidden: persistent selection (feature-gated off — see highlight contract above). */
  selectedBondedGroupId: string | null;
  hoveredBondedGroupId: string | null;
  /** Legacy-hidden: true when frozen atom set exists (runtime-owned, feature-gated off). */
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
  /** Export capability gate — null means export unavailable. Set only by timeline subsystem. */
  timelineExportCapabilities: { full: boolean; capsule: boolean } | null;
  /** Internal — write-authority is timeline subsystem only. Tests may call directly for lifecycle simulation. */
  setTimelineExportCapabilities: (caps: { full: boolean; capsule: boolean } | null) => void;
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
  installTimelineUI: (callbacks: TimelineCallbacks, mode: 'off' | 'ready' | 'active', exportCapabilities?: { full: boolean; capsule: boolean } | null) => void;
  /** Atomic batch: uninstall timeline UI in one store write. */
  uninstallTimelineUI: () => void;
  /** Atomic batch: reset timeline to off state without uninstalling (keeps callbacks). */
  publishTimelineOffState: () => void;
  /** Atomic batch: reset timeline to ready state without uninstalling (clears history + capabilities). */
  publishTimelineReadyState: () => void;

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
  /** Authored color assignments — frozen atom ownership, source of truth.
   *  Each assignment captures the exact atom set at click time.
   *  Topology changes never expand assignments.
   *
   *  WRITE AUTHORITY: the appearance runtime owns all color writes via
   *  writeAssignments / clearAllColors / clearGroupColor / clearColorAssignment.
   *  Raw useAppStore.setState({...}) should be limited to tests or internal
   *  runtime paths — Zustand's open store does not enforce this structurally,
   *  so this is a project convention, not a hard boundary. */
  bondedGroupColorAssignments: BondedGroupColorAssignment[];
  /** Derived atom-level overrides for rendering — rebuilt from assignments.
   *  Same write authority as above — no public store setter. */
  bondedGroupColorOverrides: AtomColorOverrideMap;

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
  bondedGroupsExpanded: true,
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
  timelineExportCapabilities: null,
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
  bondedGroupColorAssignments: [],
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
  setTimelineExportCapabilities: (caps) => set({ timelineExportCapabilities: caps }),
  updateTimelineState: (state) => set({
    timelineMode: state.mode,
    timelineCurrentTimePs: state.currentTimePs,
    timelineReviewTimePs: state.reviewTimePs,
    timelineRangePs: state.rangePs,
    timelineCanReturnToLive: state.canReturnToLive,
    timelineCanRestart: state.canRestart,
    timelineRestartTargetPs: state.restartTargetPs,
  }),
  installTimelineUI: (callbacks, mode, exportCapabilities) => set({
    timelineCallbacks: callbacks,
    timelineRecordingMode: mode,
    timelineInstalled: true,
    timelineExportCapabilities: exportCapabilities ?? null,
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
    timelineExportCapabilities: null,
  }),
  publishTimelineOffState: () => set({
    timelineRecordingMode: 'off' as const,
    timelineMode: 'live',
    timelineCurrentTimePs: 0,
    timelineReviewTimePs: null,
    timelineRangePs: null,
    timelineCanReturnToLive: false,
    timelineCanRestart: false,
    timelineRestartTargetPs: null,
    timelineExportCapabilities: null,
  }),
  publishTimelineReadyState: () => set({
    timelineRecordingMode: 'ready' as const,
    timelineMode: 'live',
    timelineCurrentTimePs: 0,
    timelineReviewTimePs: null,
    timelineRangePs: null,
    timelineCanReturnToLive: false,
    timelineCanRestart: false,
    timelineRestartTargetPs: null,
    // Note: timelineExportCapabilities intentionally NOT cleared here.
    // The subsystem is the sole owner of export capability in non-off states.
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
  resetTransientState: () => set({
    // Callbacks
    closeOverlay: null,
    dockCallbacks: null,
    settingsCallbacks: null,
    chooserCallbacks: null,
    bondedGroupCallbacks: null,
    bondedGroupColorAssignments: [],
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
    // Bonded groups (side + expanded preference preserved across reset)
    bondedGroups: [],
    // bondedGroupsExpanded intentionally NOT reset — user's collapse/expand choice survives resets.
    // bondedSmallGroupsExpanded IS reset because it is data-dependent (small clusters may not
    // exist after topology change, so collapsing the detail view is the safe default).
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
    timelineExportCapabilities: null,
    // Debug
    reconciliationState: 'none',
    // Status channels
    statusText: null,
    statusError: null,
  }),
}));
