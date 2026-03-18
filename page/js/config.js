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
  },

  physics: {
    dt: 0.5,               // fs — timestep
    stepsPerFrame: 4,       // substeps per rendered frame
    kDragDefault: 2.0,      // eV/Å² — drag spring constant
    kRotateDefault: 5.0,    // eV/Å² — rotation spring constant
    vHardMax: 0.15,         // Å/fs — per-atom velocity cap
    keCapMult: 500.0,       // KE cap multiplier
    mildDamping: 0.001,     // per-frame velocity damping
    fMax: 50.0,             // eV/Å — max force per atom
    iRef: 750.0,            // Å² — reference inertia (C60)
  },

  debug: {
    input: false,
    load: false,
  },
};
