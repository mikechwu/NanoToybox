/**
 * Bond topology parity + characterization tests (Plan Phase 1).
 *
 * Locks down current behavior BEFORE and AFTER the shared-builder extraction:
 *   - naive builder (loader path) parity
 *   - accelerated builder (physics path) parity
 *   - naive ↔ accelerated agreement on same geometry
 *   - bond ordering contract (ascending i, then j)
 *   - cutoff-override preservation
 *   - empty-system edge case
 *   - timeline/export continuity via captureRestartFrameData
 */

import { describe, it, expect } from 'vitest';
import { PhysicsEngine } from '../../lab/js/physics';
import { createBondRules } from '../../src/topology/bond-rules';
import {
  buildBondTopologyFromAtoms,
  buildBondTopologyAccelerated,
  createBondTopologyWorkspace,
} from '../../src/topology/build-bond-topology';
import { captureRestartFrameData } from '../../lab/js/runtime/restart-state-adapter';

// ── Fixtures ──

const EMPTY_ATOMS: { element: string; x: number; y: number; z: number }[] = [];

const DIMER_ATOMS = [
  { element: 'C', x: 0, y: 0, z: 0 },
  { element: 'C', x: 1.42, y: 0, z: 0 },
];

const NO_BOND_ATOMS = [
  { element: 'C', x: 0, y: 0, z: 0 },
  { element: 'C', x: 3.0, y: 0, z: 0 },
];

const d = 1.42;
const TRIANGLE_ATOMS = [
  { element: 'C', x: 0, y: 0, z: 0 },
  { element: 'C', x: d, y: 0, z: 0 },
  { element: 'C', x: d / 2, y: d * Math.sqrt(3) / 2, z: 0 },
];

const MIXED_ATOMS = [
  { element: 'C', x: 0, y: 0, z: 0 },
  { element: 'C', x: 1.42, y: 0, z: 0 },
  { element: 'C', x: 10, y: 0, z: 0 },
  { element: 'C', x: 0.1, y: 0, z: 0 },
];

const DEFAULT_RULES = createBondRules({ minDist: 0.5, cutoff: 1.8 });

function toFlatPositions(atoms: { x: number; y: number; z: number }[]): Float64Array {
  const arr = new Float64Array(atoms.length * 3);
  for (let i = 0; i < atoms.length; i++) {
    arr[i * 3] = atoms[i].x;
    arr[i * 3 + 1] = atoms[i].y;
    arr[i * 3 + 2] = atoms[i].z;
  }
  return arr;
}

function initEngine(atoms: { element: string; x: number; y: number; z: number }[]): PhysicsEngine {
  const engine = new PhysicsEngine({ skipWasmInit: true });
  engine.init(atoms, []);
  return engine;
}

// ── BondRuleSet ──

describe('BondRuleSet', () => {
  it('createBondRules precomputes squared values', () => {
    const rules = createBondRules({ minDist: 0.5, cutoff: 1.8 });
    expect(rules.minDist).toBe(0.5);
    expect(rules.minDist2).toBeCloseTo(0.25);
    expect(rules.globalMaxDist).toBe(1.8);
    expect(rules.globalMaxDist2).toBeCloseTo(3.24);
    expect(rules.maxPairDistance('C', 'C')).toBe(1.8);
  });
});

// ── Naive builder (shared) ──

describe('buildBondTopologyFromAtoms (shared naive builder)', () => {
  it('empty atoms → empty bonds', () => {
    expect(buildBondTopologyFromAtoms(EMPTY_ATOMS, DEFAULT_RULES)).toEqual([]);
  });

  it('dimer at 1.42 Å → one bond', () => {
    const bonds = buildBondTopologyFromAtoms(DIMER_ATOMS, DEFAULT_RULES);
    expect(bonds).toHaveLength(1);
    expect(bonds[0][0]).toBe(0);
    expect(bonds[0][1]).toBe(1);
    expect(bonds[0][2]).toBeCloseTo(1.42);
  });

  it('atoms at 3.0 Å → no bond', () => {
    expect(buildBondTopologyFromAtoms(NO_BOND_ATOMS, DEFAULT_RULES)).toHaveLength(0);
  });

  it('triangle → three bonds in ascending (i,j) order', () => {
    const bonds = buildBondTopologyFromAtoms(TRIANGLE_ATOMS, DEFAULT_RULES);
    expect(bonds).toHaveLength(3);
    expect(bonds[0][0]).toBe(0); expect(bonds[0][1]).toBe(1);
    expect(bonds[1][0]).toBe(0); expect(bonds[1][1]).toBe(2);
    expect(bonds[2][0]).toBe(1); expect(bonds[2][1]).toBe(2);
  });

  it('mixed: 0↔1 bonded, 0↔3 too close (minDist), 1↔3 bonded, 2 isolated → two bonds', () => {
    const bonds = buildBondTopologyFromAtoms(MIXED_ATOMS, DEFAULT_RULES);
    expect(bonds).toHaveLength(2);
    expect(bonds[0][0]).toBe(0); expect(bonds[0][1]).toBe(1);
    expect(bonds[1][0]).toBe(1); expect(bonds[1][1]).toBe(3);
  });
  it('pair-aware: heterogeneous rules produce different bonds than global cutoff', () => {
    const atoms = [
      { element: 'C', x: 0, y: 0, z: 0 },
      { element: 'H', x: 1.1, y: 0, z: 0 },   // C-H at 1.1 Å
      { element: 'O', x: 1.5, y: 0, z: 0 },    // C-O at 1.5 Å
    ];
    const heteroRules = {
      minDist: 0.3,
      minDist2: 0.09,
      globalMaxDist: 1.8,
      globalMaxDist2: 3.24,
      maxPairDistance(a: string, b: string): number {
        const pair = [a, b].sort().join('-');
        if (pair === 'C-H') return 1.2;
        if (pair === 'C-O') return 1.8;
        return 0.8;
      },
    };
    const bonds = buildBondTopologyFromAtoms(atoms, heteroRules);
    // C-H at 1.1 Å → within C-H cutoff 1.2 → bonded
    // C-O at 1.5 Å → within C-O cutoff 1.8 → bonded
    // H-O at 0.4 Å → within H-O cutoff 0.8 but above minDist 0.3 → bonded
    expect(bonds).toHaveLength(3);
    expect(bonds[0][0]).toBe(0); expect(bonds[0][1]).toBe(1); // C-H
    expect(bonds[1][0]).toBe(0); expect(bonds[1][1]).toBe(2); // C-O
    expect(bonds[2][0]).toBe(1); expect(bonds[2][1]).toBe(2); // H-O

    // Now with a tighter rule that blocks C-O and H-O
    const tightRules = {
      minDist: 0.3,
      minDist2: 0.09,
      globalMaxDist: 1.8,
      globalMaxDist2: 3.24,
      maxPairDistance(a: string, b: string): number {
        const pair = [a, b].sort().join('-');
        if (pair === 'C-H') return 1.2;
        return 0.35; // below minDist threshold for H-O at 0.4, and below C-O at 1.5
      },
    };
    const tightBonds = buildBondTopologyFromAtoms(atoms, tightRules);
    // C-H at 1.1 Å → within 1.2 cutoff → bonded
    // C-O at 1.5 Å → cutoff 0.35 → not bonded
    // H-O at 0.4 Å → cutoff 0.35 → not bonded (0.4 > 0.35)
    expect(tightBonds).toHaveLength(1);
    expect(tightBonds[0][0]).toBe(0); expect(tightBonds[0][1]).toBe(1); // only C-H
  });
});

// ── Accelerated builder (shared) ──

describe('buildBondTopologyAccelerated (shared accelerated builder)', () => {
  it('rejects non-null elements at runtime (JS/any-typed callers)', () => {
    const ws = createBondTopologyWorkspace(2);
    const out: [number, number, number][] = [];
    expect(() =>
      (buildBondTopologyAccelerated as Function)(
        2, toFlatPositions(DIMER_ATOMS), ['C', 'C'], DEFAULT_RULES, ws, out,
      ),
    ).toThrow('Element-aware accelerated bond topology is not implemented yet');
  });

  it('n=0 with prepopulated outBonds → returns 0', () => {
    const ws = createBondTopologyWorkspace(1);
    const stale: [number, number, number][] = [[99, 99, 99]];
    const count = buildBondTopologyAccelerated(
      0, new Float64Array(0), null, DEFAULT_RULES, ws, stale,
    );
    expect(count).toBe(0);
  });

  it('dimer → one bond, same as naive', () => {
    const ws = createBondTopologyWorkspace(2);
    const out: [number, number, number][] = [];
    const count = buildBondTopologyAccelerated(
      2, toFlatPositions(DIMER_ATOMS), null, DEFAULT_RULES, ws, out,
    );
    expect(count).toBe(1);
    expect(out[0][0]).toBe(0);
    expect(out[0][1]).toBe(1);
    expect(out[0][2]).toBeCloseTo(1.42);
  });

  it('triangle → three bonds in ascending (i,j) order', () => {
    const ws = createBondTopologyWorkspace(3);
    const out: [number, number, number][] = [];
    const count = buildBondTopologyAccelerated(
      3, toFlatPositions(TRIANGLE_ATOMS), null, DEFAULT_RULES, ws, out,
    );
    expect(count).toBe(3);
    expect(out[0][0]).toBe(0); expect(out[0][1]).toBe(1);
    expect(out[1][0]).toBe(0); expect(out[1][1]).toBe(2);
    expect(out[2][0]).toBe(1); expect(out[2][1]).toBe(2);
  });

  it('output-buffer reuse: reuses existing tuple entries in-place', () => {
    const ws = createBondTopologyWorkspace(2);
    const existing: [number, number, number] = [88, 88, 88];
    const out: [number, number, number][] = [existing];
    const count = buildBondTopologyAccelerated(
      2, toFlatPositions(DIMER_ATOMS), null, DEFAULT_RULES, ws, out,
    );
    expect(count).toBe(1);
    expect(out[0]).toBe(existing);
    expect(existing[0]).toBe(0);
    expect(existing[1]).toBe(1);
  });

  it('workspace grows transparently when n exceeds initial capacity', () => {
    const ws = createBondTopologyWorkspace(1);
    const out: [number, number, number][] = [];
    const count = buildBondTopologyAccelerated(
      3, toFlatPositions(TRIANGLE_ATOMS), null, DEFAULT_RULES, ws, out,
    );
    expect(count).toBe(3);
  });
});

// Loader wrapper tests (buildBondTopology(atoms, cutoff)) live in
// tests/unit/loader.test.ts — not duplicated here.

// ── PhysicsEngine parity ──

describe('PhysicsEngine.updateBondList() parity with shared builder', () => {
  it('dimer: engine.getBonds() matches naive builder', () => {
    const engine = initEngine(DIMER_ATOMS);
    engine.updateBondList();
    const engineBonds = engine.getBonds();
    const naiveBonds = buildBondTopologyFromAtoms(DIMER_ATOMS, DEFAULT_RULES);
    expect(engineBonds).toHaveLength(naiveBonds.length);
    for (let i = 0; i < naiveBonds.length; i++) {
      expect(engineBonds[i][0]).toBe(naiveBonds[i][0]);
      expect(engineBonds[i][1]).toBe(naiveBonds[i][1]);
      expect(engineBonds[i][2]).toBeCloseTo(naiveBonds[i][2]);
    }
  });

  it('triangle: ascending (i,j) order matches naive', () => {
    const engine = initEngine(TRIANGLE_ATOMS);
    engine.updateBondList();
    const engineBonds = engine.getBonds();
    const naiveBonds = buildBondTopologyFromAtoms(TRIANGLE_ATOMS, DEFAULT_RULES);
    expect(engineBonds).toHaveLength(3);
    for (let i = 0; i < 3; i++) {
      expect(engineBonds[i][0]).toBe(naiveBonds[i][0]);
      expect(engineBonds[i][1]).toBe(naiveBonds[i][1]);
    }
  });

  it('engine with no-bond pair: getBonds() is empty', () => {
    const engine = initEngine(NO_BOND_ATOMS);
    engine.updateBondList();
    expect(engine.getBonds()).toHaveLength(0);
  });

  it('mixed: two bonds (0↔1 + 1↔3), minDist blocks 0↔3', () => {
    const engine = initEngine(MIXED_ATOMS);
    engine.updateBondList();
    expect(engine.getBonds()).toHaveLength(2);
    expect(engine.getBonds()[0][0]).toBe(0);
    expect(engine.getBonds()[0][1]).toBe(1);
    expect(engine.getBonds()[1][0]).toBe(1);
    expect(engine.getBonds()[1][1]).toBe(3);
  });

});

// ── Bond ordering contract ──

describe('Bond ordering contract', () => {
  it('triangle produces bonds in ascending (i,j) order: [0,1], [0,2], [1,2]', () => {
    const engine = initEngine(TRIANGLE_ATOMS);
    engine.updateBondList();
    const bonds = engine.getBonds();
    expect(bonds[0][0]).toBe(0); expect(bonds[0][1]).toBe(1);
    expect(bonds[1][0]).toBe(0); expect(bonds[1][1]).toBe(2);
    expect(bonds[2][0]).toBe(1); expect(bonds[2][1]).toBe(2);
  });
});

// ── Timeline/export continuity ──

describe('Timeline/export continuity', () => {
  it('captureRestartFrameData produces the same bond tuples as getBonds', () => {
    const engine = initEngine(DIMER_ATOMS);
    engine.updateBondList();
    const restartData = captureRestartFrameData(engine as any);
    const engineBonds = engine.getBonds();
    expect(restartData.bonds).toHaveLength(engineBonds.length);
    for (let i = 0; i < engineBonds.length; i++) {
      expect(restartData.bonds[i][0]).toBe(engineBonds[i][0]);
      expect(restartData.bonds[i][1]).toBe(engineBonds[i][1]);
      expect(restartData.bonds[i][2]).toBeCloseTo(engineBonds[i][2]);
    }
  });
});
