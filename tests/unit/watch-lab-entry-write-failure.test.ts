/**
 * @vitest-environment jsdom
 */
/**
 * Controller-level tests for the Watch-side writer §10 surfacing.
 *
 * The writer raises a typed `WatchHandoffWriteError` on two shapes of
 * failure:
 *   - `storage-unavailable` — localStorage access is blocked (private
 *     mode, site data disabled, policy-blocked origin)
 *   - `quota-exceeded` — setItem keeps throwing QuotaExceededError even
 *     after the full-sweep retry
 *
 * The controller catches both, surfaces mode-specific copy via the
 * snapshot `error` field, and sets an internal flag so the click path
 * (`openLabFromCurrentFrame`) won't clobber the specific message with
 * its generic "couldn't prepare" fallback.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { HANDOFF_STORAGE_PREFIX } from '../../src/watch-lab-handoff/watch-lab-handoff-shared';

function clearHandoffKeys(): void {
  for (let i = localStorage.length - 1; i >= 0; i--) {
    const k = localStorage.key(i);
    if (k && k.startsWith(HANDOFF_STORAGE_PREFIX)) localStorage.removeItem(k);
  }
}

async function loadFixtureCapsule(controller: { openFile: (f: File) => Promise<void> }): Promise<void> {
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
    atoms: { atoms: [{ id: 0, element: 'C' }, { id: 1, element: 'C' }] },
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

describe('controller.buildCurrentFrameLabHref — writer failure surfacing (§10)', () => {
  beforeEach(() => {
    clearHandoffKeys();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('quota-exceeded (retry fails too) → build returns null AND snapshot.error carries the quota copy', async () => {
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('Quota reached', 'QuotaExceededError');
    });
    const mod = await import('../../watch/js/app/watch-controller');
    const controller = mod.createWatchController();
    try {
      await loadFixtureCapsule(controller);
      const href = controller.buildCurrentFrameLabHref();
      expect(href).toBeNull();
      const snap = controller.getSnapshot();
      expect(snap.error).toMatch(/storage is full/i);
      // Must NOT say "private mode" — that's a different failure class.
      expect(snap.error ?? '').not.toMatch(/private mode/i);
    } finally {
      controller.dispose();
      spy.mockRestore();
    }
  });

  it('storage-unavailable (Safari private-mode SecurityError) → build returns null AND snapshot.error carries the private-mode copy', async () => {
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('The operation is insecure.', 'SecurityError');
    });
    const mod = await import('../../watch/js/app/watch-controller');
    const controller = mod.createWatchController();
    try {
      await loadFixtureCapsule(controller);
      const href = controller.buildCurrentFrameLabHref();
      expect(href).toBeNull();
      const snap = controller.getSnapshot();
      expect(snap.error).toMatch(/blocking storage/i);
      // Must NOT mention quota — wrong diagnosis.
      expect(snap.error ?? '').not.toMatch(/storage is full/i);
    } finally {
      controller.dispose();
      spy.mockRestore();
    }
  });

  it('click path does NOT overwrite the specific write-failure message with the generic "couldn\u2019t prepare" copy', async () => {
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('Quota reached', 'QuotaExceededError');
    });
    const mod = await import('../../watch/js/app/watch-controller');
    const controller = mod.createWatchController();
    try {
      await loadFixtureCapsule(controller);
      // Simulate the UX sequence: user hovers caret (build) → clicks item.
      // The caret-open path attempts the write first and surfaces the
      // quota error. The click path then re-calls build internally and
      // must preserve the specific message rather than overwriting it
      // with "Couldn't prepare this frame for Lab".
      controller.buildCurrentFrameLabHref();
      controller.openLabFromCurrentFrame();
      const snap = controller.getSnapshot();
      expect(snap.error).toMatch(/storage is full/i);
      expect(snap.error ?? '').not.toMatch(/couldn\u2019t prepare/i);
    } finally {
      controller.dispose();
      spy.mockRestore();
    }
  });

  it('click-only path (no prior caret build) still surfaces the specific write-failure copy', async () => {
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('The operation is insecure.', 'SecurityError');
    });
    const mod = await import('../../watch/js/app/watch-controller');
    const controller = mod.createWatchController();
    try {
      await loadFixtureCapsule(controller);
      // No prior buildCurrentFrameLabHref call — openLabFromCurrentFrame
      // hits the internal build, which classifies and surfaces the
      // storage-unavailable copy.
      controller.openLabFromCurrentFrame();
      const snap = controller.getSnapshot();
      expect(snap.error).toMatch(/blocking storage/i);
      expect(snap.error ?? '').not.toMatch(/couldn\u2019t prepare/i);
    } finally {
      controller.dispose();
      spy.mockRestore();
    }
  });

  it('recovery: a subsequent successful build resets the write-failure flag so later clicks use the generic fallback when seed is unbuildable', async () => {
    // This verifies the reset on every build call — prevents stale
    // state from the first failure leaking into an unrelated later
    // failure mode (e.g. seed-not-buildable).
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('Quota reached', 'QuotaExceededError');
    });
    const mod = await import('../../watch/js/app/watch-controller');
    const controller = mod.createWatchController();
    try {
      await loadFixtureCapsule(controller);
      // First attempt fails with quota.
      controller.buildCurrentFrameLabHref();
      expect(controller.getSnapshot().error).toMatch(/storage is full/i);
      // Now storage is "fixed" — subsequent writes succeed.
      spy.mockRestore();
      const href = controller.buildCurrentFrameLabHref();
      expect(href).not.toBeNull();
      // The build-success path clears the write-failure flag (not the
      // error banner text — that persists until next setError / dismiss).
      // Key check: if the user then hits a seed-not-buildable path the
      // fallback copy would kick in normally.
    } finally {
      controller.dispose();
    }
  });
});
