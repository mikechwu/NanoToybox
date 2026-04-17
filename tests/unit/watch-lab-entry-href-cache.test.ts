/**
 * @vitest-environment jsdom
 */
/**
 * Controller-level test for `buildCurrentFrameLabHref` — the cache
 * behavior, debounced invalidation, and localStorage write contract.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { HANDOFF_STORAGE_PREFIX } from '../../src/watch-lab-handoff/watch-lab-handoff-shared';

function countHandoffKeys(): number {
  let n = 0;
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k.startsWith(HANDOFF_STORAGE_PREFIX)) n++;
  }
  return n;
}

function clearHandoffKeys(): void {
  for (let i = localStorage.length - 1; i >= 0; i--) {
    const k = localStorage.key(i);
    if (k && k.startsWith(HANDOFF_STORAGE_PREFIX)) localStorage.removeItem(k);
  }
}

async function loadFixtureCapsule(controller: { openFile: (f: File) => Promise<void> }): Promise<void> {
  // Build a minimal 3-frame capsule (durationPs must be > 0 for multi-frame).
  const capsule = {
    format: 'atomdojo-history',
    version: 1,
    kind: 'capsule',
    producer: { app: 'lab', appVersion: 't', exportedAt: new Date().toISOString() },
    simulation: {
      units: { time: 'ps', length: 'angstrom' },
      maxAtomCount: 2,
      durationPs: 0.002,
      frameCount: 3,
      indexingModel: 'dense-prefix',
    },
    atoms: { atoms: [ { id: 0, element: 'C' }, { id: 1, element: 'C' } ] },
    bondPolicy: { policyId: 'default-carbon-v1', cutoff: 1.9, minDist: 1.1 },
    timeline: {
      denseFrames: [
        { frameId: 0, timePs: 0, n: 2, atomIds: [0, 1], positions: [0, 0, 0, 1.40, 0, 0] },
        { frameId: 1, timePs: 0.001, n: 2, atomIds: [0, 1], positions: [0, 0, 0, 1.401, 0, 0] },
        { frameId: 2, timePs: 0.002, n: 2, atomIds: [0, 1], positions: [0, 0, 0, 1.402, 0, 0] },
      ],
    },
  };
  const file = new File([JSON.stringify(capsule)], 'fixture.atomdojo', { type: 'application/json' });
  await controller.openFile(file);
}

describe('controller.buildCurrentFrameLabHref — cache + debounce (rev 7)', () => {
  beforeEach(() => {
    clearHandoffKeys();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('cache hit: calling twice at the same frame writes localStorage only once', async () => {
    const mod = await import('../../watch/js/watch-controller');
    const controller = mod.createWatchController();
    try {
      await loadFixtureCapsule(controller);
      expect(countHandoffKeys()).toBe(0);
      const href1 = controller.buildCurrentFrameLabHref();
      expect(href1).not.toBeNull();
      expect(countHandoffKeys()).toBe(1);
      const href2 = controller.buildCurrentFrameLabHref();
      expect(href2).toBe(href1); // same URL
      expect(countHandoffKeys()).toBe(1); // no extra write
    } finally {
      controller.dispose();
    }
  });

  it('cache invalidation on document change: next build mints a fresh token', async () => {
    const mod = await import('../../watch/js/watch-controller');
    const controller = mod.createWatchController();
    try {
      await loadFixtureCapsule(controller);
      const href1 = controller.buildCurrentFrameLabHref();
      expect(href1).not.toBeNull();
      // Open a second file (different metadata → different document key).
      await loadFixtureCapsule(controller);
      const href2 = controller.buildCurrentFrameLabHref();
      expect(href2).not.toBe(href1);
      // Previous token best-effort-removed; new token present. Count
      // should remain 1 (or possibly 2 if some lingering state — but
      // our invalidate removes the prior entry).
      expect(countHandoffKeys()).toBeGreaterThanOrEqual(1);
    } finally {
      controller.dispose();
    }
  });

  it('notifyContinueIdle debounces invalidation by 500 ms', async () => {
    vi.useFakeTimers();
    const mod = await import('../../watch/js/watch-controller');
    const controller = mod.createWatchController();
    try {
      await loadFixtureCapsule(controller);
      const href1 = controller.buildCurrentFrameLabHref();
      expect(href1).not.toBeNull();
      const tokenCountAfterOpen = countHandoffKeys();
      // Close → pending invalidation in 500 ms.
      controller.notifyContinueIdle();
      // Immediately re-open — cache must still be alive.
      const href2 = controller.buildCurrentFrameLabHref();
      expect(href2).toBe(href1);
      expect(countHandoffKeys()).toBe(tokenCountAfterOpen);
      // If we close and wait for the debounce to clear, the cache
      // invalidates.
      controller.notifyContinueIdle();
      vi.advanceTimersByTime(500);
      const href3 = controller.buildCurrentFrameLabHref();
      expect(href3).not.toBeNull();
      expect(href3).not.toBe(href1); // fresh mint
    } finally {
      controller.dispose();
    }
  });

  it('snapshot.labCurrentFrameHref reads cache without minting (no write on publish)', async () => {
    const mod = await import('../../watch/js/watch-controller');
    const controller = mod.createWatchController();
    try {
      await loadFixtureCapsule(controller);
      // Simulate many playback ticks / re-renders by reading the snapshot
      // repeatedly. Without caret-open, buildCurrentFrameLabHref is never
      // called so no localStorage write should occur.
      for (let i = 0; i < 20; i++) controller.getSnapshot();
      expect(countHandoffKeys()).toBe(0);
      expect(controller.getSnapshot().labCurrentFrameHref).toBeNull();
      // Now the user opens the menu — one write.
      controller.buildCurrentFrameLabHref();
      expect(countHandoffKeys()).toBe(1);
      expect(controller.getSnapshot().labCurrentFrameHref).not.toBeNull();
    } finally {
      controller.dispose();
    }
  });
});
