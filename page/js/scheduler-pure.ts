/**
 * scheduler-pure.ts — Pure functions extracted from the frame-loop scheduler.
 *
 * Every function here is side-effect-free: no DOM, no `this`, no globals.
 *
 * Integration status:
 * - computeTargetSpeed      — WIRED into main.ts frameLoop
 * - computeSubstepCount     — WIRED into main.ts frameLoop
 * - updateOverloadState     — WIRED into main.ts frameLoop
 * - computeEffectiveSpeed   — WIRED into main.ts frameLoop
 * - shouldSkipRender        — WIRED into main.ts frameLoop
 * - computeMaxSpeed         — tested reference; runtime uses a more detailed estimator
 * - computeWallRadius       — tested reference; runtime uses physics.updateWallRadius()
 */

// ── 1. Substep count ────────────────────────────────────────────────

/**
 * How many physics substeps to run this frame.
 * Mirrors the `while (budget >= stepWall && count < max)` loop.
 */
export function computeSubstepCount(
  simBudgetMs: number,
  stepWallMs: number,
  maxSubsteps: number,
): number {
  if (stepWallMs <= 0) return 0;
  let count = 0;
  let budget = simBudgetMs;
  while (budget >= stepWallMs && count < maxSubsteps) {
    budget -= stepWallMs;
    count++;
  }
  return count;
}

// ── 2. Target speed ─────────────────────────────────────────────────

/**
 * Resolve the effective target speed for this frame.
 *
 * - `'max'` mode uses maxSpeed directly.
 * - Otherwise clamps selectedSpeed to maxSpeed.
 * - During warm-up, caps at 1.0x regardless.
 */
export function computeTargetSpeed(
  speedMode: string,
  selectedSpeed: number,
  maxSpeed: number,
  warmUpComplete: boolean,
): number {
  let target = speedMode === 'max'
    ? maxSpeed
    : Math.min(selectedSpeed, maxSpeed);
  if (!warmUpComplete) {
    target = Math.min(target, 1.0);
  }
  return target;
}

// ── 3. Overload FSM ─────────────────────────────────────────────────

export interface OverloadInput {
  mode: string;
  overloadCount: number;
  substepsThisFrame: number;
  maxSubsteps: number;
  entryTicks: number;
  exitTicks: number;
}

export interface OverloadState {
  mode: string;
  overloadCount: number;
}

/**
 * Advance the overload finite-state machine by one tick.
 *
 * States: `'normal'` -> `'overloaded'` -> `'recovering'` -> `'normal'`
 */
export function updateOverloadState(input: OverloadInput): OverloadState {
  let { mode, overloadCount } = input;
  const { substepsThisFrame, maxSubsteps, entryTicks, exitTicks } = input;

  // Update counter
  if (substepsThisFrame >= maxSubsteps) {
    overloadCount = Math.min(overloadCount + 1, 30);
  } else {
    overloadCount = Math.max(0, overloadCount - 1);
  }

  // Transitions
  if (mode === 'normal' && overloadCount >= entryTicks) {
    mode = 'overloaded';
  }
  if (mode === 'overloaded' && overloadCount < exitTicks) {
    mode = 'recovering';
  }
  if (mode === 'recovering') {
    if (overloadCount === 0) mode = 'normal';
    if (overloadCount >= entryTicks) mode = 'overloaded';
  }

  return { mode, overloadCount };
}

// ── 4. Effective speed (time-weighted sliding window) ───────────────

export interface SpeedSample {
  speed: number;
  dt: number;
}

/**
 * Compute the time-weighted effective speed from a sliding window of
 * per-frame samples. Longer frames carry proportionally more weight.
 *
 * Also returns the updated window (with the new sample pushed and
 * oldest evicted if over `maxWindowSize`).
 */
export function computeEffectiveSpeed(
  window: SpeedSample[],
  instantSpeed: number,
  frameDtMs: number,
  maxWindowSize: number,
): { effectiveSpeed: number; window: SpeedSample[] } {
  const updated = [...window, { speed: instantSpeed, dt: frameDtMs }];
  while (updated.length > maxWindowSize) updated.shift();

  let wSum = 0;
  let wTotal = 0;
  for (const s of updated) {
    wSum += s.speed * s.dt;
    wTotal += s.dt;
  }
  return {
    effectiveSpeed: wTotal > 0 ? wSum / wTotal : 0,
    window: updated,
  };
}

// ── 5. Render-skip decision ─────────────────────────────────────────

/**
 * Returns `true` when physics work has consumed enough of the frame
 * budget that a render skip is warranted.
 *
 * Mirrors the `canRender` heuristic:
 *   `(rafInterval - usedMs) >= renderMs * 0.8`
 */
export function shouldSkipRender(
  physMs: number,
  renderMs: number,
  frameBudgetMs: number,
): boolean {
  const headroom = frameBudgetMs - physMs;
  return headroom < renderMs * 0.8;
}

// ── 6. Max-speed estimator ──────────────────────────────────────────

/**
 * Derive the sustainable max speed multiplier from profiling data.
 *
 * Uses the budget-based formula from the normal/recovering path:
 *   physicsBudget = budgetPerSec - renderBudget - updateBudget - otherBudget
 *   maxSteps = physicsBudget / physStepMs
 *   maxSpeed = maxSteps / baseStepsPerSecond
 *
 * This simplified variant takes pre-computed per-frame costs and derives
 * max speed without depending on the full profiler state.
 */
export function computeMaxSpeed(
  physStepMs: number,
  renderMs: number,
  rafIntervalMs: number,
  stepsPerFrame: number,
): number {
  if (rafIntervalMs <= 0 || physStepMs <= 0) return 0;
  // Available time per frame after rendering
  const availableMs = rafIntervalMs - renderMs;
  if (availableMs <= 0) return 0;
  // How many steps fit in the available time
  const maxStepsPerFrame = availableMs / physStepMs;
  // Convert to speed multiplier: actual steps per second / base steps per second
  const framesPerSec = 1000 / rafIntervalMs;
  const maxStepsPerSec = maxStepsPerFrame * framesPerSec;
  // baseStepsPerSecond = 240 canonically, but we parameterize via stepsPerFrame
  // to keep this function independent of CONFIG.
  // stepsPerFrame at 1x speed * framesPerSec = baseStepsPerSecond
  const baseStepsPerSec = stepsPerFrame * framesPerSec;
  return baseStepsPerSec > 0 ? maxStepsPerSec / baseStepsPerSec : 0;
}

// ── 7. Wall radius ──────────────────────────────────────────────────

/**
 * Compute the containment-wall radius from atom count and target density.
 *
 *   R = cbrt(3N / (4 pi density)) + padding
 *
 * Returns 0 for 0 atoms.
 */
export function computeWallRadius(
  atomCount: number,
  density: number,
  padding: number,
): number {
  if (atomCount <= 0 || density <= 0) return 0;
  const densityRadius = Math.cbrt((3 * atomCount) / (4 * Math.PI * density));
  return densityRadius + padding;
}

// ── 8. Max-speed estimation (production budget-based model) ─────────

export interface MaxSpeedInputs {
  now: number;
  mode: 'normal' | 'overloaded' | 'recovering';
  warmUpComplete: boolean;
  maxSpeed: number;
  effectiveSpeed: number;
  lastMaxSpeedUpdateTs: number;
  recoveringStartMax: number;
  recoveringBlendRemaining: number;
  profilerAlpha: number;
  prof: {
    physStepMs: number;
    renderMs: number;
    updatePosMs: number;
    otherMs: number;
    rafIntervalMs: number;
    actualRendersPerSec: number;
  };
  config: {
    maxSpeedUpdateNormalMs: number;
    maxSpeedUpdateOverloadMs: number;
    maxSpeedCap: number;
    budgetSafety: number;
    baseStepsPerSecond: number;
  };
}

export interface MaxSpeedOutputs {
  maxSpeed: number;
  lastMaxSpeedUpdateTs: number;
  recoveringStartMax: number;
  recoveringBlendRemaining: number;
}

/**
 * Update the max-speed estimate based on profiler data and scheduler mode.
 * Returns null if the cadence gate has not been reached (no update this tick).
 * Returns the updated mutable state fields if an update was performed.
 */
export function updateMaxSpeedEstimate(inputs: MaxSpeedInputs): MaxSpeedOutputs | null {
  if (!inputs.warmUpComplete) return null;

  const maxUpdateInterval = inputs.mode === 'overloaded'
    ? inputs.config.maxSpeedUpdateOverloadMs
    : inputs.config.maxSpeedUpdateNormalMs;

  if ((inputs.now - inputs.lastMaxSpeedUpdateTs) < maxUpdateInterval) return null;

  let rawMax: number;
  if (inputs.mode === 'overloaded') {
    rawMax = Math.min(inputs.effectiveSpeed, inputs.config.maxSpeedCap);
  } else {
    const budgetPerSec = 1000 * inputs.config.budgetSafety;
    const renderBudget = inputs.prof.actualRendersPerSec * inputs.prof.renderMs;
    const updateBudget = (1000 / inputs.prof.rafIntervalMs) * inputs.prof.updatePosMs;
    const otherBudget = (1000 / inputs.prof.rafIntervalMs) * inputs.prof.otherMs;
    const physicsBudget = budgetPerSec - renderBudget - updateBudget - otherBudget;
    const safePhysMs = Math.max(inputs.prof.physStepMs, 0.001);
    const maxSteps = Math.max(0, physicsBudget) / safePhysMs;
    rawMax = Math.min(maxSteps / inputs.config.baseStepsPerSecond, inputs.config.maxSpeedCap);
  }

  let maxSpeed: number;
  let recoveringStartMax = inputs.recoveringStartMax;
  let recoveringBlendRemaining = inputs.recoveringBlendRemaining;

  if (inputs.mode === 'recovering' && recoveringBlendRemaining > 0) {
    const stepIndex = 3 - recoveringBlendRemaining;
    const t = stepIndex / 2;
    maxSpeed = recoveringStartMax + t * (rawMax - recoveringStartMax);
    recoveringBlendRemaining--;
  } else {
    maxSpeed = inputs.maxSpeed + inputs.profilerAlpha * (rawMax - inputs.maxSpeed);
  }

  return {
    maxSpeed,
    lastMaxSpeedUpdateTs: inputs.now,
    recoveringStartMax,
    recoveringBlendRemaining,
  };
}
