/**
 * Structural tests for the renderer append split:
 *   ensureCapacityForAppend() + populateAppendedAtoms()
 *
 * The Renderer class requires Three.js + a DOM canvas, which vitest
 * cannot provide without heavy mocking.  These tests verify at the
 * type/export level that the two-phase API exists and has the expected
 * signatures, so regressions in the public contract are caught early.
 */
import { describe, it, expect } from 'vitest';

// We can statically import the module — vitest will resolve TS imports.
// Three.js side-effects (WebGL context) only fire on `new Renderer(...)`,
// not on import, so this is safe.

describe('Renderer append API (structural)', () => {
  it('Renderer module exports a class with ensureCapacityForAppend', async () => {
    // Dynamic import to keep the test isolated
    const mod = await import('../../page/js/renderer');
    expect(mod.Renderer).toBeDefined();
    expect(typeof mod.Renderer.prototype.ensureCapacityForAppend).toBe('function');
  });

  it('ensureCapacityForAppend accepts a single number argument', async () => {
    const mod = await import('../../page/js/renderer');
    // .length reflects the declared parameter count
    expect(mod.Renderer.prototype.ensureCapacityForAppend.length).toBe(1);
  });

  it('Renderer module exports populateAppendedAtoms', async () => {
    const mod = await import('../../page/js/renderer');
    expect(typeof mod.Renderer.prototype.populateAppendedAtoms).toBe('function');
  });

  it('populateAppendedAtoms accepts two arguments (atoms[], offsetStart)', async () => {
    const mod = await import('../../page/js/renderer');
    expect(mod.Renderer.prototype.populateAppendedAtoms.length).toBe(2);
  });
});
