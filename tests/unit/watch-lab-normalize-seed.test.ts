/**
 * @vitest-environment jsdom
 */
import { describe, it, expect } from 'vitest';
import { normalizeWatchSeed } from '../../src/watch-lab-handoff/normalize-watch-seed';
import type { WatchLabSceneSeed } from '../../src/watch-lab-handoff/watch-lab-handoff-shared';

function seedFixture(overrides: Partial<WatchLabSceneSeed> = {}): WatchLabSceneSeed {
  return {
    atoms: [
      { id: 0, element: 'C' },
      { id: 1, element: 'H', isotope: 2, charge: null, label: 'deuterium' },
    ],
    positions: [0, 0, 0, 1.4, 0, 0],
    velocities: [0, 0, 0, 0.5, -0.2, 0.1],
    bonds: [{ a: 0, b: 1, distance: 1.4 }],
    boundary: {
      mode: 'contain',
      wallRadius: 50,
      wallCenter: [0, 0, 0],
      wallCenterSet: true,
      removedCount: 0,
      damping: 0.1,
    },
    config: { damping: 0.1, kDrag: 1, kRotate: 1, dtFs: 0.5, dampingRefDurationFs: 100 },
    provenance: { historyKind: 'full', velocitiesAreApproximated: false },
    ...overrides,
  };
}

describe('normalizeWatchSeed — shape invariants', () => {
  it('n === seed.atoms.length === localStructureAtoms.length', () => {
    const p = normalizeWatchSeed(seedFixture());
    expect(p.n).toBe(2);
    expect(p.localStructureAtoms.length).toBe(2);
  });

  it('velocities has length n*3, zeroed when seed.velocities === null', () => {
    const p = normalizeWatchSeed(seedFixture({ velocities: null }));
    expect(p.velocities.length).toBe(p.n * 3);
    // All zero-initialized.
    for (let i = 0; i < p.velocities.length; i++) expect(p.velocities[i]).toBe(0);
  });

  it('velocities byte-equal to input when seed.velocities is present', () => {
    const p = normalizeWatchSeed(seedFixture());
    expect(Array.from(p.velocities)).toEqual([0, 0, 0, 0.5, -0.2, 0.1]);
  });

  it('localStructureAtoms[i].{x,y,z} matches seed.positions[i*3..i*3+2] in order', () => {
    const seed = seedFixture();
    const p = normalizeWatchSeed(seed);
    for (let i = 0; i < p.n; i++) {
      expect(p.localStructureAtoms[i].x).toBe(seed.positions[i * 3]);
      expect(p.localStructureAtoms[i].y).toBe(seed.positions[i * 3 + 1]);
      expect(p.localStructureAtoms[i].z).toBe(seed.positions[i * 3 + 2]);
    }
  });

  it('localStructureAtoms[i].element matches seed.atoms[i].element', () => {
    const p = normalizeWatchSeed(seedFixture());
    expect(p.localStructureAtoms[0].element).toBe('C');
    expect(p.localStructureAtoms[1].element).toBe('H');
  });

  it('bonds converted from {a,b,distance} objects to [a,b,distance] tuples', () => {
    const p = normalizeWatchSeed(seedFixture());
    expect(p.bonds).toEqual([[0, 1, 1.4]]);
  });

  it('workerConfig.wallMode === boundary.mode', () => {
    const p = normalizeWatchSeed(seedFixture());
    expect(p.workerConfig.wallMode).toBe(p.boundary.mode);
  });

  it('workerConfig.dt uses seed dtFs directly', () => {
    const p = normalizeWatchSeed(seedFixture());
    expect(p.workerConfig.dt).toBe(0.5);
  });

  it('workerConfig.dampingReferenceSteps derived from dampingRefDurationFs / dtFs', () => {
    const p = normalizeWatchSeed(seedFixture());
    // 100 / 0.5 = 200 steps
    expect(p.workerConfig.dampingReferenceSteps).toBe(200);
  });

  it('workerConfig.dampingReferenceSteps floor-protected at 1 for tiny ratios', () => {
    const p = normalizeWatchSeed(seedFixture({
      config: { damping: 0.1, kDrag: 1, kRotate: 1, dtFs: 10, dampingRefDurationFs: 1 },
    }));
    // 1 / 10 = 0.1 rounds to 0 → clamped to 1.
    expect(p.workerConfig.dampingReferenceSteps).toBe(1);
  });

  it('boundary shape is byte-equal to the input boundary', () => {
    const seed = seedFixture();
    const p = normalizeWatchSeed(seed);
    expect(p.boundary).toEqual(seed.boundary);
  });

  it('provenance is shallow-copied (not the same reference)', () => {
    const seed = seedFixture();
    const p = normalizeWatchSeed(seed);
    expect(p.provenance).toEqual(seed.provenance);
    expect(p.provenance).not.toBe(seed.provenance);
  });
});

describe('normalizeWatchSeed — authoritative damping timing (audit P1)', () => {
  it('workerConfig.dampingRefDurationFs propagates directly from the seed', () => {
    const p = normalizeWatchSeed(seedFixture({
      config: { damping: 0.1, kDrag: 1, kRotate: 1, dtFs: 0.5, dampingRefDurationFs: 137 },
    }));
    // Duration is preserved byte-for-byte so the engine's
    // `_recomputeDampingFactor` sees the handed-off decay window, not
    // a boot default. Without this propagation, the engine would
    // silently recalibrate damping even though `damping` + `dt` +
    // `dampingReferenceSteps` all match the seed.
    expect(p.workerConfig.dampingRefDurationFs).toBe(137);
  });

  it('workerConfig.dampingReferenceSteps agrees with the duration → dt ratio', () => {
    const p = normalizeWatchSeed(seedFixture({
      config: { damping: 0.1, kDrag: 1, kRotate: 1, dtFs: 0.5, dampingRefDurationFs: 137 },
    }));
    // 137 / 0.5 = 274 — both fields describe the same window, one as
    // time and one as step count. Consumers that look at only the
    // step count get the right number; consumers that look at the
    // duration get the authoritative physical window.
    expect(p.workerConfig.dampingReferenceSteps).toBe(274);
  });

  it('workerConfig preserves a non-boot-default duration (handoff fidelity regression lock)', () => {
    // This is the concrete failure mode the audit flagged: if the
    // seed carries a `dampingRefDurationFs` different from Lab's boot
    // default, the worker protocol must pass it through so
    // `setTimeConfig(dt, refSteps, dampingRefDurationFs)` on the
    // receiving engine can reinstate the exact decay window the
    // recording used.
    const nonDefault = seedFixture({
      config: { damping: 0.1, kDrag: 1, kRotate: 1, dtFs: 0.25, dampingRefDurationFs: 250 },
    });
    const p = normalizeWatchSeed(nonDefault);
    expect(p.workerConfig.dampingRefDurationFs).toBe(250);
    expect(p.workerConfig.dt).toBe(0.25);
    // refSteps = 250 / 0.25 = 1000
    expect(p.workerConfig.dampingReferenceSteps).toBe(1000);
  });
});

describe('normalizeWatchSeed — cold-start semantics', () => {
  it('produces a valid payload with zero velocities when input velocities is null', () => {
    const p = normalizeWatchSeed(seedFixture({ velocities: null }));
    // All downstream consumers must see a usable Float64Array; zeros
    // are the same cold-start signal `physics.restoreCheckpoint`
    // accepts.
    expect(p.velocities).toBeInstanceOf(Float64Array);
    expect(p.velocities.length).toBe(p.n * 3);
    expect(p.velocities.every((v: number) => v === 0)).toBe(true);
  });
});

describe('normalizeWatchSeed — single-source-of-truth ordering', () => {
  it('reordering seed.atoms changes localStructureAtoms in lockstep (no shared mutable state across calls)', () => {
    const a = normalizeWatchSeed(seedFixture());
    const b = normalizeWatchSeed(seedFixture({
      atoms: [
        { id: 5, element: 'O' },
        { id: 7, element: 'N' },
      ],
      positions: [9, 9, 9, 2, 2, 2],
    }));
    expect(b.localStructureAtoms[0].x).toBe(9);
    expect(b.localStructureAtoms[0].element).toBe('O');
    expect(b.localStructureAtoms[1].element).toBe('N');
    // First payload unaffected (no shared mutable state).
    expect(a.localStructureAtoms[0].x).toBe(0);
    expect(a.localStructureAtoms[0].element).toBe('C');
  });
});
