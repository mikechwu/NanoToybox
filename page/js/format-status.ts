/**
 * Shared status text formatter — single source of truth for FPS/status display.
 *
 * Used by both the imperative fpsMonitor path (main.ts) and the React
 * FPSDisplay component. This eliminates formatting drift between the
 * two surfaces during the D.1 migration.
 */

export interface StatusInputs {
  workerStalled: boolean;
  paused: boolean;
  placementActive: boolean;
  placementStale: boolean;
  warmUpComplete: boolean;
  overloaded: boolean;
  effectiveSpeed: number;
  fps: number;
  rafIntervalMs: number;
  /** Base steps per second (CONFIG.playback.baseStepsPerSecond) */
  baseStepsPerSecond: number;
  /** Physics timestep (CONFIG.physics.dt) */
  dt: number;
  /** Compact mode (narrow viewport) */
  compact: boolean;
}

/** Format the FPS/status display text from the given inputs. */
export function formatStatusText(inputs: StatusInputs): string {
  const { workerStalled, paused, placementActive, placementStale, warmUpComplete, overloaded,
    effectiveSpeed, fps, rafIntervalMs, baseStepsPerSecond, dt, compact } = inputs;

  const detail = `${rafIntervalMs.toFixed(1)} ms · ${fps} fps`;
  const showDetail = !compact;
  const mdRate = effectiveSpeed * baseStepsPerSecond * dt / 1000;

  if (workerStalled) {
    return 'Simulation stalled...';
  }
  if (paused) {
    return showDetail ? `Paused · ${detail}` : 'Paused · 0 ps/s';
  }
  if (placementActive) {
    if (placementStale) return 'Simulation catching up...';
    return showDetail ? `Placing... · ${detail}` : 'Placing...';
  }
  if (!warmUpComplete) {
    return 'Estimating...';
  }
  if (overloaded) {
    return showDetail
      ? `Hardware-limited · Sim ${effectiveSpeed.toFixed(1)}x · ${mdRate.toFixed(2)} ps/s · ${detail}`
      : `Hardware-limited · Sim ${effectiveSpeed.toFixed(1)}x · ${mdRate.toFixed(2)} ps/s`;
  }
  return showDetail
    ? `Sim ${effectiveSpeed.toFixed(1)}x · ${mdRate.toFixed(2)} ps/s · ${detail}`
    : `Sim ${effectiveSpeed.toFixed(1)}x · ${mdRate.toFixed(2)} ps/s`;
}
