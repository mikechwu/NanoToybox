/**
 * Behavioral tests for PhysicsEngine checkpoint/restore.
 *
 * These test the actual physics engine logic — no WebGL or DOM required.
 * The PhysicsEngine operates on typed arrays and can be instantiated in Node.
 */
import { describe, it, expect } from 'vitest';
import { PhysicsEngine } from '../../page/js/physics';

// Minimal atom set for testing
const DIMER_ATOMS = [
  { x: 0, y: 0, z: 0 },
  { x: 1.5, y: 0, z: 0 },
];
const DIMER_BONDS: [number, number, number][] = [[0, 1, 1.5]];

describe('PhysicsEngine checkpoint/restore', () => {
  it('createCheckpoint snapshots current state', () => {
    const engine = new PhysicsEngine();
    engine.appendMolecule(DIMER_ATOMS, DIMER_BONDS, [0, 0, 0]);

    const cp = engine.createCheckpoint();
    expect(cp.n).toBe(2);
    expect(cp.pos.length).toBe(6); // 2 atoms * 3 coords
    expect(cp.vel.length).toBe(6);
    expect(cp.bonds.length).toBe(1);
  });

  it('restoreCheckpoint reverts to previous state after append', () => {
    const engine = new PhysicsEngine();
    engine.appendMolecule(DIMER_ATOMS, DIMER_BONDS, [0, 0, 0]);
    expect(engine.n).toBe(2);

    const cp = engine.createCheckpoint();

    // Append more atoms
    engine.appendMolecule(DIMER_ATOMS, DIMER_BONDS, [5, 0, 0]);
    expect(engine.n).toBe(4);

    // Restore
    engine.restoreCheckpoint(cp);
    expect(engine.n).toBe(2);
    expect(engine.bonds.length).toBe(1);
  });

  it('restoreCheckpoint from empty state works', () => {
    const engine = new PhysicsEngine();
    const cp = engine.createCheckpoint();
    expect(cp.n).toBe(0);
    expect(cp.pos.length).toBe(0);

    engine.appendMolecule(DIMER_ATOMS, DIMER_BONDS, [0, 0, 0]);
    expect(engine.n).toBe(2);

    engine.restoreCheckpoint(cp);
    expect(engine.n).toBe(0);
  });

  it('assertPostAppendInvariants passes after valid append', () => {
    const engine = new PhysicsEngine();
    engine.appendMolecule(DIMER_ATOMS, DIMER_BONDS, [0, 0, 0]);
    // Should not throw
    expect(() => engine.assertPostAppendInvariants()).not.toThrow();
  });

  it('checkpoint positions match appended atom positions', () => {
    const engine = new PhysicsEngine();
    engine.appendMolecule(DIMER_ATOMS, DIMER_BONDS, [10, 20, 30]);

    const cp = engine.createCheckpoint();
    // First atom at offset: (10, 20, 30)
    expect(cp.pos[0]).toBeCloseTo(10, 5);
    expect(cp.pos[1]).toBeCloseTo(20, 5);
    expect(cp.pos[2]).toBeCloseTo(30, 5);
    // Second atom at offset: (11.5, 20, 30)
    expect(cp.pos[3]).toBeCloseTo(11.5, 5);
  });
});
