/**
 * Watch renderer adapter — narrow API surface over the lab Renderer.
 *
 * Shields watch/ code from the 2500+ line lab renderer surface.
 * Only exposes the methods watch/ needs for review-frame display.
 */

import { Renderer } from '../../lab/js/renderer';

export interface WatchRenderer {
  getCanvas(): HTMLCanvasElement;
  applyTheme(name: string): void;
  /** Initialize atom/bond mesh capacity for playback. Must be called before updateReviewFrame. */
  initForPlayback(maxAtomCount: number): void;
  updateReviewFrame(positions: Float64Array, n: number, bonds: [number, number, number][]): void;
  fitCamera(): void;
  render(): void;
  destroy(): void;
  // Note: resize is handled automatically by the Renderer's internal window.resize listener.
}

export function createWatchRenderer(container: HTMLElement): WatchRenderer {
  const renderer = new Renderer(container);

  return {
    getCanvas: () => renderer.getCanvas(),
    applyTheme: (name: string) => renderer.applyTheme(name),
    initForPlayback(maxAtomCount: number) {
      // Reset mesh state from any prior file, then create capacity for the new file.
      // clearAllMeshes resets _atomCount to 0 so ensureCapacityForAppend computes correctly.
      renderer.clearAllMeshes();
      renderer.ensureCapacityForAppend(maxAtomCount);
    },
    updateReviewFrame: (positions, n, bonds) => renderer.updateReviewFrame(positions, n, bonds),
    fitCamera: () => renderer.fitCamera(),
    render: () => renderer.render(),
    destroy: () => renderer.destroy(),
  };
}
