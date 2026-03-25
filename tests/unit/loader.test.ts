/**
 * Unit tests for loader — XYZ parsing and bond topology.
 *
 * E.1 plan item: loader.test.ts (XYZ parsing)
 * Tests pure functions: parseXYZ and buildBondTopology.
 */
import { describe, it, expect } from 'vitest';
import { parseXYZ, buildBondTopology } from '../../page/js/loader';

describe('parseXYZ', () => {
  it('parses a valid 2-atom XYZ string', () => {
    const xyz = `2
comment line
C  0.0  0.0  0.0
C  1.42 0.0  0.0`;
    const atoms = parseXYZ(xyz);
    expect(atoms).toHaveLength(2);
    expect(atoms[0]).toEqual({ element: 'C', x: 0.0, y: 0.0, z: 0.0 });
    expect(atoms[1]).toEqual({ element: 'C', x: 1.42, y: 0.0, z: 0.0 });
  });

  it('parses multi-line with extra whitespace', () => {
    const xyz = `  3
some comment
C   0.0   0.0   0.0
C   1.0   0.0   0.0
C   0.5   0.866 0.0
`;
    const atoms = parseXYZ(xyz);
    expect(atoms).toHaveLength(3);
    expect(atoms[2].x).toBeCloseTo(0.5);
    expect(atoms[2].y).toBeCloseTo(0.866);
  });

  it('returns empty array for empty input', () => {
    expect(parseXYZ('')).toEqual([]);
  });

  it('returns empty array for malformed input', () => {
    expect(parseXYZ('not a number\ngarbage')).toEqual([]);
  });

  it('parses first frame of multi-frame XYZ', () => {
    const xyz = `2
frame 1
C  0.0  0.0  0.0
C  1.0  0.0  0.0
2
frame 2
C  0.0  0.0  0.0
C  2.0  0.0  0.0`;
    const atoms = parseXYZ(xyz);
    expect(atoms).toHaveLength(2);
    // Should return first frame
    expect(atoms[1].x).toBeCloseTo(1.0);
  });

  it('handles single-atom structure', () => {
    const xyz = `1
single atom
C  3.14  2.72  1.0`;
    const atoms = parseXYZ(xyz);
    expect(atoms).toHaveLength(1);
    expect(atoms[0].element).toBe('C');
    expect(atoms[0].x).toBeCloseTo(3.14);
  });
});

describe('buildBondTopology', () => {
  it('finds bonds between close atoms', () => {
    const atoms = [
      { element: 'C', x: 0, y: 0, z: 0 },
      { element: 'C', x: 1.42, y: 0, z: 0 },
    ];
    const bonds = buildBondTopology(atoms, 1.8);
    expect(bonds).toHaveLength(1);
    expect(bonds[0][0]).toBe(0); // atom i
    expect(bonds[0][1]).toBe(1); // atom j
    expect(bonds[0][2]).toBeCloseTo(1.42); // distance
  });

  it('finds no bonds between distant atoms', () => {
    const atoms = [
      { element: 'C', x: 0, y: 0, z: 0 },
      { element: 'C', x: 5.0, y: 0, z: 0 },
    ];
    const bonds = buildBondTopology(atoms, 1.8);
    expect(bonds).toHaveLength(0);
  });

  it('finds all bonds in a triangle', () => {
    const d = 1.42;
    const atoms = [
      { element: 'C', x: 0, y: 0, z: 0 },
      { element: 'C', x: d, y: 0, z: 0 },
      { element: 'C', x: d / 2, y: d * Math.sqrt(3) / 2, z: 0 },
    ];
    const bonds = buildBondTopology(atoms, 1.8);
    expect(bonds).toHaveLength(3); // 3 edges in equilateral triangle
  });

  it('respects cutoff parameter', () => {
    const atoms = [
      { element: 'C', x: 0, y: 0, z: 0 },
      { element: 'C', x: 1.5, y: 0, z: 0 },
    ];
    expect(buildBondTopology(atoms, 1.4)).toHaveLength(0); // too far
    expect(buildBondTopology(atoms, 1.6)).toHaveLength(1); // within cutoff
  });

  it('returns empty for single atom', () => {
    const atoms = [{ element: 'C', x: 0, y: 0, z: 0 }];
    expect(buildBondTopology(atoms, 1.8)).toHaveLength(0);
  });

  it('returns empty for no atoms', () => {
    expect(buildBondTopology([], 1.8)).toHaveLength(0);
  });
});
