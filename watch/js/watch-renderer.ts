/**
 * Watch renderer adapter — narrow API surface over the lab Renderer.
 *
 * Round 2 additions: highlight methods + camera target methods.
 * Shields watch/ code from the 2500+ line lab renderer surface.
 */

import { Renderer } from '../../lab/js/renderer';
import * as THREE from 'three';
import type { CameraInteractionPhase } from '../../src/camera/camera-interaction-gate';
import type { WatchLabOrbitCamera } from '../../src/watch-lab-handoff/watch-lab-handoff-shared';

export interface FramedTarget {
  center: [number, number, number];
  radius: number;
}

export interface WatchRenderer {
  getCanvas(): HTMLCanvasElement;
  applyTheme(name: string): void;
  /** Initialize atom/bond mesh capacity for playback. Must be called before updateReviewFrame. */
  initForPlayback(maxAtomCount: number): void;
  /**
   * Update displayed atom positions and bond topology for the current review frame.
   *
   * **Buffer ownership contract:** the underlying renderer retains the `positions`
   * buffer by reference for display-aware queries (getDisplayedAtomWorldPosition,
   * centroid/bounds calculations used by follow and highlight). The caller must NOT
   * mutate the buffer after this call — its contents must remain valid until the
   * next updateReviewFrame() call replaces the reference.
   */
  updateReviewFrame(positions: Float64Array, n: number, bonds: [number, number, number][]): void;
  fitCamera(): void;
  render(): void;
  destroy(): void;

  // ── Round 2: highlight ──
  setGroupHighlight(atomIndices: number[] | null, intensity: 'selected' | 'hover'): void;
  clearGroupHighlight(): void;

  // ── Round 2: target resolution ──
  getDisplayedAtomWorldPosition(index: number): [number, number, number] | null;
  getSceneRadius(): number;

  // ── Round 2: camera actions ──
  animateToFramedTarget(target: FramedTarget): void;
  updateOrbitFollow(dtMs: number, target: FramedTarget): void;

  // ── Cinematic camera: orientation-preserving framing ──
  /**
   * Smoothly translates the orbit target to `target.center` and
   * dollies along the current view direction to frame `target.radius`
   * — never rotates. `opts` mirrors the underlying renderer's
   * smoothing knobs (targetSmoothing, distanceGrowSmoothing,
   * distanceShrinkSmoothing, allowDistanceShrink).
   */
  updateCinematicFraming(
    dtMs: number,
    target: FramedTarget,
    opts?: {
      targetSmoothing?: number;
      distanceGrowSmoothing?: number;
      distanceShrinkSmoothing?: number;
      allowDistanceShrink?: boolean;
    },
  ): void;

  /**
   * Subscribe to user-driven camera interactions. Listener receives
   * the gesture phase ('start' | 'change' | 'end') so the cinematic
   * service can distinguish a still-held gesture from a released
   * one. Returns a disposer.
   */
  onCameraInteraction(listener: (phase: CameraInteractionPhase) => void): () => void;

  // ── Round 3: triad interaction + orbit ──
  /** Check if a screen point is inside the triad hit rect (touch tolerance included). */
  isInsideTriad(clientX: number, clientY: number): boolean;
  /** Apply an orbit rotation delta (uses shared orbit-math.ts internally). */
  applyOrbitDelta(dx: number, dy: number): void;
  /** Find the nearest triad axis endpoint for snap target. Null = center zone. */
  getNearestAxisEndpoint(clientX: number, clientY: number): [number, number, number] | null;
  /** Animate camera to look along a specific axis direction. */
  snapToAxis(axisDir: [number, number, number]): void;
  /** Animate camera to default front view (+Z). */
  animatedResetView(): void;
  /** Show/hide semi-transparent highlight sphere at a triad axis endpoint. */
  showAxisHighlight(axisDir: [number, number, number] | null): void;
  /** Brighten triad during active background orbit. */
  startBackgroundOrbitCue(): void;
  /** Restore triad brightness when background orbit ends. */
  endBackgroundOrbitCue(): void;
  /** Cancel any active camera animation (snap, center, follow-start). */
  cancelCameraAnimation(): void;

  // ── Round 3: triad layout ──
  /** Set triad size and position to match lab overlay layout formulas. */
  setOverlayLayout(layout: { triadSize: number; triadLeft: number; triadBottom: number }): void;

  // ── Round 4: authored atom color ──
  /** Apply per-atom color overrides or null to clear. Keys are dense slot indices. */
  setAtomColorOverrides(overrides: Record<number, { hex: string }> | null): void;

  /** Orbit-camera snapshot for Watch → Lab handoff. Reads live
   *  OrbitControls state (position + target + up + fov). Returns null
   *  if the renderer is detached. See `lab/js/renderer.ts` for the
   *  timing / cinematic-camera contract. */
  getOrbitCameraSnapshot(): WatchLabOrbitCamera | null;
}

export function createWatchRenderer(container: HTMLElement): WatchRenderer {
  const renderer = new Renderer(container);

  return {
    getCanvas: () => renderer.getCanvas(),
    applyTheme: (name: string) => renderer.applyTheme(name),
    initForPlayback(maxAtomCount: number) {
      renderer.clearAllMeshes();
      renderer.ensureCapacityForAppend(maxAtomCount);
    },
    updateReviewFrame: (positions, n, bonds) => renderer.updateReviewFrame(positions, n, bonds),
    fitCamera: () => renderer.fitCamera(),
    render: () => renderer.render(),
    destroy: () => renderer.destroy(),

    // Highlight
    setGroupHighlight(atomIndices, intensity) {
      renderer.setHighlightedAtoms(atomIndices, intensity);
    },
    clearGroupHighlight() {
      renderer.setHighlightedAtoms(null);
    },

    // Target resolution
    getDisplayedAtomWorldPosition(index: number): [number, number, number] | null {
      const v = renderer.getDisplayedAtomWorldPosition(index);
      return v ? [v.x, v.y, v.z] : null;
    },
    getSceneRadius: () => renderer.getSceneRadius(),

    // Round 3: triad interaction + orbit
    isInsideTriad: (clientX, clientY) => renderer.isInsideTriad(clientX, clientY),
    applyOrbitDelta: (dx, dy) => renderer.applyOrbitDelta(dx, dy),
    getNearestAxisEndpoint(clientX: number, clientY: number): [number, number, number] | null {
      const v = renderer.getNearestAxisEndpoint(clientX, clientY);
      return v ? [v.x, v.y, v.z] : null;
    },
    snapToAxis(axisDir: [number, number, number]) {
      renderer.snapToAxis(new THREE.Vector3(...axisDir));
    },
    animatedResetView: () => renderer.animatedResetView(),
    showAxisHighlight(axisDir: [number, number, number] | null) {
      renderer.showAxisHighlight(axisDir ? new THREE.Vector3(...axisDir) : null);
    },
    startBackgroundOrbitCue: () => renderer.startBackgroundOrbitCue(),
    endBackgroundOrbitCue: () => renderer.endBackgroundOrbitCue(),
    cancelCameraAnimation: () => renderer.cancelCameraAnimation(),

    // Triad layout
    setOverlayLayout: (layout) => renderer.setOverlayLayout(layout),

    // Authored atom color
    setAtomColorOverrides: (overrides) => renderer.setAtomColorOverrides(overrides),

    // Camera actions
    animateToFramedTarget(target: FramedTarget) {
      renderer.animateToFramedTarget({
        center: new THREE.Vector3(...target.center),
        radius: target.radius,
      });
    },
    updateOrbitFollow(dtMs: number, target: FramedTarget) {
      renderer.updateOrbitFollow(dtMs, {
        center: new THREE.Vector3(...target.center),
        radius: target.radius,
      });
    },

    updateCinematicFraming(dtMs, target, opts) {
      const center = { x: target.center[0], y: target.center[1], z: target.center[2] };
      const distance = renderer.computeFramingDistance(target.radius);
      renderer.updateOrientationPreservingFraming(dtMs, center, distance, opts);
    },

    onCameraInteraction: (listener) => renderer.onCameraInteraction(listener),

    getOrbitCameraSnapshot: () => renderer.getOrbitCameraSnapshot(),
  };
}
