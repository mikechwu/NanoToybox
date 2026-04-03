/**
 * Centralized page configuration — single source of truth for all
 * tuning values, thresholds, and defaults used across page modules.
 */

/** Default theme — single source of truth. Used by main.ts, renderer, and store. */
export const DEFAULT_THEME: 'dark' | 'light' = 'light';

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
    radius: 0.126,
    segments: 12,
  },

  atomMaterial: {
    roughness: 0.55,
    metalness: 0.0,
  },

  bondMaterial: {
    roughness: 0.35,     // smoother than atoms — cleaner specular highlight on tubes
    metalness: 0.0,
  },

  // Panel highlight (bonded group selection/hover) — warm palette, persistent
  panelHighlight: {
    selected: { color: 0xffe45c, emissive: 0xffcc33, emissiveIntensity: 1.5, opacity: 0.6, scale: 1.2 },
    hover:    { color: 0xfff0a0, emissive: 0xffdd66, emissiveIntensity: 0.8, opacity: 0.4, scale: 1.1 },
  },

  // Interaction highlight (Move/Rotate mode) — cool palette, transient
  interactionHighlight: {
    active: { color: 0x336688, emissive: 0x445566, emissiveIntensity: 1.2, opacity: 0.3, scale: 1.15 },
    hover:  { color: 0x336688, emissive: 0x445566, emissiveIntensity: 0.8, opacity: 0.2, scale: 1.08 },
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
    springK: 0.5,            // eV/Å² — wall spring constant (soft harmonic)
    density: 0.00005,        // atoms/ų — target density for wall radius calculation
    padding: 50,             // Å — minimum clearance beyond density-derived radius
    removeMargin: 10,        // Å — extra distance past R_wall before atom removal (Remove mode)
    shrinkHysteresis: 2.0,   // shrink wall only if R_wall > target × this factor (prevents flapping)
    recenterThreshold: 0.25, // recenter wall when removal fraction exceeds this (0.25 = 25% of atoms removed in one event)
  },

  playback: {
    /** Canonical 1x physical simulation rate in ps/s.
     *  Step rate is derived via getPhysicsTiming(): baseSimRatePsPerSecond / (dt / 1000). */
    baseSimRatePsPerSecond: 0.12,
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
    rotateSpeed: 0.005,     // radians per CSS pixel of drag — used by applyOrbitDelta()
                            // Both triad drag and background orbit share this value.
                            // Desktop right-drag uses OrbitControls' own rotateSpeed (decoupled).
    triadHitPadding: 12,    // px — extra hit area beyond visible triad for touch tolerance
  },

  camera: {
    freeLookEnabled: false,         // Feature flag: Free-Look mode. Set true to enable mode chip toggle,
                                    // flight controls, and Free-Look UI. Implementation retained when false.
    framingPadding: 1.25,           // [1.0–2.0] multiplier on bounding radius (1.0 = exact fit)
    animationDurationMs: 500,       // [300–800] ms for focus/snap transitions
    nearPlaneMargin: 0.5,           // [0.1–2.0] Ang beyond camera.near for framing safety
    verticalFallbackDot: 0.985,     // [0.95–0.999] |dot(forward, Y)| threshold (~10°)
    atomVisualRadius: 0.4,          // [0.2–0.8] Ang — added to bounding sphere for rendered mesh
    defaultOrbitDistance: 15,        // [8–30] Ang — fallback pivot distance for Esc-to-Orbit
    followLongPressMs: 500,         // [300–800] ms — long-press threshold for ⊕ follow mode
  },

  placementFraming: {
    left: 0.88,                       // normalized safe-region allowance (left half-space)
    right: 0.88,
    top: 0.90,
    bottom: 0.82,                     // larger bottom inset (dock bar clearance)
    targetShiftLambda: 0.15,          // cost weight penalizing target shift vs. zoom-out
    targetSmoothing: 10,              // exponential smoothing constant (s⁻¹) for target
    distanceGrowSmoothing: 8,         // smoothing for distance increase
    distanceShrinkSmoothing: 3,       // smoothing for distance decrease (slower settle)
    visibleAnchorMargin: 0.15,        // frustum margin for visible-anchor capture (0 = exact frustum)
  },

  reviewModeUi: {
    statusHintMs: 2200,               // ms — transient status hint auto-clear duration
  },

  freeLook: {
    accelerationScale: 3.0,         // [1–10] thrust acceleration multiplier (× sceneRadius)
    maxSpeedScale: 8.0,             // [3–20] max speed multiplier (× sceneRadius)
    dragRationalScale: 1.5,         // [0.5–5] rational drag coefficient k (× sceneRadius)
    dragCrossoverScale: 0.5,        // [0.1–2] speed below which linear replaces rational (× sceneRadius)
    freezeShowScale: 0.03,          // [0.01–0.1] fraction of effectiveMaxSpeed for ✕ show
    freezeShowMin: 0.1,             // [0.05–0.3] Ang/s absolute floor
    freezeShowMax: 2.0,             // [0.5–5] Ang/s absolute cap
    freezeHideRatio: 0.25,          // [0.1–0.5] hide = resolvedShow × ratio
    defaultSceneRadius: 10,         // [5–30] Ang — fallback when no molecules
    farDriftTargetMult: 10,         // [5–20] target molecule radius multiplier
    farDriftSceneMult: 3.0,         // [2–5] scene radius multiplier (global cap)
    farDriftMinDistance: 30,         // [10–100] Ang — absolute floor
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

  // Camera lighting rig — ownership boundary:
  //   Rig geometry (offsets, target): CONFIG.cameraLighting below
  //   Beam behavior (angle, penumbra, decay, distance): CONFIG.cameraLighting below
  //   Visual style (color, intensity): THEMES in themes.ts — _applyLightTheme()
  cameraLighting: {
    head: {
      // ── Rig geometry (camera-local transform) ──
      offset: [0, 0.3, 0.5] as readonly [number, number, number],   // camera-local: slightly above and in front
      target: [0, 0, -10] as readonly [number, number, number],      // camera-local: straight ahead on -Z
      // ── Beam behavior (photometric, not transform) ──
      angle: Math.PI / 3,    // [rad] wide cone — ensures framed molecules stay inside
      penumbra: 0.8,         // [0–1] very soft edge to avoid harsh cone boundary
      decay: 0,              // no distance falloff — uniform like directional
      distance: 0,           // 0 = unlimited range — no cutoff darkening
    },
    fill: {
      enabled: true,
      // ── Rig geometry ──
      offset: [-1.0, 0.2, 0.4] as readonly [number, number, number],  // camera-local: left side (broad fill)
      target: [0, 0, -10] as readonly [number, number, number],        // camera-local: straight ahead on -Z
    },
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

/**
 * Query-param debug hooks — centralized reader for URL-based overrides.
 *
 * Approved debug params (append to URL for dev/test use):
 * - ?kernel=js|wasm   — force physics kernel (see physics.ts)
 * - ?e2e=1            — suppress onboarding overlay (see runtime/onboarding.ts)
 *
 * E2E tests inject these via gotoApp() from tests/e2e/helpers.ts.
 */
export function getDebugParam(key: string): string | null {
  if (typeof window === 'undefined') return null;
  return new URLSearchParams(window.location?.search).get(key);
}

/** Derive consistent physics timing from the canonical config.
 *  If dt changes, call this to get the correct derived step rate. */
export function getPhysicsTiming() {
  const dtFs = CONFIG.physics.dt;
  const stepPs = dtFs / 1000;
  const baseStepsPerSecond = CONFIG.playback.baseSimRatePsPerSecond / stepPs;
  return { dtFs, stepPs, baseStepsPerSecond };
}
