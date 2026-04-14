/**
 * Single-line error-message helper.
 *
 * Replaces the `err instanceof Error ? err.message : String(err)`
 * pattern that was duplicated 11+ times across the Phase 7 surface.
 * Centralised so future changes (e.g. always include the class name,
 * always strip a known prefix, always cap length) happen once.
 */

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  return String(err);
}
