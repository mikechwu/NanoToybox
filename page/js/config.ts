/**
 * Centralized page configuration — single source of truth for all
 * tuning values, thresholds, and defaults used across page modules.
 */
export const CONFIG = {
  libraryPath: '../structures/library',

  bonds: {
    cutoff: 1.8,          // Å — atoms closer than this are bonded
    visibilityCutoff: 2.0, // Å — renderer hides bonds stretched beyond this
    minDist: 0.5,          // Å — ignore pairs closer than this (overlap)
  },

  atoms: {
    radius: 0.35,          // Å — sphere geometry radius
    segments: [24, 16],    // sphere segments [width, height]
  },

  bondMesh: {
    radius: 0.07,
    segments: 12,
  },

  material: {
    roughness: 0.7,
    metalness: 0.0,
  },

  picker: {
    desktopExpansion: 0.12,  // NDC — fallback hit radius for desktop
    mobileExpansion: 0.20,   // NDC — fallback hit radius for mobile
    previewAtomPreference: 0.5, // Å — prefer atom hit over bond hit within this ray-distance threshold
  },

  physics: {
    dt: 0.5,               // fs — timestep
    stepsPerFrame: 4,       // substeps per rendered frame
    kDragDefault: 2.0,      // eV/Å² — drag spring constant
    kRotateDefault: 5.0,    // eV/Å² — rotation spring constant
    vHardMax: 0.15,         // Å/fs — per-atom velocity cap
    keCapMult: 500.0,       // KE cap multiplier
    dampingDefault: 0.0,     // velocity reduction factor per legacy batch (4 steps). Applied per-step internally as (1-d)^(1/4).
    fMax: 50.0,             // eV/Å — max force per atom
    iRef: 750.0,            // Å² — reference inertia (C60)
    useWasm: true,          // Wasm Tersoff kernel (C + Emscripten, -O3 -ffast-math). ~11% faster than JS JIT. Override via ?kernel=js|wasm.
  },

  wall: {
    springK: 5.0,            // eV/Å² — wall spring constant (soft harmonic)
    density: 0.00005,        // atoms/ų — target density for wall radius calculation
    padding: 50,             // Å — minimum clearance beyond density-derived radius
    removeMargin: 10,        // Å — extra distance past R_wall before atom removal (Remove mode)
    shrinkHysteresis: 2.0,   // shrink wall only if R_wall > target × this factor (prevents flapping)
    recenterThreshold: 0.25, // recenter wall when removal fraction exceeds this (0.25 = 25% of atoms removed in one event)
  },

  playback: {
    baseStepsPerSecond: 240,  // canonical 1x = 240 steps/sec (independent of display refresh)
    minSpeed: 0.5,
    defaultSpeed: 1.0,
    maxSpeedCap: 16.0,
    maxSubstepsPerTick: 64,
    profilerAlpha: 0.15,      // EMA smoothing for profiler
    budgetSafety: 0.85,       // fraction of wall time available for work
    gapThreshold: 250,        // ms — clamp frameDt above this
    // Scheduler heuristics (tunable)
    warmUpSteps: 30,          // profiled steps before trusting maxSpeed
    warmUpStableTicks: 10,    // consecutive stable ticks to exit warm-up early
    stabilityThreshold: 0.1,  // relative change threshold for stability check
    maxSpeedUpdateNormalMs: 500,   // maxSpeed update cadence in normal/recovering mode
    maxSpeedUpdateOverloadMs: 1000, // maxSpeed update cadence in overloaded mode
    overloadEntryTicks: 10,   // consecutive capped ticks to enter overloaded
    overloadExitTicks: 5,     // overloadCount threshold to enter recovering
    partialResetStepsCap: 15, // totalStepsProfiled cap after partial reset
    statusUpdateHz: 5,        // status text refresh rate (Hz) — no need to update faster than human can read
  },

  orbit: {
    rotateSpeed: 0.005,     // radians per CSS pixel of drag — triad orbit path
                            // OrbitControls rotateSpeed = this * 100 (see renderer.ts)
                            // Calibrated for 375-1024px viewports. See docs/testing.md parity note.
    triadHitPadding: 12,    // px — extra hit area beyond visible triad for touch tolerance
  },

  /** True when device-mode is phone or tablet (responsive layout). Width-derived. */
  isTouchDevice(): boolean {
    const mode = document.documentElement.dataset.deviceMode;
    return mode === 'phone' || mode === 'tablet';
  },

  /**
   * True when the primary pointer is coarse and cannot hover — genuine touch
   * interaction context (phone/tablet), not a narrow desktop window or a
   * touch-capable laptop with a precise trackpad.
   *
   * Use this for interaction-capability decisions (input binding, coachmark gating).
   * Use isTouchDevice() for responsive layout decisions only.
   *
   * Stable across resize — does not change with viewport width.
   */
  isTouchInteraction(): boolean {
    return (
      window.matchMedia('(pointer: coarse)').matches &&
      !window.matchMedia('(hover: hover)').matches
    );
  },

  debug: {
    input: false,
    load: false,
    assertions: false,       // invariant checks after appendMolecule
    failAfterPhysicsAppend: false,  // fault injection: throw after physics append
    failRendererAppend: false,      // fault injection: throw during renderer append
    profiler: false,                // 'live' | 'bench' | false — runtime stage instrumentation
  },
};
