/**
 * Watch renderer adapter — narrow API surface over the lab Renderer.
 *
 * Round 2 additions: highlight methods + camera target methods.
 * Shields watch/ code from the 2500+ line lab renderer surface.
 */

import { Renderer } from '../../lab/js/renderer';
import * as THREE from 'three';

export interface FramedTarget {
  center: [number, number, number];
  radius: number;
}

export interface WatchRenderer {
  getCanvas(): HTMLCanvasElement;
  applyTheme(name: string): void;
  /** Initialize atom/bond mesh capacity for playback. Must be called before updateReviewFrame. */
  initForPlayback(maxAtomCount: number): void;
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
  };
}
