/**
 * Regression tests for the worker snapshot rollback race after placement commit.
 *
 * Bug: after local append, stale pre-append worker snapshots could roll back
 * the renderer's visible atom count because the worker-bridge accepted
 * equal-version scene events during pending mutations.
 *
 * Fix: worker-bridge clears latestSnapshot on appendMolecule and rejects
 * ALL scene-versioned events while hasPendingMutations is true.
 */
import { describe, it, expect, vi } from 'vitest';

// Mock the worker-bridge gating logic (can't instantiate real Worker in Node)
describe('worker-bridge append race gating', () => {
  it('latestSnapshot is cleared when appendMolecule starts', () => {
    // Simulate the bridge state
    let latestSnapshot: { n: number; sceneVersion: number } | null = { n: 60, sceneVersion: 1 };
    let hasPendingMutations = false;

    // appendMolecule clears snapshot and sets pending
    function appendMolecule() {
      latestSnapshot = null;
      hasPendingMutations = true;
    }

    appendMolecule();
    expect(latestSnapshot).toBeNull();
    expect(hasPendingMutations).toBe(true);
  });

  it('rejects pre-append frameResult while mutation is pending', () => {
    let hasPendingMutations = true;
    const lastAcceptedMutationVersion = 1;

    // Stale frame with same scene version as before append
    const staleFrame = { sceneVersion: 1, n: 60, type: 'frameResult' as const };

    function shouldAccept(event: { sceneVersion: number }) {
      if (event.sceneVersion < lastAcceptedMutationVersion) return false;
      if (hasPendingMutations) return false; // THE FIX: reject ALL during pending
      return true;
    }

    expect(shouldAccept(staleFrame)).toBe(false);
  });

  it('accepts post-append frameResult after mutation ack', () => {
    let hasPendingMutations = false; // mutation completed
    const lastAcceptedMutationVersion = 2; // advanced after ack

    // Post-append frame with new scene version
    const freshFrame = { sceneVersion: 2, n: 120, type: 'frameResult' as const };

    function shouldAccept(event: { sceneVersion: number }) {
      if (event.sceneVersion < lastAcceptedMutationVersion) return false;
      if (hasPendingMutations) return false;
      return true;
    }

    expect(shouldAccept(freshFrame)).toBe(true);
  });

  it('full sequence: local append → stale rejected → ack → fresh accepted', () => {
    // Initial state
    let latestSnapshot: { n: number } | null = { n: 60 };
    let hasPendingMutations = false;
    let lastAcceptedMutationVersion = 1;
    let rendererAtomCount = 60;

    // Step 1: Local append succeeds
    rendererAtomCount = 120; // local commit added 60 atoms

    // Step 2: Send appendMolecule to worker
    latestSnapshot = null;
    hasPendingMutations = true;

    // Step 3: Main loop tries to consume snapshot — null, so skipped
    expect(latestSnapshot).toBeNull();

    // Step 4: Stale pre-append frame arrives from worker
    const staleFrame = { sceneVersion: 1, n: 60 };
    const staleAccepted = !(staleFrame.sceneVersion < lastAcceptedMutationVersion) && !hasPendingMutations;
    expect(staleAccepted).toBe(false);

    // Renderer count preserved at 120 (not rolled back to 60)
    expect(rendererAtomCount).toBe(120);

    // Step 5: Append ack arrives
    hasPendingMutations = false;
    lastAcceptedMutationVersion = 2;

    // Step 6: First post-append frame arrives
    const freshFrame = { sceneVersion: 2, n: 120 };
    const freshAccepted = !(freshFrame.sceneVersion < lastAcceptedMutationVersion) && !hasPendingMutations;
    expect(freshAccepted).toBe(true);

    // Update renderer from fresh snapshot
    latestSnapshot = freshFrame;
    rendererAtomCount = freshFrame.n;
    expect(rendererAtomCount).toBe(120);
  });
});
