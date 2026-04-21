/**
 * Deterministic capsule fixture builders — single source of truth
 * consumed by pipeline tests, dense-outcome tests, and the preview-
 * audit dev page. All builders return a valid
 * {@link AtomDojoPlaybackCapsuleFileV1} with a single dense frame and
 * the `default-carbon-v1` bond policy (cutoff 1.85 Å, minDist 0.5 Å).
 *
 * Two buckets — both required. Structural fixtures cover shape and
 * bond-density coverage; color fixtures cover per-element CPK
 * preservation (phase-4 acceptance gate in the audit-page plan).
 *
 *   Structural: C60, graphene, CNT, sparse small, dense noisy.
 *   Color:      water cluster, oxide patch, simple organic (glycine).
 *
 * Every builder uses fixed inputs — no randomness, no clock, no env —
 * so byte-equal output every call. That's what makes them safe to
 * share between a unit test regression gate and an interactive audit
 * page without drift between the two surfaces.
 */

import type { AtomDojoPlaybackCapsuleFileV1 } from '../../history/history-file-v1';

const BOND_POLICY: AtomDojoPlaybackCapsuleFileV1['bondPolicy'] = {
  policyId: 'default-carbon-v1',
  cutoff: 1.85,
  minDist: 0.5,
};

const PRODUCER = {
  app: 'lab',
  appVersion: '0.1.0',
  exportedAt: '2026-04-20T00:00:00Z',
} as const;

function buildCapsule(
  atoms: ReadonlyArray<{ id: number; element: string }>,
  positions: ReadonlyArray<number>,
): AtomDojoPlaybackCapsuleFileV1 {
  const n = atoms.length;
  if (positions.length !== n * 3) {
    throw new Error(
      `capsule-preview-structures: positions.length=${positions.length} must equal n*3=${n * 3}`,
    );
  }
  return {
    format: 'atomdojo-history',
    version: 1,
    kind: 'capsule',
    producer: { ...PRODUCER },
    simulation: {
      units: { time: 'ps', length: 'angstrom' },
      maxAtomCount: n,
      durationPs: 0,
      frameCount: 1,
      indexingModel: 'dense-prefix',
    },
    atoms: { atoms: atoms.map((a) => ({ ...a })) },
    bondPolicy: { ...BOND_POLICY },
    timeline: {
      denseFrames: [
        {
          frameId: 0,
          timePs: 0,
          n,
          atomIds: atoms.map((_, i) => i),
          positions: positions.slice(),
        },
      ],
    },
  };
}

// ── Structural fixtures ────────────────────────────────────────────────

/** C60-like 60-atom icosphere placement. Nearest-neighbour distances
 *  fall near the 1.45 Å target of real C60 so the `default-carbon-v1`
 *  bond policy picks up the cage topology. */
export function makeC60Capsule(): AtomDojoPlaybackCapsuleFileV1 {
  const N = 60;
  const R = 3.5;
  const atoms: Array<{ id: number; element: string }> = [];
  const positions: number[] = [];
  for (let i = 0; i < N; i++) {
    const phi = Math.acos(1 - (2 * (i + 0.5)) / N);
    const theta = Math.PI * (1 + Math.sqrt(5)) * i;
    const x = R * Math.sin(phi) * Math.cos(theta);
    const y = R * Math.sin(phi) * Math.sin(theta);
    const z = R * Math.cos(phi);
    atoms.push({ id: i, element: 'C' });
    positions.push(x, y, z);
  }
  return buildCapsule(atoms, positions);
}

/** Graphene-like flat sheet, 5 × 7 hex lattice. */
export function makeGrapheneCapsule(): AtomDojoPlaybackCapsuleFileV1 {
  const rows = 5;
  const cols = 7;
  const dx = 1.42;
  const dy = (1.42 * Math.sqrt(3)) / 2;
  const atoms: Array<{ id: number; element: string }> = [];
  const positions: number[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const offset = r % 2 === 0 ? 0 : dx / 2;
      atoms.push({ id: atoms.length, element: 'C' });
      positions.push(c * dx + offset, r * dy, 0);
    }
  }
  return buildCapsule(atoms, positions);
}

/** CNT-like tubular structure, 6 rings × 8 atoms, radius 2 Å,
 *  ring-to-ring spacing 1.42 Å. */
export function makeCntCapsule(): AtomDojoPlaybackCapsuleFileV1 {
  const rings = 6;
  const perRing = 8;
  const R = 2.0;
  const atoms: Array<{ id: number; element: string }> = [];
  const positions: number[] = [];
  for (let r = 0; r < rings; r++) {
    for (let k = 0; k < perRing; k++) {
      const theta = (k / perRing) * Math.PI * 2 + (r % 2) * (Math.PI / perRing);
      atoms.push({ id: atoms.length, element: 'C' });
      positions.push(R * Math.cos(theta), R * Math.sin(theta), r * 1.42);
    }
  }
  return buildCapsule(atoms, positions);
}

/** Sparse small capsule — 4 carbons arranged in a small tetrahedron.
 *  Below the bonds-aware threshold (14 atoms) so the thumb pipeline
 *  falls into the atoms-only regime — useful for verifying the
 *  atoms-only render path on the audit page. */
export function makeSparseSmallCapsule(): AtomDojoPlaybackCapsuleFileV1 {
  const atoms = [
    { id: 0, element: 'C' },
    { id: 1, element: 'C' },
    { id: 2, element: 'C' },
    { id: 3, element: 'C' },
  ];
  const s = 1.54 / Math.sqrt(3); // tetrahedral edge near real C-C distance
  const positions: number[] = [
     s,  s,  s,
    -s, -s,  s,
    -s,  s, -s,
     s, -s, -s,
  ];
  return buildCapsule(atoms, positions);
}

/** Dense noisy cluster — 24 carbons on a jittered 3×4×2 lattice with
 *  per-atom offsets small enough to keep bonds within the cutoff but
 *  large enough that the projection doesn't collapse to a uniform
 *  grid. Exercises the bonds-aware threshold and the dense-scene
 *  fallback guard (metric 5). */
export function makeDenseNoisyCapsule(): AtomDojoPlaybackCapsuleFileV1 {
  const atoms: Array<{ id: number; element: string }> = [];
  const positions: number[] = [];
  // Deterministic jitter — a simple index-based LCG so repeated calls
  // return byte-equal output.
  const jitter = (seed: number): number => {
    const s = (seed * 9301 + 49297) % 233280;
    return (s / 233280 - 0.5) * 0.12; // ±0.06 Å
  };
  let i = 0;
  for (let x = 0; x < 3; x++) {
    for (let y = 0; y < 4; y++) {
      for (let z = 0; z < 2; z++) {
        atoms.push({ id: i, element: 'C' });
        positions.push(
          x * 1.45 + jitter(i * 3),
          y * 1.45 + jitter(i * 3 + 1),
          z * 1.45 + jitter(i * 3 + 2),
        );
        i++;
      }
    }
  }
  return buildCapsule(atoms, positions);
}

// ── Color (mixed-element) fixtures ─────────────────────────────────────

/** Water cluster — 8 H₂O molecules on a loose cubic lattice. Exists
 *  specifically to test that O atoms stay visually distinct from H
 *  halos at poster + thumb scale (CPK O = #ff0d0d, H = #ffffff). Bond
 *  cutoff 1.85 Å catches each O–H pair (~0.96 Å) and no H–H. */
export function makeWaterClusterCapsule(): AtomDojoPlaybackCapsuleFileV1 {
  const atoms: Array<{ id: number; element: string }> = [];
  const positions: number[] = [];
  const grid: Array<[number, number, number]> = [];
  for (let gx = 0; gx < 2; gx++) {
    for (let gy = 0; gy < 2; gy++) {
      for (let gz = 0; gz < 2; gz++) {
        grid.push([gx * 2.6, gy * 2.6, gz * 2.6]);
      }
    }
  }
  // Each molecule: O centered, two H atoms at ~0.96 Å, H-O-H angle
  // near 104.5°. Place H atoms deterministically in the molecule's
  // local frame.
  const OH = 0.96;
  const halfAngle = (104.5 / 2) * (Math.PI / 180);
  const hx = OH * Math.sin(halfAngle);
  const hy = OH * Math.cos(halfAngle);
  for (const [cx, cy, cz] of grid) {
    atoms.push({ id: atoms.length, element: 'O' });
    positions.push(cx, cy, cz);
    atoms.push({ id: atoms.length, element: 'H' });
    positions.push(cx + hx, cy + hy, cz);
    atoms.push({ id: atoms.length, element: 'H' });
    positions.push(cx - hx, cy + hy, cz);
  }
  return buildCapsule(atoms, positions);
}

/** SiO₂ fragment — alternating Si and O atoms along a chain-like
 *  arrangement. Si = #f0c8a0 (tan), O = #ff0d0d (red). Exists to
 *  verify that the renderer keeps Si and O as distinct swatches — a
 *  flat-black render would collapse them. */
export function makeOxidePatchCapsule(): AtomDojoPlaybackCapsuleFileV1 {
  const atoms: Array<{ id: number; element: string }> = [];
  const positions: number[] = [];
  // Linear Si-O-Si-O-... chain with a short branch so bonds form a
  // recognizable pattern. Si-O distance ≈ 1.61 Å, within cutoff.
  const seq: Array<[string, number, number, number]> = [
    ['Si', 0.00, 0.00, 0.00],
    ['O',  1.61, 0.00, 0.00],
    ['Si', 3.22, 0.00, 0.00],
    ['O',  4.83, 0.00, 0.00],
    ['Si', 6.44, 0.00, 0.00],
    ['O',  8.05, 0.00, 0.00],
    ['Si', 9.66, 0.00, 0.00],
    // short branch to give the fragment planar structure
    ['O',  1.61,  1.61, 0.00],
    ['Si', 1.61,  3.22, 0.00],
    ['O',  3.22,  1.61, 0.00],
    ['Si', 3.22,  3.22, 0.00],
    ['O',  4.83,  1.61, 0.00],
    ['Si', 4.83,  3.22, 0.00],
    ['O',  6.44,  1.61, 0.00],
    ['Si', 6.44,  3.22, 0.00],
  ];
  for (const [element, x, y, z] of seq) {
    atoms.push({ id: atoms.length, element });
    positions.push(x, y, z);
  }
  return buildCapsule(atoms, positions);
}

// ── Cluster-selection fixtures (ADR D138) ─────────────────────────────

/**
 * One dominant cluster + small noise fragments. The dominance guard
 * passes (ratio ≫ 2, fraction ≫ 0.6), so the cluster selector picks
 * the big fragment and drops the noise.
 *
 * Shape: a 10-atom linear carbon chain (atoms 0–9, spaced 1.40 Å) plus
 * three isolated carbon atoms far from the chain AND from each other
 * (distances > the default 1.85 Å cutoff) so they form 3 singleton
 * components. Total 13 atoms, components: 1×10 + 3×1.
 *   ratio = 10/1 = 10.0 ≥ 2.0 ✓
 *   fraction = 10/13 ≈ 0.77 ≥ 0.6 ✓
 */
export function makeFragmentedCapsule(): AtomDojoPlaybackCapsuleFileV1 {
  const atoms: Array<{ id: number; element: string }> = [];
  const positions: number[] = [];
  const dx = 1.40;
  for (let i = 0; i < 10; i++) {
    atoms.push({ id: i, element: 'C' });
    positions.push(i * dx, 0, 0);
  }
  // Noise atoms placed far from the chain and from each other so they
  // don't bond to anything (> 1.85 Å default cutoff and beyond minDist).
  const noise: Array<[number, number, number]> = [
    [0, 10, 0],
    [20, 10, 0],
    [10, 20, 10],
  ];
  for (const [x, y, z] of noise) {
    atoms.push({ id: atoms.length, element: 'C' });
    positions.push(x, y, z);
  }
  return buildCapsule(atoms, positions);
}

/**
 * Two balanced fragments (collision-setup / reactant-product pair).
 * The dominance guard rejects (ratio = 1.0 < 2.0 AND fraction = 0.5 <
 * 0.6), so selection falls back to the full frame.
 *
 * Shape: two 5-atom linear carbon chains separated by > 1.85 Å cutoff
 * (center-to-center ~20 Å). Total 10 atoms, components: 2×5.
 */
export function makeTwoEqualFragmentsCapsule(): AtomDojoPlaybackCapsuleFileV1 {
  const atoms: Array<{ id: number; element: string }> = [];
  const positions: number[] = [];
  const dx = 1.40;
  for (let i = 0; i < 5; i++) {
    atoms.push({ id: atoms.length, element: 'C' });
    positions.push(i * dx, 0, 0);
  }
  for (let i = 0; i < 5; i++) {
    atoms.push({ id: atoms.length, element: 'C' });
    positions.push(20 + i * dx, 0, 0);
  }
  return buildCapsule(atoms, positions);
}

/**
 * Close-approach proximity-fusion fixture — locks in the documented
 * limitation that the preview selector operates on a proximity graph,
 * NOT authoritative molecular connectivity (ADR D138).
 *
 * Two 3-atom C chains placed so the inter-fragment closest pair falls
 * at exactly 1.80 Å — between the intra-fragment length (1.40 Å) and
 * the default cutoff (1.85 Å). Atom IDs 10, 20, 30, 40, 50, 60 are
 * spread so tie-break assertions can distinguish them.
 *
 *   Fragment A: (0, 0, 0), (1.40, 0, 0), (2.80, 0, 0)
 *   Fragment B: (4.60, 0, 0), (6.00, 0, 0), (7.40, 0, 0)
 *   Inter-fragment A2↔B0: |4.60 − 2.80| = 1.80 Å
 *
 * With the default 1.85 Å cutoff the two fragments fuse into ONE
 * 6-atom "cluster" (proximity graph, not chemistry). With a tightened
 * 1.60 Å cutoff the inter-fragment bond drops, revealing 2 balanced
 * components that fail the dominance guard and fall back to full frame.
 *
 * The fixture does NOT bake the `bondPolicy` — tests pass `cutoff` and
 * `minDist` explicitly to `deriveBondPairs` to exercise both outcomes.
 */
export function makeCloseApproachCapsule(): AtomDojoPlaybackCapsuleFileV1 {
  const atoms: Array<{ id: number; element: string }> = [
    { id: 10, element: 'C' },
    { id: 20, element: 'C' },
    { id: 30, element: 'C' },
    { id: 40, element: 'C' },
    { id: 50, element: 'C' },
    { id: 60, element: 'C' },
  ];
  const positions: number[] = [
    0.00, 0.00, 0.00,
    1.40, 0.00, 0.00,
    2.80, 0.00, 0.00,
    4.60, 0.00, 0.00,
    6.00, 0.00, 0.00,
    7.40, 0.00, 0.00,
  ];
  // buildCapsule expects atomIds at index i to equal i, so bypass the
  // helper and inline the shape to keep the distinctive atomIds.
  const n = atoms.length;
  return {
    format: 'atomdojo-history',
    version: 1,
    kind: 'capsule',
    producer: { ...PRODUCER },
    simulation: {
      units: { time: 'ps', length: 'angstrom' },
      maxAtomCount: n,
      durationPs: 0,
      frameCount: 1,
      indexingModel: 'dense-prefix',
    },
    atoms: { atoms: atoms.map((a) => ({ ...a })) },
    bondPolicy: { ...BOND_POLICY },
    timeline: {
      denseFrames: [
        {
          frameId: 0,
          timePs: 0,
          n,
          atomIds: atoms.map((a) => a.id),
          positions: positions.slice(),
        },
      ],
    },
  };
}

/** Simple-organic (glycine-like, NH₂-CH₂-COOH). ~10 heavy atoms with
 *  C/H/N/O mix. Tests the common organic-chemistry case where CPK
 *  color dominates recognizability. Hydrogens attached so the
 *  rendered atom count crosses the bonds-aware threshold. */
export function makeSimpleOrganicCapsule(): AtomDojoPlaybackCapsuleFileV1 {
  // Approximate bond lengths: C-N 1.47, C-C 1.54, C=O 1.22, C-O(H) 1.36, C-H 1.09, N-H 1.01, O-H 0.96.
  const atoms: Array<{ id: number; element: string }> = [];
  const positions: number[] = [];
  function add(element: string, x: number, y: number, z: number) {
    atoms.push({ id: atoms.length, element });
    positions.push(x, y, z);
  }
  // Backbone
  add('N', 0.00, 0.00, 0.00);
  add('C', 1.47, 0.00, 0.00);
  add('C', 2.24, 1.33, 0.00);
  add('O', 1.58, 2.46, 0.00);   // C=O
  add('O', 3.60, 1.36, 0.00);   // C-OH
  // Hydrogens (so the rendered atom count exceeds the bonds-aware
  // threshold and mixed-element color contrast is exercised).
  add('H',-0.50, 0.87, 0.00);   // N-H1
  add('H',-0.50,-0.87, 0.00);   // N-H2
  add('H', 1.97,-0.55, 0.89);   // C2-Hα
  add('H', 1.97,-0.55,-0.89);   // C2-Hα'
  add('H', 4.05, 2.24, 0.00);   // O-H
  return buildCapsule(atoms, positions);
}
