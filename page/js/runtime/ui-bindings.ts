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
 * Does NOT attach global listeners or write to window.
 */

import { useAppStore } from '../store/app-store';
import type { OverlayRuntime } from './overlay-runtime';
import type { WorkerInteractionCommand } from '../worker-bridge';

export interface UIBindingsDeps {
  // Overlay
  overlayRuntime: OverlayRuntime;

  // Playback commands
  togglePause: () => void;
  changeSpeed: (val: string) => void;
  setInteractionMode: (mode: string) => void;
  forceRenderThisTick: () => void;

  // Scene commands
  clearPlayground: () => void;
  resetView: () => void;
  updateChooserRecentRow: () => void;

  // Physics settings
  setPhysicsWallMode: (mode: string) => void;
  setPhysicsDragStrength: (v: number) => void;
  setPhysicsRotateStrength: (v: number) => void;
  setPhysicsDamping: (d: number) => void;

  // Theme/text
  applyTheme: (theme: string) => void;
  applyTextSize: (size: string) => void;

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
      if (deps.isPlacementActive()) { deps.exitPlacement(true); return; }
      deps.updateChooserRecentRow();
      deps.overlayRuntime.open('chooser');
    },
    onPause: () => {
      if (deps.isPlacementActive()) return;
      deps.togglePause();
    },
    onSettings: () => {
      if (deps.isPlacementActive()) return;
      deps.overlayRuntime.open('settings');
    },
    onCancel: () => deps.exitPlacement(false),
    onModeChange: (mode: string) => {
      deps.setInteractionMode(mode);
    },
  });

  store.setSettingsCallbacks({
    onSpeedChange: (val: string) => {
      deps.changeSpeed(val);
      deps.forceRenderThisTick();
    },
    onThemeChange: (theme: string) => {
      deps.applyTheme(theme);
    },
    onBoundaryChange: (mode: string) => {
      deps.setPhysicsWallMode(mode);
      useAppStore.getState().setBoundaryMode(mode as 'contain' | 'remove');
      if (deps.isWorkerActive()) {
        deps.sendWorkerInteraction({ type: 'setWallMode', mode: mode as 'contain' | 'remove' });
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
      const sliderVal = d === 0 ? 0 : Math.round(Math.cbrt(2 * d) * 100);
      useAppStore.getState().setDampingSliderValue(sliderVal);
      if (deps.isWorkerActive()) {
        deps.sendWorkerInteraction({ type: 'setDamping', value: d });
      }
    },
    onTextSizeChange: (size: string) => {
      deps.applyTextSize(size);
    },
    onAddMolecule: () => {
      deps.updateChooserRecentRow();
      deps.overlayRuntime.open('chooser');
    },
    onClear: () => {
      deps.overlayRuntime.close();
      deps.clearPlayground();
    },
    onResetView: () => { deps.resetView(); },
  });

  store.setChooserCallbacks({
    onSelectStructure: (file: string, description: string) => {
      useAppStore.getState().setRecentStructure({ file, name: description });
      deps.startPlacement(file, description);
    },
  });
}
