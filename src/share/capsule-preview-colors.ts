/**
 * Color resolution for the V2 capsule preview pipeline (spec §capsule-preview-colors).
 *
 * The V1 capsule schema's `appearance.colorAssignments` is a per-group
 * fan-out, not a per-atom map — each assignment lists many atom IDs sharing
 * a color. Naively treating it as a per-atom map is the biggest correctness
 * trap here, so resolution is centralized in this module and both the
 * server-side poster compose and the account-API row derivation consume it.
 *
 * Pure; no DOM, no network, no Cloudflare APIs.
 */

import type {
  AtomInfoV1,
  CapsuleAppearanceV1,
} from '../history/history-file-v1';

/** CPK-like element → hex table. Mirrors Watch's preview so cross-surface
 *  color identity survives the Watch-vs-OG transition. Elements outside
 *  the common organic set fall through to {@link NEUTRAL_GREY}. */
export const ELEMENT_COLORS: Readonly<Record<string, string>> = {
  H:  '#ffffff',
  C:  '#222222',
  N:  '#3050f8',
  O:  '#ff0d0d',
  F:  '#90e050',
  Ne: '#b3e3f5',
  Na: '#ab5cf2',
  Mg: '#8aff00',
  Al: '#bfa6a6',
  Si: '#f0c8a0',
  P:  '#ff8000',
  S:  '#ffff30',
  Cl: '#1ff01f',
  Ar: '#80d1e3',
  K:  '#8f40d4',
  Ca: '#3dff00',
  Fe: '#e06633',
  Cu: '#c88033',
  Zn: '#7d80b0',
  Br: '#a62929',
  I:  '#940094',
};

export const NEUTRAL_GREY = '#9aa0a6';

/**
 * Resolve a per-atom color map for the frame preview.
 *
 * Algorithm (spec §capsule-preview-colors):
 *   1. Fan out per-group assignments in authored order (last-write-wins on
 *      duplicate IDs — deterministic because input iteration order is fixed).
 *   2. For any atom not covered by step 1, fall back to the element table.
 *   3. Unknown elements resolve to {@link NEUTRAL_GREY}.
 */
export function resolveAtomColors(
  atoms: ReadonlyArray<AtomInfoV1>,
  appearance: CapsuleAppearanceV1 | undefined,
): Map<number, string> {
  const out = new Map<number, string>();
  const assignments = appearance?.colorAssignments;
  if (assignments && Array.isArray(assignments)) {
    for (const group of assignments) {
      if (!group || !Array.isArray(group.atomIds)) continue;
      const hex = typeof group.colorHex === 'string' ? group.colorHex : '';
      if (!hex) continue;
      for (const atomId of group.atomIds) {
        if (typeof atomId === 'number') out.set(atomId, hex);
      }
    }
  }
  for (const atom of atoms) {
    if (out.has(atom.id)) continue;
    out.set(atom.id, ELEMENT_COLORS[atom.element] ?? NEUTRAL_GREY);
  }
  return out;
}
