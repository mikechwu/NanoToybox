/**
 * FPS & frame time monitor.
 *
 * Measures ACTUAL frame computation time (not just vsync rate).
 * requestAnimationFrame always fires at display refresh (60/120 Hz),
 * so counting frames gives a misleading 60fps even if computation
 * takes 50ms. Instead, we measure physics+render time directly.
 */

export class FPSMonitor {
  constructor(displayElement) {
    this.displayEl = displayElement;
    this.frameTimes = [];
    this.windowSize = 30;
    this.frameStart = 0;
  }

  /** Call at the START of the frame loop */
  begin() {
    this.frameStart = performance.now();
  }

  /** Call at the END of the frame loop */
  end() {
    const elapsed = performance.now() - this.frameStart;
    this.frameTimes.push(elapsed);
    if (this.frameTimes.length > this.windowSize) this.frameTimes.shift();

    if (this.displayEl && this.frameTimes.length > 0) {
      const avgMs = this.frameTimes.reduce((a, b) => a + b, 0) / this.frameTimes.length;
      const effectiveFps = Math.min(1000 / avgMs, 60);
      this.displayEl.textContent = `${avgMs.toFixed(1)} ms · ${Math.round(effectiveFps)} fps`;
    }
  }

  /** Average frame time in ms */
  getFrameTime() {
    if (this.frameTimes.length === 0) return 0;
    return this.frameTimes.reduce((a, b) => a + b, 0) / this.frameTimes.length;
  }

  /** Effective FPS (capped at display refresh) */
  getFPS() {
    const ms = this.getFrameTime();
    return ms > 0 ? Math.min(1000 / ms, 60) : 60;
  }

  getDegradationLevel() {
    const ms = this.getFrameTime();
    if (ms < 20) return 0;   // < 20ms = comfortable
    if (ms < 50) return 1;   // 20-50ms = degraded
    return 2;                 // > 50ms = critical
  }
}
