/**
 * FPS / status display formatter.
 *
 * Pure display helper — reads timing data from the scheduler in main.js.
 * Does NOT perform independent timing. The scheduler is the sole source
 * of truth for all profiler and cadence measurements.
 */

export class FPSMonitor {
  displayEl: HTMLElement;

  constructor(displayElement: HTMLElement) {
    this.displayEl = displayElement;
  }
}
