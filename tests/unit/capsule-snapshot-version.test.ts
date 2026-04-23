/**
 * @vitest-environment jsdom
 *
 * Tests for the capsule-export input version counters (§3a).
 *
 * Each counter must:
 *   - bump on writes that actually change the serialized-relevant
 *     representation
 *   - NOT bump on no-op writes (same content)
 *   - never reset (clear() / reset() bumps instead of resetting)
 */
import { describe, it, expect } from 'vitest';
import { createSimulationTimeline } from '../../lab/js/runtime/timeline/simulation-timeline';
import { createAtomMetadataRegistry } from '../../lab/js/runtime/timeline/atom-metadata-registry';

function recordable(timePs: number, n = 2) {
  return {
    timePs,
    n,
    atomIds: Array.from({ length: n }, (_, i) => i),
    positions: new Float64Array(n * 3),
    interaction: null,
    boundary: { shape: 'aabb', min: [0, 0, 0], max: [1, 1, 1] } as any,
  };
}

describe('SimulationTimeline.getCapsuleSnapshotVersion', () => {
  it('bumps on every recordFrame', () => {
    const t = createSimulationTimeline();
    const v0 = t.getCapsuleSnapshotVersion();
    t.recordFrame(recordable(0.1));
    const v1 = t.getCapsuleSnapshotVersion();
    expect(v1).toBeGreaterThan(v0);
    t.recordFrame(recordable(0.2));
    expect(t.getCapsuleSnapshotVersion()).toBeGreaterThan(v1);
  });

  it('does NOT bump on no-op truncateAfter past the latest frame', () => {
    const t = createSimulationTimeline();
    t.recordFrame(recordable(0.1));
    t.recordFrame(recordable(0.2));
    const v = t.getCapsuleSnapshotVersion();
    t.truncateAfter(99); // no frame has timePs > 99
    expect(t.getCapsuleSnapshotVersion()).toBe(v);
  });

  it('bumps on truncateAfter that removes frames', () => {
    const t = createSimulationTimeline();
    t.recordFrame(recordable(0.1));
    t.recordFrame(recordable(0.2));
    t.recordFrame(recordable(0.3));
    const v = t.getCapsuleSnapshotVersion();
    t.truncateAfter(0.15); // removes frames at 0.2 and 0.3
    expect(t.getCapsuleSnapshotVersion()).toBeGreaterThan(v);
  });

  it('bumps on clear() when frames were present; does not bump on empty clear()', () => {
    const t = createSimulationTimeline();
    const v0 = t.getCapsuleSnapshotVersion();
    t.clear(); // empty → no content change → no bump
    expect(t.getCapsuleSnapshotVersion()).toBe(v0);
    t.recordFrame(recordable(0.1));
    const v1 = t.getCapsuleSnapshotVersion();
    t.clear(); // had frames — bumps
    expect(t.getCapsuleSnapshotVersion()).toBeGreaterThan(v1);
  });

  it('never resets — even after clear the version keeps monotonically climbing', () => {
    const t = createSimulationTimeline();
    t.recordFrame(recordable(0.1));
    const afterRecord = t.getCapsuleSnapshotVersion();
    t.clear();
    const afterClear = t.getCapsuleSnapshotVersion();
    t.recordFrame(recordable(0.2));
    const afterSecondRecord = t.getCapsuleSnapshotVersion();
    expect(afterClear).toBeGreaterThan(afterRecord);
    expect(afterSecondRecord).toBeGreaterThan(afterClear);
  });
});

describe('AtomMetadataRegistry.getMetadataVersion', () => {
  it('bumps on registerAppendedAtoms with non-empty entries', () => {
    const r = createAtomMetadataRegistry();
    const v0 = r.getMetadataVersion();
    r.registerAppendedAtoms([0, 1], [{ element: 'C' }, { element: 'C' }]);
    expect(r.getMetadataVersion()).toBeGreaterThan(v0);
  });

  it('does NOT bump on empty registerAppendedAtoms', () => {
    const r = createAtomMetadataRegistry();
    const v0 = r.getMetadataVersion();
    r.registerAppendedAtoms([], []);
    expect(r.getMetadataVersion()).toBe(v0);
  });

  it('does NOT bump on restore when content is structurally identical', () => {
    const r = createAtomMetadataRegistry();
    r.registerAppendedAtoms([0, 1], [{ element: 'C' }, { element: 'H' }]);
    const snapshot = r.snapshot();
    const v = r.getMetadataVersion();
    // Restore the same content (different insertion order on purpose).
    r.restore([snapshot[1], snapshot[0]]);
    expect(r.getMetadataVersion()).toBe(v);
  });

  it('bumps on restore when the content differs', () => {
    const r = createAtomMetadataRegistry();
    r.registerAppendedAtoms([0, 1], [{ element: 'C' }, { element: 'H' }]);
    const v = r.getMetadataVersion();
    r.restore([{ id: 0, element: 'C' }, { id: 2, element: 'N' }]);
    expect(r.getMetadataVersion()).toBeGreaterThan(v);
  });

  it('bumps on reset when non-empty, does not bump on empty reset', () => {
    const r = createAtomMetadataRegistry();
    const v0 = r.getMetadataVersion();
    r.reset();
    expect(r.getMetadataVersion()).toBe(v0);
    r.registerAppendedAtoms([0], [{ element: 'C' }]);
    const v1 = r.getMetadataVersion();
    r.reset();
    expect(r.getMetadataVersion()).toBeGreaterThan(v1);
  });
});
