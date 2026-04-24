/**
 * @vitest-environment jsdom
 */
/**
 * Tests for the mobile-only initial camera-fit distance multiplier.
 *
 * The renderer's `_fitCamera()` requires a live WebGL context and DOM canvas,
 * which we can't stand up under vitest without heavy mocking. So we test on
 * two surfaces:
 *
 *   1. CONFIG values exist and are within sensible bounds — locks the named
 *      constants the renderer reads from.
 *   2. A pure replica of the renderer's distance formula, exercised against
 *      `document.documentElement.dataset.deviceMode`. The replica mirrors
 *      lab/js/renderer.ts:_fitCamera exactly, so a regression in either side
 *      will surface here. A static-source check below pins the renderer to
 *      the same shape so the replica cannot drift silently.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { CONFIG } from '../../lab/js/config';

function computeFitDistance(maxR: number): number {
  const baseDist =
    maxR * CONFIG.camera.fitDistanceRadiusScale +
    CONFIG.camera.fitDistanceBaseOffset;
  const mode = document.documentElement.dataset.deviceMode;
  return (mode === 'phone' || mode === 'tablet')
    ? baseDist * CONFIG.camera.mobileFitDistanceMultiplier
    : baseDist;
}

describe('CONFIG.camera fit-distance constants', () => {
  it('exposes fitDistanceRadiusScale = 2.5 (matches prior hardcoded value)', () => {
    expect(CONFIG.camera.fitDistanceRadiusScale).toBe(2.5);
  });
  it('exposes fitDistanceBaseOffset = 5 (matches prior hardcoded value)', () => {
    expect(CONFIG.camera.fitDistanceBaseOffset).toBe(5);
  });
  it('exposes mobileFitDistanceMultiplier = 1.2', () => {
    expect(CONFIG.camera.mobileFitDistanceMultiplier).toBe(1.2);
  });
});

describe('_fitCamera distance formula (replica)', () => {
  beforeEach(() => {
    delete document.documentElement.dataset.deviceMode;
  });

  it('desktop distance equals maxR * 2.5 + 5 (unchanged from prior behavior)', () => {
    document.documentElement.dataset.deviceMode = 'desktop';
    expect(computeFitDistance(0)).toBeCloseTo(5, 10);
    expect(computeFitDistance(4)).toBeCloseTo(15, 10);
    expect(computeFitDistance(10)).toBeCloseTo(30, 10);
  });

  it('phone distance is desktop * 1.2', () => {
    document.documentElement.dataset.deviceMode = 'phone';
    const desktopBase = 4 * 2.5 + 5; // 15
    expect(computeFitDistance(4)).toBeCloseTo(desktopBase * 1.2, 10);
  });

  it('tablet distance is desktop * 1.2', () => {
    document.documentElement.dataset.deviceMode = 'tablet';
    const desktopBase = 4 * 2.5 + 5; // 15
    expect(computeFitDistance(4)).toBeCloseTo(desktopBase * 1.2, 10);
  });

  it('missing data-device-mode falls back to desktop framing (no multiplier)', () => {
    // First-paint window before main.ts runs updateDeviceMode().
    expect(computeFitDistance(4)).toBeCloseTo(15, 10);
  });
});

// Static check — pins renderer.ts:_fitCamera to the same shape the replica
// above models. If someone reverts the formula, edits the multiplier path,
// or removes the named constants, this fails loudly.
describe('renderer.ts _fitCamera shape', () => {
  const src = fs.readFileSync(
    path.resolve(__dirname, '../../lab/js/renderer.ts'),
    'utf8',
  );

  it('uses CONFIG.camera.fitDistanceRadiusScale', () => {
    expect(src).toContain('CONFIG.camera.fitDistanceRadiusScale');
  });
  it('uses CONFIG.camera.fitDistanceBaseOffset', () => {
    expect(src).toContain('CONFIG.camera.fitDistanceBaseOffset');
  });
  it('uses CONFIG.camera.mobileFitDistanceMultiplier', () => {
    expect(src).toContain('CONFIG.camera.mobileFitDistanceMultiplier');
  });
  it('keys mobile branch off document.documentElement.dataset.deviceMode', () => {
    expect(src).toContain('document.documentElement.dataset.deviceMode');
  });
  it('still writes the adjusted dist into _defaultCamPos for Reset view', () => {
    // The save block must use the same `dist` variable as the camera position
    // — this is the contract that keeps Reset view consistent with the
    // mobile-adjusted initial framing.
    expect(src).toMatch(/this\._defaultCamPos\.set\(cx, cy, cz \+ dist\)/);
  });
  it('does not retain the legacy hardcoded "maxR * 2.5 + 5" expression', () => {
    expect(src).not.toMatch(/maxR\s*\*\s*2\.5\s*\+\s*5/);
  });
});
