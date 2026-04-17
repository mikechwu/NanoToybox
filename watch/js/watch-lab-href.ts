/**
 * Watch → Lab URL helpers. Pure composition; no DOM / storage access.
 *
 * `buildLabHref()` reads `import.meta.env.BASE_URL` (vite standard) so the
 * control works under preview-deployment subpaths (e.g. `/preview-abc/lab/`)
 * as well as prod (`/lab/`). Never hard-code `/lab/`.
 */

/**
 * Compose the Lab entry URL with an optional query-param bag. Keys and
 * values are URI-encoded. Returns an absolute path (leading slash) so
 * the browser resolves against the current origin.
 */
export function buildLabHref(query?: Record<string, string>): string {
  const base = (import.meta.env?.BASE_URL ?? '/').replace(/\/+$/, '');
  const path = `${base}/lab/`;
  if (!query) return path;
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v != null) params.set(k, v);
  }
  const qs = params.toString();
  return qs ? `${path}?${qs}` : path;
}

/**
 * Parse a boolean / numeric URL override from the current location.
 * Used to route e2e-only behaviors (`?e2eResetLabHints=1`,
 * `?e2eHintDismissMs=500`, `?e2eHandoffTtlMs=500`). All three are
 * stripped by the Lab consume-cleanup step so they never survive
 * navigation across apps.
 */
export function readE2EBoolean(paramName: string, location?: Location): boolean {
  try {
    const loc = location ?? (typeof window !== 'undefined' ? window.location : null);
    if (!loc) return false;
    const v = new URLSearchParams(loc.search).get(paramName);
    return v === '1' || v === 'true';
  } catch {
    return false;
  }
}

export function readE2ENumber(paramName: string, location?: Location): number | null {
  try {
    const loc = location ?? (typeof window !== 'undefined' ? window.location : null);
    if (!loc) return null;
    const v = new URLSearchParams(loc.search).get(paramName);
    if (v == null) return null;
    const n = Number.parseInt(v, 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}
