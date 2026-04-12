/**
 * Structure loader — fetches manifest and XYZ files from the library.
 * Builds bond topology via the shared topology builder.
 *
 * Round 7: buildBondTopology(atoms, cutoff) is a permanent compatibility
 * adapter — it translates the caller-provided cutoff into a BondRuleSet
 * and delegates to the shared buildBondTopologyFromAtoms(). The export
 * signature is unchanged; existing tests and call sites are unaffected.
 */
import { CONFIG } from './config';
import type { StructureAtom, StructureBond } from './placement';
import { createBondRules } from '../../src/topology/bond-rules';
import { buildBondTopologyFromAtoms } from '../../src/topology/build-bond-topology';

const LIBRARY_PATH = CONFIG.libraryPath;

export async function loadManifest() {
  const resp = await fetch(`${LIBRARY_PATH}/manifest.json`);
  if (!resp.ok) throw new Error(`Failed to load manifest: ${resp.status}`);
  return resp.json();
}

export async function loadStructure(filename: string, basePath?: string): Promise<{ atoms: StructureAtom[]; bonds: StructureBond[] }> {
  const resp = await fetch(`${basePath || LIBRARY_PATH}/${filename}`);
  if (!resp.ok) throw new Error(`Failed to load ${filename}: ${resp.status}`);
  const text = await resp.text();
  const atoms = parseXYZ(text);
  const bonds = buildBondTopology(atoms, CONFIG.bonds.cutoff);
  return { atoms, bonds };
}

export function parseXYZ(text: string): StructureAtom[] {
  const lines = text.split('\n');
  let i = 0;
  while (i < lines.length) {
    const nLine = lines[i].trim();
    if (!nLine) { i++; continue; }
    const nAtoms = parseInt(nLine);
    if (isNaN(nAtoms) || nAtoms <= 0) { i++; continue; }
    const atoms = [];
    for (let a = 0; a < nAtoms; a++) {
      const parts = (lines[i + 2 + a] || '').trim().split(/\s+/);
      if (parts.length >= 4) {
        atoms.push({
          element: parts[0],
          x: parseFloat(parts[1]),
          y: parseFloat(parts[2]),
          z: parseFloat(parts[3]),
        });
      }
    }
    if (atoms.length === nAtoms) return atoms;
    i += 2 + nAtoms;
  }
  return [];
}

/** Compatibility adapter — unchanged export signature, delegates to shared builder. */
export function buildBondTopology(atoms: StructureAtom[], cutoff: number): StructureBond[] {
  return buildBondTopologyFromAtoms(atoms, createBondRules({ minDist: CONFIG.bonds.minDist, cutoff }));
}
