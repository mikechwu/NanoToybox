/**
 * @vitest-environment jsdom
 */
/**
 * Seed-identity cache invalidation + fail-closed click behavior for the
 * Lab-entry funnel.
 *
 * Originally written as a release-gate regression file. The
 * `REMIX_CURRENT_FRAME_UI_ENABLED` flag was removed after the
 * 2026-04-16 flip, so the P0 "gate-off invariants" block that used to
 * live here is gone. The remaining cases cover runtime invariants that
 * are still load-bearing:
 *   - P1 seed-identity cache: the cached href must null-out the
 *     moment ANY identity component changes (display frame, topology
 *     frame, restart frame, document). Without this, the user could
 *     click "From this frame" on a frame the href was minted for one
 *     scrub ago.
 *   - P2 fail-closed: `openLabFromCurrentFrame` must NOT fall back to
 *     plain Lab when the current frame isn't seedable. Plain Lab
 *     would silently lose the user's intent.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { HANDOFF_STORAGE_PREFIX } from '../../src/watch-lab-handoff/watch-lab-handoff-shared';

function clearHandoffKeys() {
  for (let i = localStorage.length - 1; i >= 0; i--) {
    const k = localStorage.key(i);
    if (k && k.startsWith(HANDOFF_STORAGE_PREFIX)) localStorage.removeItem(k);
  }
}

async function loadCapsule(controller: { openFile: (f: File) => Promise<void> }, positionsAt: number[][] = [
  [0, 0, 0, 1.4, 0, 0],
  [0, 0, 0, 1.401, 0, 0],
  [0, 0, 0, 1.402, 0, 0],
]): Promise<void> {
  const capsule = {
    format: 'atomdojo-history',
    version: 1,
    kind: 'capsule',
    producer: { app: 'lab', appVersion: 't', exportedAt: new Date().toISOString() },
    simulation: {
      units: { time: 'ps', length: 'angstrom' },
      maxAtomCount: 2,
      durationPs: (positionsAt.length - 1) * 0.001,
      frameCount: positionsAt.length,
      indexingModel: 'dense-prefix',
    },
    atoms: { atoms: [ { id: 0, element: 'C' }, { id: 1, element: 'C' } ] },
    bondPolicy: { policyId: 'default-carbon-v1', cutoff: 1.9, minDist: 1.1 },
    timeline: {
      denseFrames: positionsAt.map((positions, i) => ({
        frameId: i, timePs: i * 0.001, n: 2, atomIds: [0, 1], positions,
      })),
    },
  };
  const file = new File([JSON.stringify(capsule)], 'fixture.atomdojo', { type: 'application/json' });
  await controller.openFile(file);
}

describe('P1 — seed-identity cache key (tighter than displayFrameKey alone)', () => {
  beforeEach(() => {
    clearHandoffKeys();
  });

  it('projection nulls the cached href when the display frame changes', async () => {
    const mod = await import('../../watch/js/watch-controller');
    const controller = mod.createWatchController();
    try {
      await loadCapsule(controller);
      const href1 = controller.buildCurrentFrameLabHref();
      expect(href1).not.toBeNull();
      // Seek to a different time that resolves to a different display frame.
      controller.scrub(0.002); // last frame
      // Even though the cache still holds the prior token in memory,
      // the projection must surface null because the identity differs.
      expect(controller.getSnapshot().labCurrentFrameHref).toBeNull();
    } finally {
      controller.dispose();
    }
  });

  // Document-key change invalidation is covered in watch-lab-entry-href-cache.test.ts;
  // this file focuses on the frame/topology/restart-identity components that
  // the previous cache key missed.
});

describe('P2 — openLabFromCurrentFrame fails closed when remint fails', () => {
  beforeEach(() => clearHandoffKeys());

  it('does NOT fall back to plain Lab; surfaces a snapshot error instead', async () => {
    const openSpy = vi.fn(() => ({ focus: () => {} }) as unknown as Window);
    vi.stubGlobal('open', openSpy);
    try {
      const mod = await import('../../watch/js/watch-controller');
      // Reproduce: call openLabFromCurrentFrame BEFORE loading any
      // file — the controller cannot project a frame, cache is empty,
      // so the fail-closed branch fires.
      const c2 = mod.createWatchController();
      try {
        c2.openLabFromCurrentFrame();
        const snap = c2.getSnapshot();
        expect(snap.error).toBeTruthy();
        expect(snap.error).toMatch(/Couldn/i);
        // Must NOT have navigated (no plain-Lab fallback).
        expect(openSpy).not.toHaveBeenCalled();
      } finally {
        c2.dispose();
      }
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
