/**
 * Shared pure domain logic for bonded-group color assignments.
 *
 * Contains base types and pure functions used by both lab and watch.
 * No framework dependencies (React, Zustand). No assignment record type —
 * each app owns its own (lab uses dense indices, watch uses stable atomIds).
 *
 * Renderer override maps use dense slot indices as keys. Each app is
 * responsible for projecting its identity model to dense indices before
 * calling rebuildOverridesFromDenseIndices().
 */

// ── Base types ──

/** Atom color value for authored appearance overrides. */
export interface AtomColorValue {
  hex: string;
}

/** Map of dense slot index → color override. Derived from assignments for rendering. */
export type AtomColorOverrideMap = Record<number, AtomColorValue>;

// ── Override projection ──

/** Deterministic projection: dense-index assignments → atom-level override map.
 *  Later assignments win for overlapping indices. Name makes the dense-index contract explicit. */
export function rebuildOverridesFromDenseIndices(
  assignments: readonly { atomIndices: number[]; colorHex: string }[],
): AtomColorOverrideMap {
  const overrides: AtomColorOverrideMap = {};
  for (const a of assignments) {
    for (const idx of a.atomIndices) {
      overrides[idx] = { hex: a.colorHex };
    }
  }
  return overrides;
}

// ── Color option model ──

/** Color option — unified type for default + preset colors. */
export type GroupColorOption =
  | { kind: 'default' }
  | { kind: 'preset'; hex: string };

/** Full palette (default + presets) — presets tuned for luminance separation under 3D atom lighting. */
export const GROUP_COLOR_OPTIONS: GroupColorOption[] = [
  { kind: 'default' },
  { kind: 'preset', hex: '#ff5555' },
  { kind: 'preset', hex: '#ffbb33' },
  { kind: 'preset', hex: '#33dd66' },
  { kind: 'preset', hex: '#55aaff' },
  { kind: 'preset', hex: '#aa77ff' },
  { kind: 'preset', hex: '#ff66aa' },
];

/** Layout split: primary (default) in hex center, secondary (presets) in hex ring. */
export interface GroupColorLayout {
  primary: GroupColorOption | null;
  secondary: GroupColorOption[];
}

/** Split options into primary (hex center) and secondary (hex ring). */
export function buildGroupColorLayout(options: GroupColorOption[]): GroupColorLayout {
  const primary = options.find(o => o.kind === 'default') ?? null;
  const secondary = options.filter(o => o.kind !== 'default');
  return { primary, secondary };
}

// ── Chip state derivation ──

/** Derived color state for a group's chip display. */
export type GroupColorState =
  | { kind: 'default' }
  | { kind: 'single'; hex: string }
  | { kind: 'multi'; hexes: string[]; hasDefault: boolean };

/**
 * Compute the effective color state of a group's atoms from the current override map.
 * Both apps call this with dense slot indices + current override map.
 *
 * @param atomIndices - dense slot indices of the group's atoms in the current frame
 * @param overrides - current atom-level color override map (dense slot → color)
 */
export function computeGroupColorState(
  atomIndices: number[],
  overrides: AtomColorOverrideMap,
): GroupColorState {
  if (atomIndices.length === 0) return { kind: 'default' };
  const unique = new Set<string>();
  let hasDefault = false;
  for (const idx of atomIndices) {
    if (overrides[idx]) {
      unique.add(overrides[idx].hex);
    } else {
      hasDefault = true;
    }
  }
  if (unique.size === 0) return { kind: 'default' };
  const hexes = [...unique].slice(0, 4);
  if (hexes.length === 1 && !hasDefault) return { kind: 'single', hex: hexes[0] };
  return { kind: 'multi', hexes, hasDefault };
}

// ── Honeycomb geometry ──

/** Swatch diameter in px — must match .bonded-groups-swatch CSS width/height. */
export const SWATCH_DIAMETER = 20;
/** Active swatch scale — must match .bonded-groups-swatch.active CSS transform scale. */
export const ACTIVE_SCALE = 1.3;
/** Minimum gap (px) between adjacent swatches at active scale. */
export const RING_GAP = 4;

/** Derive ring radius and container size so adjacent swatches don't overlap at active scale. */
export function computeHexGeometry(n: number, swatchDiam: number, activeScale: number, gap: number) {
  if (n <= 1) return { radius: 0, containerSize: swatchDiam * activeScale + gap * 2 };
  const minSpacing = swatchDiam * activeScale + gap;
  const radius = minSpacing / (2 * Math.sin(Math.PI / n));
  const containerSize = Math.ceil(2 * radius + swatchDiam * activeScale + gap * 2);
  return { radius, containerSize };
}
