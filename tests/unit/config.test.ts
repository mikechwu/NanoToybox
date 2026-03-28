/**
 * Unit tests for CONFIG — guard tests for tuning values.
 *
 * E.1 plan item: config.test.ts
 * Validates config shape, types, and reasonable ranges to catch
 * accidental misconfiguration that could break physics or rendering.
 */
import { describe, it, expect } from 'vitest';
import { CONFIG, DEFAULT_THEME } from '../../page/js/config';
describe('default theme', () => {
  it('DEFAULT_THEME constant is light', () => {
    expect(DEFAULT_THEME).toBe('light');
  });
});

describe('CONFIG structure', () => {
  it('has all required top-level sections', () => {
    expect(CONFIG).toHaveProperty('bonds');
    expect(CONFIG).toHaveProperty('atoms');
    expect(CONFIG).toHaveProperty('bondMesh');
    expect(CONFIG).toHaveProperty('atomMaterial');
    expect(CONFIG).toHaveProperty('bondMaterial');
    expect(CONFIG).toHaveProperty('picker');
    expect(CONFIG).toHaveProperty('physics');
    expect(CONFIG).toHaveProperty('wall');
    expect(CONFIG).toHaveProperty('playback');
  });
});

describe('CONFIG.bondMesh', () => {
  it('bond radius is thicker than the original default for visible curvature', () => {
    // Original was 0.07 — current target should be meaningfully larger
    expect(CONFIG.bondMesh.radius).toBeGreaterThan(0.1);
    expect(CONFIG.bondMesh.radius).toBeLessThan(0.2);
  });
});

describe('CONFIG.atomMaterial / bondMaterial', () => {
  it('bonds are smoother than atoms', () => {
    expect(CONFIG.bondMaterial.roughness).toBeLessThan(CONFIG.atomMaterial.roughness);
  });
});

describe('CONFIG.bonds', () => {
  it('cutoff > minDist (bonds must be longer than overlap threshold)', () => {
    expect(CONFIG.bonds.cutoff).toBeGreaterThan(CONFIG.bonds.minDist);
  });

  it('visibilityCutoff >= cutoff (visible range includes bond range)', () => {
    expect(CONFIG.bonds.visibilityCutoff).toBeGreaterThanOrEqual(CONFIG.bonds.cutoff);
  });

  it('all values are positive', () => {
    expect(CONFIG.bonds.cutoff).toBeGreaterThan(0);
    expect(CONFIG.bonds.minDist).toBeGreaterThan(0);
    expect(CONFIG.bonds.visibilityCutoff).toBeGreaterThan(0);
  });
});

describe('CONFIG.physics', () => {
  it('timestep is positive and reasonable', () => {
    expect(CONFIG.physics.dt).toBeGreaterThan(0);
    expect(CONFIG.physics.dt).toBeLessThan(10); // fs
  });

  it('stepsPerFrame is positive integer', () => {
    expect(CONFIG.physics.stepsPerFrame).toBeGreaterThan(0);
    expect(Number.isInteger(CONFIG.physics.stepsPerFrame)).toBe(true);
  });

  it('spring constants are positive', () => {
    expect(CONFIG.physics.kDragDefault).toBeGreaterThan(0);
    expect(CONFIG.physics.kRotateDefault).toBeGreaterThan(0);
  });

  it('velocity cap is positive', () => {
    expect(CONFIG.physics.vHardMax).toBeGreaterThan(0);
  });

  it('damping default is non-negative', () => {
    expect(CONFIG.physics.dampingDefault).toBeGreaterThanOrEqual(0);
    expect(CONFIG.physics.dampingDefault).toBeLessThan(1);
  });
});

describe('CONFIG.wall', () => {
  it('spring constant is positive', () => {
    expect(CONFIG.wall.springK).toBeGreaterThan(0);
  });

  it('density is positive', () => {
    expect(CONFIG.wall.density).toBeGreaterThan(0);
  });

  it('padding is positive', () => {
    expect(CONFIG.wall.padding).toBeGreaterThan(0);
  });
});

describe('CONFIG.playback', () => {
  it('baseStepsPerSecond is positive', () => {
    expect(CONFIG.playback.baseStepsPerSecond).toBeGreaterThan(0);
  });

  it('minSpeed <= defaultSpeed', () => {
    expect(CONFIG.playback.minSpeed).toBeLessThanOrEqual(CONFIG.playback.defaultSpeed);
  });

  it('defaultSpeed is positive', () => {
    expect(CONFIG.playback.defaultSpeed).toBeGreaterThan(0);
  });
});
