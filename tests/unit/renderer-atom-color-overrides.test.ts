/**
 * Renderer-level tests for _applyAtomColorOverrides.
 *
 * Verifies the root-cause fix for authored color visibility:
 * - Material set to white when overrides active (neutral multiply)
 * - Per-instance colors carry the full albedo with HSL perceptual lift
 * - Material restored to theme color when overrides cleared
 * - Theme changes re-apply overrides correctly
 */
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { THEMES } from '../../lab/js/themes';
import { CONFIG } from '../../lab/js/config';

/** Build a fake renderer context with a real InstancedMesh for color testing. */
async function makeColorCtx(atomCount = 5, theme: 'dark' | 'light' = 'dark') {
  const { Renderer } = await import('../../lab/js/renderer');
  const proto = Renderer.prototype;
  const geom = new THREE.SphereGeometry(0.35, 4, 4);
  const atomMat = new THREE.MeshStandardMaterial({ color: THEMES[theme].atom });
  const mesh = new THREE.InstancedMesh(geom, atomMat, atomCount);

  const ctx: any = {
    _instancedAtoms: mesh,
    _atomMat: atomMat,
    _atomCount: atomCount,
    _atomColorOverrides: null,
    currentTheme: theme,
  };
  ctx._applyAtomColorOverrides = (proto as any)._applyAtomColorOverrides.bind(ctx);
  ctx.applyTheme = proto.applyTheme.bind(ctx);
  // Stubs for applyTheme's other paths
  ctx.scene = { background: null };
  ctx._applyLightTheme = () => {};
  ctx._bondMat = null;
  ctx._highlightMat = null;
  return { ctx, mesh, atomMat };
}

/** Read the per-instance color at index i. */
function readInstanceColor(mesh: THREE.InstancedMesh, i: number): THREE.Color {
  const c = new THREE.Color();
  if (mesh.instanceColor) {
    c.fromBufferAttribute(mesh.instanceColor, i);
  }
  return c;
}

describe('_applyAtomColorOverrides', () => {
  it('with overrides active, material color becomes white', async () => {
    const { ctx, atomMat } = await makeColorCtx();
    ctx._atomColorOverrides = { 0: { hex: '#ff5555' } };
    ctx._applyAtomColorOverrides();

    expect(atomMat.color.getHex()).toBe(0xffffff);
  });

  it('overridden atoms get HSL-lifted per-instance color', async () => {
    const { ctx, mesh } = await makeColorCtx();
    ctx._atomColorOverrides = { 0: { hex: '#ff5555' } };
    ctx._applyAtomColorOverrides();

    const c = readInstanceColor(mesh, 0);
    const hsl = { h: 0, s: 0, l: 0 };
    c.getHSL(hsl);
    expect(hsl.s).toBeGreaterThanOrEqual(CONFIG.atomColorOverride.minSaturation - 0.01);
    expect(hsl.l).toBeGreaterThanOrEqual(CONFIG.atomColorOverride.minLightness - 0.01);
  });

  it('non-overridden atoms receive theme atom color as instance color', async () => {
    const { ctx, mesh } = await makeColorCtx(3, 'dark');
    ctx._atomColorOverrides = { 0: { hex: '#33dd66' } };
    ctx._applyAtomColorOverrides();

    // Atom 1 has no override — should carry the theme default
    const c = readInstanceColor(mesh, 1);
    const expected = new THREE.Color(THEMES['dark'].atom);
    expect(c.r).toBeCloseTo(expected.r, 3);
    expect(c.g).toBeCloseTo(expected.g, 3);
    expect(c.b).toBeCloseTo(expected.b, 3);
  });

  it('clearing overrides restores material to theme atom color', async () => {
    const { ctx, atomMat } = await makeColorCtx(3, 'dark');
    // Apply then clear
    ctx._atomColorOverrides = { 0: { hex: '#ff5555' } };
    ctx._applyAtomColorOverrides();
    expect(atomMat.color.getHex()).toBe(0xffffff);

    ctx._atomColorOverrides = null;
    ctx._applyAtomColorOverrides();
    expect(atomMat.color.getHex()).toBe(THEMES['dark'].atom);
  });

  it('clearing overrides resets instance colors to white', async () => {
    const { ctx, mesh } = await makeColorCtx(3);
    ctx._atomColorOverrides = { 0: { hex: '#ff5555' } };
    ctx._applyAtomColorOverrides();

    ctx._atomColorOverrides = null;
    ctx._applyAtomColorOverrides();

    // All instance colors should be white (neutral multiply)
    const white = new THREE.Color(0xffffff);
    for (let i = 0; i < 3; i++) {
      const c = readInstanceColor(mesh, i);
      expect(c.r).toBeCloseTo(white.r, 3);
      expect(c.g).toBeCloseTo(white.g, 3);
      expect(c.b).toBeCloseTo(white.b, 3);
    }
  });

  it('override colors are visibly distinct from default atom color', async () => {
    const { ctx, mesh } = await makeColorCtx(3, 'dark');
    ctx._atomColorOverrides = { 0: { hex: '#55aaff' } };
    ctx._applyAtomColorOverrides();

    const overridden = readInstanceColor(mesh, 0);
    const defaultAtom = readInstanceColor(mesh, 1);

    // The override should have notably different RGB from default
    const diff = Math.abs(overridden.r - defaultAtom.r)
               + Math.abs(overridden.g - defaultAtom.g)
               + Math.abs(overridden.b - defaultAtom.b);
    expect(diff).toBeGreaterThan(0.3);
  });
});

describe('applyTheme with active overrides', () => {
  it('re-applies overrides after theme switch so material stays white', async () => {
    const { ctx, atomMat } = await makeColorCtx(3, 'dark');
    ctx._atomColorOverrides = { 0: { hex: '#ff5555' } };
    ctx._applyAtomColorOverrides();
    expect(atomMat.color.getHex()).toBe(0xffffff);

    // Switch theme
    ctx.applyTheme('light');

    // Material should still be white (re-applied overrides)
    expect(atomMat.color.getHex()).toBe(0xffffff);

    // Non-overridden atoms should now use light theme atom color
    const c = readInstanceColor(ctx._instancedAtoms, 1);
    const expected = new THREE.Color(THEMES['light'].atom);
    expect(c.r).toBeCloseTo(expected.r, 3);
    expect(c.g).toBeCloseTo(expected.g, 3);
    expect(c.b).toBeCloseTo(expected.b, 3);
  });
});

describe('atomColorOverride config contract', () => {
  it('minSaturation and minLightness are reasonable perceptual-lift values', () => {
    expect(CONFIG.atomColorOverride.minSaturation).toBeGreaterThanOrEqual(0.5);
    expect(CONFIG.atomColorOverride.minSaturation).toBeLessThanOrEqual(1.0);
    expect(CONFIG.atomColorOverride.minLightness).toBeGreaterThanOrEqual(0.4);
    expect(CONFIG.atomColorOverride.minLightness).toBeLessThanOrEqual(0.8);
  });
});
