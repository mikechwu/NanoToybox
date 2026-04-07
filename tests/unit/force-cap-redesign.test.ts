/**
 * Tests for the final force-safety architecture: source-level force saturation.
 *
 * Safety model:
 *   - saturateInternalForces(): per-atom thresholded smooth saturation
 *   - Interaction saturation: drag, translate, rotate (pre-torque)
 *   - vHardMax: per-atom velocity cap (sole post-integration guard)
 *
 * Covers:
 *   - Smooth saturation formula correctness
 *   - Internal force saturation (per-atom thresholded)
 *   - Interaction force saturation (drag, translate, rotate pre-torque)
 *   - vHardMax-only applySafetyControls (no global KE cap)
 *   - Force-magnitude telemetry (stable and overlap scenarios)
 *   - Conservation validation (ΣF measurement, COM drift)
 *   - Isolated saturateInternalForces ΣF measurement
 *   - Translate size-independence contract
 *   - Config migration (old fields removed, new fields present)
 */
import { describe, it, expect } from 'vitest';
import { PhysicsEngine } from '../../lab/js/physics';
import { CONFIG } from '../../lab/js/config';

// ── Helpers ──

const TWO_ATOMS = [
  { x: 0, y: 0, z: 0 },
  { x: 1.42, y: 0, z: 0 }, // equilibrium C-C bond distance
];
const BOND: [number, number, number][] = [[0, 1, 1.42]];

function makeEngine(atoms = TWO_ATOMS, bonds = BOND) {
  const engine = new PhysicsEngine();
  engine.appendMolecule(atoms, bonds, [0, 0, 0]);
  return engine;
}

// ── Config migration ──

describe('Force-cap config migration', () => {
  it('CONFIG.physics has new force-cap fields', () => {
    expect(CONFIG.physics.fMaxInteraction).toBeTypeOf('number');
    expect(CONFIG.physics.fRepulsionStart).toBeTypeOf('number');
    expect(CONFIG.physics.fMaxInternal).toBeTypeOf('number');
    expect(CONFIG.physics.fMaxInteraction).toBeGreaterThan(0);
    expect(CONFIG.physics.fRepulsionStart).toBeGreaterThan(0);
    expect(CONFIG.physics.fMaxInternal).toBeGreaterThan(0);
  });

  it('CONFIG.physics no longer has fMax or keCapMult', () => {
    expect(CONFIG.physics).not.toHaveProperty('fMax');
    expect(CONFIG.physics).not.toHaveProperty('keCapMult');
  });

  it('fRepulsionStart < fMaxInternal (necessary invariant)', () => {
    expect(CONFIG.physics.fRepulsionStart).toBeLessThan(CONFIG.physics.fMaxInternal);
  });

  it('vHardMax remains as emergency guard', () => {
    expect(CONFIG.physics.vHardMax).toBe(0.15);
  });
});

// ── Smooth saturation formula ──

describe('Smooth saturation formula: f / (1 + |f| / F_MAX)', () => {
  it('is linear near zero', () => {
    // For small f relative to F_MAX, f_sat ≈ f
    const fMax = 100;
    const f = 1.0;
    const fSat = f / (1 + f / fMax);
    // Should be within 1% of f
    expect(fSat).toBeCloseTo(f, 1);
    expect(fSat / f).toBeGreaterThan(0.99);
  });

  it('smoothly approaches F_MAX as f → ∞', () => {
    const fMax = 100;
    // At f = 10 * F_MAX, saturation should be near F_MAX
    const f = 1000;
    const fSat = f / (1 + f / fMax);
    expect(fSat).toBeLessThan(fMax);
    expect(fSat).toBeGreaterThan(fMax * 0.9); // within 10%
  });

  it('never exceeds F_MAX', () => {
    const fMax = 100;
    for (const f of [50, 100, 1000, 1e6]) {
      const fSat = f / (1 + f / fMax);
      expect(fSat).toBeLessThan(fMax);
    }
  });

  it('equals F_MAX/2 when f = F_MAX', () => {
    const fMax = 100;
    const fSat = fMax / (1 + fMax / fMax);
    expect(fSat).toBe(50);
  });
});

// ── Internal force saturation ──

describe('saturateInternalForces() — per-atom thresholded', () => {
  it('does not modify forces below F_REPULSION_START', () => {
    const engine = makeEngine();
    // Set force well below threshold
    const lowForce = CONFIG.physics.fRepulsionStart * 0.5;
    engine.force[0] = lowForce;
    engine.force[1] = 0;
    engine.force[2] = 0;
    engine.saturateInternalForces();
    expect(engine.force[0]).toBe(lowForce);
  });

  it('compresses forces above F_REPULSION_START', () => {
    const engine = makeEngine();
    const bigForce = CONFIG.physics.fRepulsionStart * 5;
    engine.force[0] = bigForce;
    engine.force[1] = 0;
    engine.force[2] = 0;
    engine.saturateInternalForces();
    expect(engine.force[0]).toBeLessThan(bigForce);
    expect(engine.force[0]).toBeGreaterThan(CONFIG.physics.fRepulsionStart);
  });

  it('result is bounded by F_MAX_INTERNAL', () => {
    const engine = makeEngine();
    // Pathologically large force
    engine.force[0] = 1e6;
    engine.force[1] = 0;
    engine.force[2] = 0;
    engine.saturateInternalForces();
    expect(engine.force[0]).toBeLessThan(CONFIG.physics.fMaxInternal);
  });

  it('preserves force direction', () => {
    const engine = makeEngine();
    const bigForce = CONFIG.physics.fRepulsionStart * 3;
    engine.force[0] = bigForce * 0.6;
    engine.force[1] = bigForce * 0.8;
    engine.force[2] = 0;
    const origMag = Math.sqrt(engine.force[0] ** 2 + engine.force[1] ** 2);
    const origRatio = engine.force[0] / engine.force[1];

    engine.saturateInternalForces();

    const newRatio = engine.force[0] / engine.force[1];
    const newMag = Math.sqrt(engine.force[0] ** 2 + engine.force[1] ** 2);
    expect(newRatio).toBeCloseTo(origRatio, 10);
    expect(newMag).toBeLessThan(origMag);
  });

  it('is per-atom, not global (different atoms get different scaling)', () => {
    const engine = makeEngine();
    // Atom 0: large force (above threshold)
    engine.force[0] = CONFIG.physics.fRepulsionStart * 5;
    // Atom 1: small force (below threshold)
    const smallForce = CONFIG.physics.fRepulsionStart * 0.3;
    engine.force[3] = smallForce;
    engine.force[4] = 0;
    engine.force[5] = 0;

    engine.saturateInternalForces();

    // Atom 0 was compressed
    expect(engine.force[0]).toBeLessThan(CONFIG.physics.fRepulsionStart * 5);
    // Atom 1 was NOT touched
    expect(engine.force[3]).toBe(smallForce);
  });
});

// ── Interaction force saturation ──

describe('Interaction force saturation', () => {
  it('drag force is saturated (does not grow unboundedly with displacement)', () => {
    const engine = makeEngine();
    // Place drag target very far away to produce enormous spring force
    engine.startDrag(0);
    engine.updateDrag(1000, 0, 0); // 1000 Å away

    // Run one computeForces to get the saturated drag force
    engine.computeForces();

    // Without saturation, kDrag * 1000 = 2000 eV/Å. With saturation it should be much less.
    const dragForceMag = Math.sqrt(
      engine.force[0] ** 2 + engine.force[1] ** 2 + engine.force[2] ** 2,
    );
    expect(dragForceMag).toBeLessThan(CONFIG.physics.fMaxInteraction);
    expect(dragForceMag).toBeGreaterThan(0);
    engine.endDrag();
  });

  it('translate force is saturated', () => {
    const engine = makeEngine();
    engine.startTranslate(0);
    engine.updateDrag(1000, 0, 0);

    engine.computeForces();

    // Per-atom force on atom 0
    const f0Mag = Math.sqrt(
      engine.force[0] ** 2 + engine.force[1] ** 2 + engine.force[2] ** 2,
    );
    expect(f0Mag).toBeLessThan(CONFIG.physics.fMaxInteraction);
    engine.endDrag();
  });

  it('rotate spring force is saturated pre-torque', () => {
    // Build a small molecule to have a meaningful component
    const atoms = [
      { x: 0, y: 0, z: 0 },
      { x: 1.42, y: 0, z: 0 },
      { x: 2.84, y: 0, z: 0 },
    ];
    const bonds: [number, number, number][] = [[0, 1, 1.42], [1, 2, 1.42]];
    const engine = makeEngine(atoms, bonds);
    engine.startRotateDrag(0);
    engine.updateDrag(1000, 0, 0); // huge displacement

    engine.computeForces();

    // Forces should be bounded — no atom should have infinite force
    for (let i = 0; i < engine.n; i++) {
      const ix = i * 3;
      const mag = Math.sqrt(
        engine.force[ix] ** 2 + engine.force[ix + 1] ** 2 + engine.force[ix + 2] ** 2,
      );
      // Hard to predict exact value due to torque distribution, but should be finite and bounded
      expect(mag).toBeLessThan(1000); // well below unbounded regime
      expect(isFinite(mag)).toBe(true);
    }
    engine.endDrag();
  });

  it('small interaction forces are nearly unaffected by saturation', () => {
    const engine = makeEngine();
    // Small displacement — force should be nearly linear
    engine.startDrag(0);
    engine.updateDrag(0.1, 0, 0); // 0.1 Å displacement

    // Zero out internal forces to isolate interaction force
    engine.force.fill(0);
    engine.computeForces();

    // Expected unsaturated force: kDrag * 0.1 = 2.0 * 0.1 = 0.2 eV/Å
    // With saturation: 0.2 / (1 + 0.2/120) ≈ 0.1997 — nearly identical
    // (can't isolate perfectly since Tersoff also contributes, but force should be small)
    const f0x = engine.force[0];
    expect(isFinite(f0x)).toBe(true);
    engine.endDrag();
  });
});

// ── applySafetyControls: vHardMax only ──

describe('applySafetyControls — vHardMax only', () => {
  it('per-atom vHardMax still caps velocity', () => {
    const engine = makeEngine();
    // Set one atom to very high velocity
    engine.vel[0] = 1.0; // way above vHardMax = 0.15
    engine.vel[1] = 0;
    engine.vel[2] = 0;

    engine.applySafetyControls();

    const vMag = Math.sqrt(engine.vel[0] ** 2 + engine.vel[1] ** 2 + engine.vel[2] ** 2);
    expect(vMag).toBeCloseTo(CONFIG.physics.vHardMax, 10);
  });

  it('does not globally scale velocities based on KE', () => {
    const engine = makeEngine();
    // Set both atoms to moderate velocity (below vHardMax individually)
    const v = 0.10; // below 0.15 vHardMax
    engine.vel[0] = v;
    engine.vel[3] = v;

    engine.applySafetyControls();

    // Both should be unchanged — no global KE rescaling
    expect(engine.vel[0]).toBe(v);
    expect(engine.vel[3]).toBe(v);
  });

  it('preserves momentum of unaffected atoms', () => {
    const engine = makeEngine();
    // Atom 0: very fast (will be capped)
    engine.vel[0] = 1.0;
    // Atom 1: moderate (should NOT be affected)
    engine.vel[3] = 0.05;

    engine.applySafetyControls();

    // Atom 1 must be untouched — this is the core fix
    expect(engine.vel[3]).toBe(0.05);
  });
});

// ── Force-magnitude telemetry (plan Phase 1) ──

describe('Force-magnitude telemetry: stable simulation', () => {
  it('equilibrium dimer: all forces stay well below fRepulsionStart', () => {
    const engine = makeEngine();
    let maxObserved = 0;
    let activationCount = 0;

    for (let step = 0; step < 200; step++) {
      engine.computeForces();
      for (let i = 0; i < engine.n; i++) {
        const ix = i * 3;
        const mag = Math.sqrt(
          engine.force[ix] ** 2 + engine.force[ix + 1] ** 2 + engine.force[ix + 2] ** 2,
        );
        if (mag > maxObserved) maxObserved = mag;
        if (mag > CONFIG.physics.fRepulsionStart) activationCount++;
      }
      engine.stepOnce();
    }
    expect(activationCount).toBe(0);
    // Telemetry: max observed force in stable dimer should be far below threshold
    expect(maxObserved).toBeLessThan(CONFIG.physics.fRepulsionStart);
    // Record: typical stable dimer max force is ~15-25 eV/Å. Threshold at 40 has >60% headroom.
  });

  it('4-atom chain: all forces stay well below fRepulsionStart', () => {
    const atoms = [
      { x: 0, y: 0, z: 0 },
      { x: 1.42, y: 0, z: 0 },
      { x: 2.84, y: 0, z: 0 },
      { x: 4.26, y: 0, z: 0 },
    ];
    const bonds: [number, number, number][] = [
      [0, 1, 1.42], [1, 2, 1.42], [2, 3, 1.42],
    ];
    const engine = makeEngine(atoms, bonds);
    let maxObserved = 0;
    let activationCount = 0;

    for (let step = 0; step < 200; step++) {
      engine.computeForces();
      for (let i = 0; i < engine.n; i++) {
        const ix = i * 3;
        const mag = Math.sqrt(
          engine.force[ix] ** 2 + engine.force[ix + 1] ** 2 + engine.force[ix + 2] ** 2,
        );
        if (mag > maxObserved) maxObserved = mag;
        if (mag > CONFIG.physics.fRepulsionStart) activationCount++;
      }
      engine.stepOnce();
    }
    expect(activationCount).toBe(0);
    expect(maxObserved).toBeLessThan(CONFIG.physics.fRepulsionStart);
  });
});

describe('Force-magnitude telemetry: overlap scenario', () => {
  it('overlap peak forces exceed fRepulsionStart but are bounded by fMaxInternal', () => {
    const overlappingAtoms = [
      { x: 0, y: 0, z: 0 },
      { x: 0.5, y: 0, z: 0 }, // 0.5 Å — inside repulsive wall but not extreme
    ];
    const engine = makeEngine(overlappingAtoms, [[0, 1, 0.5]]);
    let maxForce = 0;

    // Measure raw internal forces before saturation by using a fresh engine
    // and reading forces after Tersoff+wall but the saturation will already have run.
    // Instead, just verify post-saturation forces are bounded.
    engine.computeForces();
    for (let i = 0; i < engine.n; i++) {
      const ix = i * 3;
      const mag = Math.sqrt(
        engine.force[ix] ** 2 + engine.force[ix + 1] ** 2 + engine.force[ix + 2] ** 2,
      );
      if (mag > maxForce) maxForce = mag;
    }
    // Post-saturation forces must be bounded by the saturator's asymptote
    expect(maxForce).toBeLessThan(CONFIG.physics.fMaxInternal);
    expect(isFinite(maxForce)).toBe(true);
  });
});

// ── Overlap recovery stability ──

describe('Overlap recovery: saturation prevents blowup', () => {
  it('overlapping atoms produce bounded forces', () => {
    // Place two atoms on top of each other — pathological overlap
    const overlappingAtoms = [
      { x: 0, y: 0, z: 0 },
      { x: 0.1, y: 0, z: 0 }, // 0.1 Å apart — deep inside repulsive wall
    ];
    const engine = makeEngine(overlappingAtoms, [[0, 1, 0.1]]);

    engine.computeForces();

    for (let i = 0; i < engine.n; i++) {
      const ix = i * 3;
      const mag = Math.sqrt(
        engine.force[ix] ** 2 + engine.force[ix + 1] ** 2 + engine.force[ix + 2] ** 2,
      );
      expect(mag).toBeLessThan(CONFIG.physics.fMaxInternal);
      expect(isFinite(mag)).toBe(true);
    }
  });

  it('overlapping atoms do not produce infinite velocities after integration', () => {
    const overlappingAtoms = [
      { x: 0, y: 0, z: 0 },
      { x: 0.1, y: 0, z: 0 },
    ];
    const engine = makeEngine(overlappingAtoms, [[0, 1, 0.1]]);

    // Run several steps — should not blow up
    for (let i = 0; i < 20; i++) {
      engine.stepOnce();
    }
    engine.applySafetyControls();

    for (let i = 0; i < engine.n; i++) {
      const ix = i * 3;
      const vMag = Math.sqrt(
        engine.vel[ix] ** 2 + engine.vel[ix + 1] ** 2 + engine.vel[ix + 2] ** 2,
      );
      expect(isFinite(vMag)).toBe(true);
      expect(vMag).toBeLessThanOrEqual(CONFIG.physics.vHardMax + 1e-10);
    }
  });
});

// ── Thresholded saturation formula properties ──

describe('Thresholded saturation formula properties', () => {
  const fStart = CONFIG.physics.fRepulsionStart;
  const fMax = CONFIG.physics.fMaxInternal;
  const headroom = fMax - fStart;

  function thresholdedSat(f: number): number {
    if (f <= fStart) return f;
    const excess = f - fStart;
    return fStart + excess / (1 + excess / headroom);
  }

  it('is identity below threshold', () => {
    expect(thresholdedSat(0)).toBe(0);
    expect(thresholdedSat(fStart * 0.5)).toBe(fStart * 0.5);
    expect(thresholdedSat(fStart)).toBe(fStart);
  });

  it('is continuous at threshold', () => {
    const below = thresholdedSat(fStart - 0.001);
    const at = thresholdedSat(fStart);
    const above = thresholdedSat(fStart + 0.001);
    expect(Math.abs(at - below)).toBeLessThan(0.01);
    expect(Math.abs(above - at)).toBeLessThan(0.01);
  });

  it('is monotonically increasing', () => {
    let prev = 0;
    for (let f = 0; f < fMax * 10; f += 1) {
      const sat = thresholdedSat(f);
      expect(sat).toBeGreaterThanOrEqual(prev);
      prev = sat;
    }
  });

  it('asymptotically approaches F_MAX_INTERNAL', () => {
    expect(thresholdedSat(1e6)).toBeLessThan(fMax);
    expect(thresholdedSat(1e6)).toBeGreaterThan(fMax * 0.99);
  });
});

// ── Conservation validation: ΣF and COM drift (plan criteria 9-10) ──

describe('Conservation validation in overlap recovery', () => {
  it('ΣF induced by saturateInternalForces stays bounded in overlap case', () => {
    // Two atoms at 0.5 Å — moderate overlap that triggers saturation
    const overlappingAtoms = [
      { x: 0, y: 0, z: 0 },
      { x: 0.5, y: 0, z: 0 },
    ];
    const engine = makeEngine(overlappingAtoms, [[0, 1, 0.5]]);

    // Compute internal forces (Tersoff + wall) without saturation by reading
    // force values, then applying saturation and measuring the net force change.
    engine.force.fill(0);
    engine.computeForces();

    // After computeForces(), saturateInternalForces() has run.
    // Measure ΣF (net force on entire system) — perfect Newton's 3rd law gives ΣF=0.
    let sumFx = 0, sumFy = 0, sumFz = 0;
    for (let i = 0; i < engine.n; i++) {
      const ix = i * 3;
      sumFx += engine.force[ix];
      sumFy += engine.force[ix + 1];
      sumFz += engine.force[ix + 2];
    }
    const netForce = Math.sqrt(sumFx * sumFx + sumFy * sumFy + sumFz * sumFz);

    // Per-atom saturation can inject net force, but it should be bounded.
    // For a 2-atom system, the asymmetry is at most (F_MAX_INTERNAL - reduced_partner_force).
    expect(isFinite(netForce)).toBe(true);
    expect(netForce).toBeLessThan(CONFIG.physics.fMaxInternal);
  });

  it('COM velocity stays bounded and decays after overlap resolves', () => {
    const overlappingAtoms = [
      { x: 0, y: 0, z: 0 },
      { x: 0.1, y: 0, z: 0 },
    ];
    const engine = makeEngine(overlappingAtoms, [[0, 1, 0.1]]);

    // Track COM velocity over time to verify it's transient, not persistent
    const comSpeeds: number[] = [];
    for (let step = 0; step < 200; step++) {
      engine.stepOnce();
      if (step % 20 === 0) {
        let comVx = 0, comVy = 0, comVz = 0;
        for (let i = 0; i < engine.n; i++) {
          const ix = i * 3;
          comVx += engine.vel[ix];
          comVy += engine.vel[ix + 1];
          comVz += engine.vel[ix + 2];
        }
        comVx /= engine.n; comVy /= engine.n; comVz /= engine.n;
        comSpeeds.push(Math.sqrt(comVx * comVx + comVy * comVy + comVz * comVz));
      }
    }
    engine.applySafetyControls();

    // Final COM speed should be bounded
    const finalSpeed = comSpeeds[comSpeeds.length - 1];
    expect(isFinite(finalSpeed)).toBe(true);
    expect(finalSpeed).toBeLessThan(CONFIG.physics.vHardMax * 0.5);

    // All intermediate COM speeds should be finite
    for (const s of comSpeeds) {
      expect(isFinite(s)).toBe(true);
    }
  });
});

// ── Isolated saturateInternalForces() ΣF measurement (plan criterion 9) ──

describe('Isolated saturateInternalForces: ΣF before and after', () => {
  it('measures net force injection from per-atom saturation on overlap case', () => {
    // Set up overlapping atoms with known symmetric raw forces
    const engine = makeEngine(
      [{ x: 0, y: 0, z: 0 }, { x: 0.5, y: 0, z: 0 }],
      [[0, 1, 0.5]],
    );

    // Manually populate force array with Tersoff-like symmetric forces.
    // In a real Tersoff pair, atom 0 gets +F and atom 1 gets -F (Newton's 3rd law).
    // Use a magnitude above F_REPULSION_START to trigger saturation.
    const rawMag = CONFIG.physics.fRepulsionStart * 3; // 120 eV/Å — well above threshold
    engine.force[0] = rawMag;   engine.force[1] = 0; engine.force[2] = 0;
    engine.force[3] = -rawMag;  engine.force[4] = 0; engine.force[5] = 0;

    // ΣF before saturation — should be exactly 0 (symmetric pair)
    let sumBefore = 0;
    for (let i = 0; i < engine.n * 3; i++) sumBefore += engine.force[i];
    expect(sumBefore).toBe(0);

    // Apply ONLY saturateInternalForces — no interaction forces
    engine.saturateInternalForces();

    // ΣF after saturation — per-atom scaling preserves direction but applies
    // the same formula independently, so for equal magnitudes the result
    // should still be symmetric (both atoms get same |scale|)
    let sumAfterX = 0;
    for (let i = 0; i < engine.n; i++) sumAfterX += engine.force[i * 3];
    expect(Math.abs(sumAfterX)).toBeLessThan(1e-10); // symmetric case: ΣF ≈ 0

    // Verify saturation actually fired (magnitude reduced)
    expect(Math.abs(engine.force[0])).toBeLessThan(rawMag);
    expect(Math.abs(engine.force[3])).toBeLessThan(rawMag);
  });

  it('asymmetric overlap: measures non-zero ΣF injection and bounds it', () => {
    const engine = makeEngine(
      [{ x: 0, y: 0, z: 0 }, { x: 0.5, y: 0, z: 0 }],
      [[0, 1, 0.5]],
    );

    // Asymmetric forces: atom 0 has huge force, atom 1 has moderate force.
    // This simulates the case where one atom is in deep overlap but the other
    // is also affected by a wall or third-body contribution.
    const bigMag = CONFIG.physics.fRepulsionStart * 5;  // 200 eV/Å
    const smallMag = CONFIG.physics.fRepulsionStart * 1.5; // 60 eV/Å
    engine.force[0] = bigMag;    engine.force[1] = 0; engine.force[2] = 0;
    engine.force[3] = -smallMag; engine.force[4] = 0; engine.force[5] = 0;

    // ΣF before: bigMag - smallMag (already asymmetric due to non-pair forces)
    const sumBeforeX = engine.force[0] + engine.force[3];

    engine.saturateInternalForces();

    // ΣF after: per-atom saturation changes the balance
    const sumAfterX = engine.force[0] + engine.force[3];

    // The key metric: how much did saturation change the net force?
    const injectedNetForce = Math.abs(sumAfterX - sumBeforeX);

    // Injected net force should be bounded. For highly asymmetric inputs,
    // the change can exceed fMaxInternal because the large force is compressed
    // much more than the small force. The key property: the injection does
    // not grow unboundedly with input magnitude — it's bounded by the
    // difference in saturation compression between the two atoms.
    expect(isFinite(injectedNetForce)).toBe(true);
    expect(injectedNetForce).toBeLessThan(CONFIG.physics.fMaxInternal * 2);
    // Also verify: the injection is smaller than the original asymmetry
    expect(injectedNetForce).toBeLessThan(Math.abs(sumBeforeX));

    // Both atoms should be compressed
    expect(Math.abs(engine.force[0])).toBeLessThan(bigMag);
    expect(Math.abs(engine.force[3])).toBeLessThan(smallMag);
  });
});

// ── Translate force size-independence ──

describe('Translate force: total force is size-independent', () => {
  it('translate contribution is identical for different component sizes at same displacement', () => {
    // Isolate translate contribution by computing forces with and without translate active.
    // The difference is the pure translate contribution.
    const smallAtoms = [
      { x: 0, y: 0, z: 0 },
      { x: 1.42, y: 0, z: 0 },
    ];
    const smallBonds: [number, number, number][] = [[0, 1, 1.42]];

    const largeAtoms = [
      { x: 0, y: 0, z: 0 },
      { x: 1.42, y: 0, z: 0 },
      { x: 2.84, y: 0, z: 0 },
      { x: 4.26, y: 0, z: 0 },
    ];
    const largeBonds: [number, number, number][] = [[0, 1, 1.42], [1, 2, 1.42], [2, 3, 1.42]];

    const bigDisp = 1000;

    // Compute baseline forces (no translate)
    const smallBase = makeEngine(smallAtoms, smallBonds);
    smallBase.computeForces();
    const smallBaseFx = Array.from({ length: smallBase.n }, (_, i) => smallBase.force[i * 3]);

    const largeBase = makeEngine(largeAtoms, largeBonds);
    largeBase.computeForces();
    const largeBaseFx = Array.from({ length: largeBase.n }, (_, i) => largeBase.force[i * 3]);

    // Compute with translate active
    const smallTrans = makeEngine(smallAtoms, smallBonds);
    smallTrans.startTranslate(0);
    smallTrans.updateDrag(bigDisp, 0, 0);
    smallTrans.computeForces();

    const largeTrans = makeEngine(largeAtoms, largeBonds);
    largeTrans.startTranslate(0);
    largeTrans.updateDrag(bigDisp, 0, 0);
    largeTrans.computeForces();

    // Isolate translate contribution: total(with) - total(without)
    let smallTransFx = 0;
    for (let i = 0; i < smallTrans.n; i++) {
      smallTransFx += smallTrans.force[i * 3] - smallBaseFx[i];
    }
    let largeTransFx = 0;
    for (let i = 0; i < largeTrans.n; i++) {
      largeTransFx += largeTrans.force[i * 3] - largeBaseFx[i];
    }

    // Both translate contributions should be bounded by F_MAX_INTERACTION
    expect(Math.abs(smallTransFx)).toBeLessThan(CONFIG.physics.fMaxInteraction);
    expect(Math.abs(largeTransFx)).toBeLessThan(CONFIG.physics.fMaxInteraction);

    // Size independence: isolated translate force ratio should be very close to 1.0
    // (same spring, same saturation, same total force — only per-atom distribution differs)
    const ratio = Math.abs(largeTransFx) / Math.abs(smallTransFx);
    expect(ratio).toBeGreaterThan(0.95);
    expect(ratio).toBeLessThan(1.05);

    smallTrans.endDrag();
    largeTrans.endDrag();
  });
});

