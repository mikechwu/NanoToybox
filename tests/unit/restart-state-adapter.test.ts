/**
 * Tests for the restart-state adapter.
 *
 * Verifies:
 *  - serializeForWorkerRestore captures correct physics state
 *  - applyRestartState restores all force-defining state
 */

import { describe, it, expect, vi } from 'vitest';
import { serializeForWorkerRestore, applyRestartState } from '../../lab/js/runtime/restart-state-adapter';
import type { RestartState } from '../../lab/js/runtime/simulation-timeline';

function makePhysics(n = 10) {
  const pos = new Float64Array(n * 3);
  const vel = new Float64Array(n * 3);
  for (let i = 0; i < pos.length; i++) { pos[i] = i * 0.1; vel[i] = i * 0.01; }
  return {
    n,
    pos,
    vel,
    dragAtom: -1,
    isRotateMode: false,
    isTranslateMode: false,
    activeComponent: -1,
    dragTarget: [0, 0, 0],
    getBonds: () => [[0, 1, 1.42], [1, 2, 1.42]],
    getDamping: () => 0.05,
    getDragStrength: () => 3,
    getRotateStrength: () => 7,
    getWallMode: () => 'contain',
    getWallRadius: () => 50,
    getBoundarySnapshot: () => ({
      mode: 'contain' as const, wallRadius: 50,
      wallCenter: [1, 2, 3] as [number, number, number],
      wallCenterSet: true, removedCount: 0, damping: 0.05,
    }),
    restoreCheckpoint: vi.fn(),
    restoreBoundarySnapshot: vi.fn(),
    setDamping: vi.fn(),
    setDragStrength: vi.fn(),
    setRotateStrength: vi.fn(),
    startDrag: vi.fn(),
    startTranslate: vi.fn(),
    startRotateDrag: vi.fn(),
    updateDrag: vi.fn(),
    endDrag: vi.fn(),
  } as any;
}

describe('serializeForWorkerRestore', () => {
  it('serializes positions from physics', () => {
    const physics = makePhysics(5);
    const payload = serializeForWorkerRestore(physics, () => ({
      dt: 0.5, dampingReferenceSteps: 4, damping: 0.05, kDrag: 3, kRotate: 7, wallMode: 'contain', useWasm: true,
    }));
    expect(payload.atoms.length).toBe(5);
    expect(payload.atoms[0].x).toBeCloseTo(0);
    expect(payload.atoms[1].x).toBeCloseTo(0.3);
  });

  it('serializes velocities', () => {
    const physics = makePhysics(3);
    const payload = serializeForWorkerRestore(physics, () => ({
      dt: 0.5, dampingReferenceSteps: 4, damping: 0, kDrag: 2, kRotate: 5, wallMode: 'contain', useWasm: true,
    }));
    expect(payload.velocities.length).toBe(9);
    expect(payload.velocities[0]).toBeCloseTo(0);
    expect(payload.velocities[1]).toBeCloseTo(0.01);
  });

  it('serializes bonds', () => {
    const physics = makePhysics();
    const payload = serializeForWorkerRestore(physics, () => ({
      dt: 0.5, dampingReferenceSteps: 4, damping: 0, kDrag: 2, kRotate: 5, wallMode: 'contain', useWasm: true,
    }));
    expect(payload.bonds).toEqual([[0, 1, 1.42], [1, 2, 1.42]]);
  });

  it('serializes boundary snapshot', () => {
    const physics = makePhysics();
    const payload = serializeForWorkerRestore(physics, () => ({
      dt: 0.5, dampingReferenceSteps: 4, damping: 0, kDrag: 2, kRotate: 5, wallMode: 'contain', useWasm: true,
    }));
    expect(payload.boundary.wallRadius).toBe(50);
    expect(payload.boundary.wallCenter).toEqual([1, 2, 3]);
  });

  it('does not include interaction (restart clears drag to prevent ghost forces)', () => {
    const physics = makePhysics();
    const payload = serializeForWorkerRestore(physics, () => ({
      dt: 0.5, dampingReferenceSteps: 4, damping: 0, kDrag: 2, kRotate: 5, wallMode: 'contain', useWasm: true,
    }));
    expect('interaction' in payload).toBe(false);
  });
});

describe('applyRestartState', () => {
  it('calls restoreCheckpoint with positions, velocities, bonds', () => {
    const physics = makePhysics();
    const rs: RestartState = {
      timePs: 500, n: 10,
      positions: new Float64Array(30),
      velocities: new Float64Array(30),
      bonds: [[0, 1, 1.5]],
      config: { damping: 0.1, kDrag: 4, kRotate: 8 },
      interaction: { kind: 'none' },
      boundary: { mode: 'contain', wallRadius: 60, wallCenter: [0, 0, 0], wallCenterSet: true, removedCount: 0, damping: 0.1 },
    };
    applyRestartState(physics, rs);
    expect(physics.restoreCheckpoint).toHaveBeenCalledTimes(1);
    const cpArg = physics.restoreCheckpoint.mock.calls[0][0];
    expect(cpArg.n).toBe(10);
    expect(cpArg.bonds).toEqual([[0, 1, 1.5]]);
  });

  it('restores boundary and coefficients', () => {
    const physics = makePhysics();
    const rs: RestartState = {
      timePs: 500, n: 10,
      positions: new Float64Array(30),
      velocities: new Float64Array(30),
      bonds: [],
      config: { damping: 0.1, kDrag: 4, kRotate: 8 },
      interaction: { kind: 'none' },
      boundary: { mode: 'remove', wallRadius: 60, wallCenter: [1, 2, 3], wallCenterSet: true, removedCount: 5, damping: 0.1 },
    };
    applyRestartState(physics, rs);
    expect(physics.restoreBoundarySnapshot).toHaveBeenCalledWith(rs.boundary);
    expect(physics.setDamping).toHaveBeenCalledWith(0.1);
    expect(physics.setDragStrength).toHaveBeenCalledWith(4);
    expect(physics.setRotateStrength).toHaveBeenCalledWith(8);
  });

  it('does NOT restore interaction state (prevents ghost forces)', () => {
    const physics = makePhysics();
    physics.dragAtom = 5; // simulate an active drag
    const rs: RestartState = {
      timePs: 500, n: 10,
      positions: new Float64Array(30),
      velocities: new Float64Array(30),
      bonds: [],
      config: { damping: 0, kDrag: 2, kRotate: 5 },
      interaction: { kind: 'atom_drag', atomIndex: 3, target: [1, 2, 3] },
      boundary: { mode: 'contain', wallRadius: 50, wallCenter: [0, 0, 0], wallCenterSet: true, removedCount: 0, damping: 0 },
    };
    applyRestartState(physics, rs);
    // Should NOT start a new drag
    expect(physics.startDrag).not.toHaveBeenCalled();
    // Should clear any existing drag to prevent phantom forces
    expect(physics.endDrag).toHaveBeenCalled();
  });
});
