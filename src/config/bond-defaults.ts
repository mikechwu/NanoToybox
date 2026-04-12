/**
 * Shared bond-policy defaults — canonical source for cutoff/minDist values
 * used by both lab/ and watch/.
 *
 * Owns:        BOND_DEFAULTS (cutoff, minDist)
 * Does NOT own: bond-rule interface or builder logic (those live in src/topology/).
 * Imported by:  lab/js/config.ts, watch topology reconstruction
 */

export const BOND_DEFAULTS = {
  cutoff: 1.8,    // Å — atoms closer than this are bonded
  minDist: 0.5,   // Å — ignore pairs closer than this (overlap)
} as const;
