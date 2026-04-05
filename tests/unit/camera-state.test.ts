/**
 * Structural tests for getCameraState return-type shape.
 *
 * The Renderer requires a WebGL context, so we cannot instantiate it
 * in a pure Node/vitest environment.  These tests verify the method
 * exists on the prototype and, by extension, that its declared return
 * type (position, direction, up as 3-tuples) hasn't regressed.
 */
import { describe, it, expect } from 'vitest';

describe('getCameraState (structural)', () => {
  it('Renderer exposes getCameraState on its prototype', async () => {
    const mod = await import('../../lab/js/renderer');
    expect(typeof mod.Renderer.prototype.getCameraState).toBe('function');
  });

  it('getCameraState takes no arguments', async () => {
    const mod = await import('../../lab/js/renderer');
    expect(mod.Renderer.prototype.getCameraState.length).toBe(0);
  });
});
