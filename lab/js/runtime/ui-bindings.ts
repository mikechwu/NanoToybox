/**
 * UI bindings — registers store callbacks that React components invoke.
 *
 * Translates store-invoked intents into composition-root commands using
 * narrow command functions. Does NOT hold broad state bags like getSession()
 * or getScheduler().
 *
 * Initialization order invariant: registerStoreCallbacks() must run during
 * init() immediately after subsystem creation and before the app becomes
 * user-interactive. React components must remain null-safe for callback
 * slots via optional chaining (dockCallbacks?.onAdd()).
 *
 * Owns:        registerStoreCallbacks() — one-shot wiring of dock, settings,
 *              chooser, and overlay callback slots on the Zustand store.
 * Depends on:  app-store (setDockCallbacks, setSettingsCallbacks, etc.),
 *              OverlayRuntime (open/close overlays), WorkerBridge (forwarding
 *              interaction commands to worker).
 * Called by:   main.ts (called once during init, after subsystems are created).
 *              Tests: store-callbacks-arming.test.ts.
 * Teardown:    none — callbacks are replaced on next registerStoreCallbacks()
 *              call. Does not attach global listeners or write to window.
 */

import { useAppStore } from '../store/app-store';
import { dampingToSliderValue } from '../../../src/ui/damping-slider';
import { selectIsReviewLocked } from '../store/selectors/review-ui-lock';
import { showReviewModeActionHint } from './overlay/review-mode-action-hints';
import type { OverlayRuntime } from './overlay/overlay-runtime';
import type { WorkerInteractionCommand } from '../worker-bridge';

/** Returns true (and shows hint) if review mode blocks the action.
 *  Uses selectIsReviewLocked for centralized policy. */
function blockIfReviewLocked(): boolean {
  if (selectIsReviewLocked(useAppStore.getState())) {
    showReviewModeActionHint();
    return true;
  }
  return false;
}

export interface UIBindingsDeps {
  // Overlay
  overlayRuntime: OverlayRuntime;

  // Playback commands
  togglePause: () => void;
  changeSpeed: (val: '0.5' | '1' | '2' | '4' | 'max') => void;
  setInteractionMode: (mode: 'atom' | 'move' | 'rotate') => void;
  forceRenderThisTick: () => void;

  // Scene commands
  clearPlayground: () => void | Promise<void>;
  resetView: () => void;
  updateChooserRecentRow: () => void;

  // Physics settings
  setPhysicsWallMode: (mode: 'contain' | 'remove') => void;
  setPhysicsDragStrength: (v: number) => void;
  setPhysicsRotateStrength: (v: number) => void;
  setPhysicsDamping: (d: number) => void;

  // Theme/text
  applyTheme: (theme: 'dark' | 'light') => void;
  applyTextSize: (size: 'normal' | 'large') => void;

  // Worker forwarding
  isWorkerActive: () => boolean;
  sendWorkerInteraction: (cmd: WorkerInteractionCommand) => void;

  // Placement (narrow commands, not state bag)
  isPlacementActive: () => boolean;
  exitPlacement: (commit: boolean) => void;
  startPlacement: (file: string, description: string) => void;
}

export function registerStoreCallbacks(deps: UIBindingsDeps): void {
  const store = useAppStore.getState();

  store.setCloseOverlay(() => deps.overlayRuntime.close());

  store.setDockCallbacks({
    onAdd: () => {
      if (blockIfReviewLocked()) return;
      if (deps.isPlacementActive()) { deps.exitPlacement(true); return; }
      deps.updateChooserRecentRow();
      deps.overlayRuntime.open('chooser');
    },
    onPause: () => {
      if (blockIfReviewLocked()) return;
      if (deps.isPlacementActive()) return;
      deps.togglePause();
    },
    onSettings: () => {
      if (deps.isPlacementActive()) return;
      deps.overlayRuntime.open('settings');
    },
    onCancel: () => deps.exitPlacement(false),
    onModeChange: (mode) => {
      if (blockIfReviewLocked()) return;
      deps.setInteractionMode(mode);
    },
  });

  store.setSettingsCallbacks({
    onSpeedChange: (val) => {
      deps.changeSpeed(val);
      deps.forceRenderThisTick();
    },
    onThemeChange: (theme) => {
      deps.applyTheme(theme);
    },
    onBoundaryChange: (mode) => {
      deps.setPhysicsWallMode(mode);
      useAppStore.getState().setBoundaryMode(mode);
      if (deps.isWorkerActive()) {
        deps.sendWorkerInteraction({ type: 'setWallMode', mode });
      }
    },
    onDragChange: (v: number) => {
      deps.setPhysicsDragStrength(v);
      useAppStore.getState().setDragStrength(v);
      if (deps.isWorkerActive()) {
        deps.sendWorkerInteraction({ type: 'setDragStrength', value: v });
      }
    },
    onRotateChange: (v: number) => {
      deps.setPhysicsRotateStrength(v);
      useAppStore.getState().setRotateStrength(v);
      if (deps.isWorkerActive()) {
        deps.sendWorkerInteraction({ type: 'setRotateStrength', value: v });
      }
    },
    onDampingChange: (d: number) => {
      deps.setPhysicsDamping(d);
      useAppStore.getState().setDampingSliderValue(dampingToSliderValue(d));
      if (deps.isWorkerActive()) {
        deps.sendWorkerInteraction({ type: 'setDamping', value: d });
      }
    },
    onTextSizeChange: (size) => {
      deps.applyTextSize(size);
    },
    onAddMolecule: () => {
      if (blockIfReviewLocked()) return;
      deps.updateChooserRecentRow();
      deps.overlayRuntime.open('chooser');
    },
    onClear: () => {
      if (blockIfReviewLocked()) return;
      deps.overlayRuntime.close();
      void Promise.resolve(deps.clearPlayground()).catch((e) => {
        console.error('[ui] clear failed:', e);
        useAppStore.getState().setStatusText('Clear failed');
        setTimeout(() => { if (useAppStore.getState().statusText === 'Clear failed') useAppStore.getState().setStatusText(null); }, 3000);
      });
    },
    onResetView: () => { deps.resetView(); },
  });

  store.setChooserCallbacks({
    onSelectStructure: (file: string, description: string) => {
      if (blockIfReviewLocked()) return;
      useAppStore.getState().setRecentStructure({ file, name: description });
      deps.startPlacement(file, description);
    },
  });
}
