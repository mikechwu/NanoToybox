/**
 * Shared pure presentational helper for bonded-group color chip background.
 *
 * Returns a CSS background value string (not React.CSSProperties) so the
 * helper is framework-neutral. Each app wraps into { background: value }.
 *
 * Lives under src/ui/ (presentational) rather than src/appearance/ (domain).
 */

import type { GroupColorState } from '../appearance/bonded-group-color-assignments';

/**
 * Compute the CSS background value for a group color chip.
 *
 * - default: undefined (CSS fallback to --atom-base-color)
 * - single: solid hex color
 * - multi: conic-gradient with equal-angle slices (capped to 4 unique colors)
 */
export function chipBackgroundValue(state: GroupColorState): string | undefined {
  if (state.kind === 'single') return state.hex;
  if (state.kind === 'multi') {
    const colors = [...state.hexes];
    if (state.hasDefault) colors.push('var(--atom-base-color, #444)');
    const n = colors.length;
    const stops = colors.map((c, i) =>
      `${c} ${(i / n) * 360}deg ${((i + 1) / n) * 360}deg`
    ).join(', ');
    return `conic-gradient(${stops})`;
  }
  return undefined;
}
