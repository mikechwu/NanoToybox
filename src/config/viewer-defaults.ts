/**
 * Shared viewer defaults — canonical source for values used by both lab/ and watch/.
 *
 * Owns:        baseSimRatePsPerSecond, defaultTheme
 * Imported by: lab/js/config.ts (references in CONFIG), watch/js/ (direct import)
 * Does NOT own: lab-specific settings (atom geometry, bond cutoffs, physics, debug flags)
 */

export const VIEWER_DEFAULTS = {
  /** Canonical 1x physical simulation rate in ps/s.
   *  Lab uses this in CONFIG.playback; watch uses it for playback advancement. */
  baseSimRatePsPerSecond: 0.12,
  /** Default theme for both lab and watch. */
  defaultTheme: 'light' as const,
  /** Atom visual radius added to bounding sphere for camera framing (Angstrom). */
  atomVisualRadius: 0.4,
} as const;
