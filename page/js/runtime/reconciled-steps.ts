/**
 * Reconciled-step deduplication helper.
 *
 * Prevents the same worker snapshot from being counted multiple times,
 * which would cause sim time to advance faster than actual physics.
 */

/** Resolve how many steps to count from a worker snapshot.
 *  Returns stepsCompleted only for genuinely NEW snapshots (by version). */
export function resolveReconciledSteps(
  snapshotVersion: number,
  lastVersion: number,
  stepsCompleted: number,
): { steps: number; newLastVersion: number } {
  if (snapshotVersion === lastVersion) return { steps: 0, newLastVersion: lastVersion };
  return { steps: stepsCompleted, newLastVersion: snapshotVersion };
}
