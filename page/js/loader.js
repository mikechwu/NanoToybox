/**
 * Structure loader — fetches manifest and XYZ files from the library.
 * Builds bond topology via distance cutoff.
 */

const LIBRARY_PATH = '../structures/library';

export async function loadManifest() {
  const resp = await fetch(`${LIBRARY_PATH}/manifest.json`);
  if (!resp.ok) throw new Error(`Failed to load manifest: ${resp.status}`);
  return resp.json();
}

export async function loadStructure(filename) {
  const resp = await fetch(`${LIBRARY_PATH}/${filename}`);
  if (!resp.ok) throw new Error(`Failed to load ${filename}: ${resp.status}`);
  const text = await resp.text();
  const atoms = parseXYZ(text);
  const bonds = buildBondTopology(atoms, 1.8);
  return { atoms, bonds };
}

function parseXYZ(text) {
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

export function buildBondTopology(atoms, cutoff) {
  const bonds = [];
  const n = atoms.length;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const dx = atoms[j].x - atoms[i].x;
      const dy = atoms[j].y - atoms[i].y;
      const dz = atoms[j].z - atoms[i].z;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (dist < cutoff && dist > 0.5) {
        bonds.push([i, j, dist]);
      }
    }
  }
  return bonds;
}
