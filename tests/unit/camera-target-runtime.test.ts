/**
 * Camera target resolution runtime tests.
 *
 * Tests generic target resolution for molecules and bonded groups,
 * default-target fallback, and target validity checking.
 */
import { describe, it, expect, vi } from 'vitest';
import * as THREE from 'three';
import {
  resolveCameraTargetRef,
  resolveBestDefaultCameraTarget,
  isCameraTargetRefValid,
  type CameraTargetDeps,
} from '../../lab/js/runtime/camera-target-runtime';

function makeDeps(overrides: Partial<CameraTargetDeps> = {}): CameraTargetDeps {
  return {
    renderer: {
      getDisplayedMoleculeBounds: vi.fn((offset: number, count: number) => ({
        center: new THREE.Vector3(offset, 0, 0),
        radius: 5,
      })),
      getDisplayedAtomWorldPosition: vi.fn((i: number) => new THREE.Vector3(i * 2, i, 0)),
      camera: { position: new THREE.Vector3(0, 0, 20) },
      getSceneRadius: () => 10,
    },
    molecules: [
      { id: 1, name: 'A', structureFile: 'a.xyz', atomCount: 60, atomOffset: 0 },
      { id: 2, name: 'B', structureFile: 'b.xyz', atomCount: 40, atomOffset: 60 },
    ],
    getBondedGroupAtoms: vi.fn(() => null),
    ...overrides,
  };
}

describe('resolveCameraTargetRef', () => {
  it('1: resolves molecule target to displayed bounds', () => {
    const deps = makeDeps();
    const result = resolveCameraTargetRef({ kind: 'molecule', moleculeId: 1 }, deps);

    expect(result).not.toBeNull();
    expect(result!.kind).toBe('molecule');
    expect(result!.moleculeId).toBe(1);
    expect(result!.center).toBeDefined();
    expect(result!.radius).toBeGreaterThan(0);
    expect(deps.renderer.getDisplayedMoleculeBounds).toHaveBeenCalledWith(0, 60);
  });

  it('2: resolves bonded-group target to centroid + radius from atom indices', () => {
    const deps = makeDeps({
      getBondedGroupAtoms: vi.fn(() => [0, 1, 2]),
    });
    const result = resolveCameraTargetRef({ kind: 'bonded-group', groupId: 'g1' }, deps);

    expect(result).not.toBeNull();
    expect(result!.kind).toBe('bonded-group');
    expect(result!.groupId).toBe('g1');
    expect(result!.center).toBeDefined();
    expect(result!.radius).toBeGreaterThan(0);
  });

  it('3: returns null for invalid bonded-group ID', () => {
    const deps = makeDeps({
      getBondedGroupAtoms: vi.fn(() => null),
    });
    const result = resolveCameraTargetRef({ kind: 'bonded-group', groupId: 'nonexistent' }, deps);
    expect(result).toBeNull();
  });

  it('4: returns null when displayed atom positions are unavailable', () => {
    const deps = makeDeps({
      getBondedGroupAtoms: vi.fn(() => [0, 1]),
      renderer: {
        ...makeDeps().renderer,
        getDisplayedAtomWorldPosition: vi.fn(() => null),
      } as any,
    });
    const result = resolveCameraTargetRef({ kind: 'bonded-group', groupId: 'g1' }, deps);
    expect(result).toBeNull();
  });

  it('returns null for nonexistent molecule', () => {
    const deps = makeDeps();
    const result = resolveCameraTargetRef({ kind: 'molecule', moleculeId: 999 }, deps);
    expect(result).toBeNull();
  });
});

describe('resolveBestDefaultCameraTarget', () => {
  it('5: resolves default target to nearest molecule when no explicit target', () => {
    const deps = makeDeps();
    const ref = resolveBestDefaultCameraTarget(deps);
    expect(ref).not.toBeNull();
    expect(ref!.kind).toBe('molecule');
  });

  it('returns null when no molecules exist', () => {
    const deps = makeDeps({ molecules: [] });
    const ref = resolveBestDefaultCameraTarget(deps);
    expect(ref).toBeNull();
  });

  it('returns single molecule when only one exists', () => {
    const deps = makeDeps({
      molecules: [{ id: 5, name: 'X', structureFile: 'x.xyz', atomCount: 10, atomOffset: 0 }],
    });
    const ref = resolveBestDefaultCameraTarget(deps);
    expect(ref).toEqual({ kind: 'molecule', moleculeId: 5 });
  });
});

describe('isCameraTargetRefValid', () => {
  it('valid molecule ref', () => {
    const deps = makeDeps();
    expect(isCameraTargetRefValid({ kind: 'molecule', moleculeId: 1 }, deps)).toBe(true);
  });

  it('invalid molecule ref', () => {
    const deps = makeDeps();
    expect(isCameraTargetRefValid({ kind: 'molecule', moleculeId: 999 }, deps)).toBe(false);
  });

  it('valid bonded-group ref', () => {
    const deps = makeDeps({ getBondedGroupAtoms: vi.fn(() => [0, 1, 2]) });
    expect(isCameraTargetRefValid({ kind: 'bonded-group', groupId: 'g1' }, deps)).toBe(true);
  });

  it('invalid bonded-group ref', () => {
    const deps = makeDeps();
    expect(isCameraTargetRefValid({ kind: 'bonded-group', groupId: 'g1' }, deps)).toBe(false);
  });
});
