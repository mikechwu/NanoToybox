/**
 * Format a byte count for human-readable display: B / KB / MB with
 * one decimal at the KB/MB boundary. Shared between Lab (export
 * estimates, publish-size errors) and Watch (share download progress
 * copy for unknown-total streams).
 *
 * Kept in `src/` because both apps consume it; previously lived in
 * `lab/js/runtime/timeline/history-export.ts` and was reached into from
 * `watch/js/components/WatchOpenPanel.tsx`, which violated the
 * "shared utilities belong in `src/`" convention in
 * `docs/contributing.md`.
 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
