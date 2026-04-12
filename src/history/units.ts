/**
 * Physical unit conversion constants for history-file interpolation math.
 *
 * Single source of truth — no magic literals in runtime strategy code.
 * Owned here (not in watch/) because the producer-side unit convention
 * comes from the simulator and is file-format adjacent.
 */

/** Number of femtoseconds per picosecond. Used to convert Å/fs velocities
 *  to Å/ps for Hermite interpolation against picosecond-based frame times.
 *  Referenced by Hermite strategy; never inline `* 1000` anywhere. */
export const FS_PER_PS = 1000;

/** Physically implausible velocity magnitude threshold (Å/fs). ~66× the
 *  simulator's V_HARD_MAX = 0.15 Å/fs. If a restart frame has velocities
 *  exceeding this, it's almost certainly a unit-conversion bug (e.g., a
 *  future exporter shipping Å/ps) — the import-time sanity check flags
 *  affected frames with velocityReason = 'velocities-implausible' so
 *  Hermite falls back to linear cleanly. */
export const IMPLAUSIBLE_VELOCITY_A_PER_FS = 10.0;
