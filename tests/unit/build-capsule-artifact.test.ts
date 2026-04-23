/**
 * @vitest-environment jsdom
 *
 * Tests for the extracted `buildCapsuleArtifact` helper. Runs the
 * three guard checks (identity-stale / snapshot-version /
 * empty-frames) and the happy-path slice + validate + serialize flow
 * with fully stubbed deps — no subsystem, no store, no renderer.
 */
import { describe, it, expect, vi } from 'vitest';
import { buildCapsuleArtifact, type BuildCapsuleArtifactDeps } from '../../lab/js/runtime/build-capsule-artifact';
import { CapsuleSnapshotStaleError } from '../../lab/js/runtime/publish-errors';
import type { TimelineExportData } from '../../lab/js/runtime/timeline/history-export';

function makeFrame(frameId: number, timePs: number) {
  return {
    frameId,
    timePs,
    n: 2,
    atomIds: [0, 1],
    positions: new Float64Array(6),
    interaction: null,
    boundary: { shape: 'aabb', min: [0, 0, 0], max: [1, 1, 1] } as any,
  };
}

function makeSnapshot(count: number): TimelineExportData {
  return {
    denseFrames: Array.from({ length: count }, (_, i) => makeFrame(i, i * 0.1)),
    restartFrames: [],
    checkpoints: [],
  };
}

function makeDeps(overrides: Partial<BuildCapsuleArtifactDeps> = {}): BuildCapsuleArtifactDeps {
  const snapshot = makeSnapshot(4);
  return {
    isIdentityStale: () => false,
    getCapsuleExportInputVersion: () => 'v1:0:0:0',
    getTimelineExportSnapshot: () => snapshot,
    getAtomTable: () => [
      { id: 0, element: 'C' },
      { id: 1, element: 'C' },
    ],
    getColorAssignments: () => [],
    appVersion: '0.1.0',
    ...overrides,
  };
}

describe('buildCapsuleArtifact', () => {
  it('happy path — builds + validates + serializes a full-range artifact', () => {
    const artifact = buildCapsuleArtifact(makeDeps(), null);
    expect(artifact).not.toBeNull();
    expect(typeof artifact!.json).toBe('string');
    // JSON.length and TextEncoder.encode().byteLength should agree
    // for pure ASCII output.
    expect(artifact!.bytes).toBe(new TextEncoder().encode(artifact!.json).byteLength);
    // File envelope carries the expected format markers.
    expect(artifact!.file.format).toBe('atomdojo-history');
    expect(artifact!.file.kind).toBe('capsule');
  });

  it('returns null when the snapshot has zero frames and no range is supplied', () => {
    const empty = buildCapsuleArtifact(makeDeps({
      getTimelineExportSnapshot: () => ({ denseFrames: [], restartFrames: [], checkpoints: [] }),
    }), null);
    expect(empty).toBeNull();
  });

  it('throws on identity-stale before touching anything else', () => {
    const deps = makeDeps({ isIdentityStale: () => true });
    // The snapshot accessor must NEVER fire — identity-stale is the
    // earliest exit.
    const getSnapshot = vi.fn(() => makeSnapshot(4));
    expect(() => buildCapsuleArtifact({ ...deps, getTimelineExportSnapshot: getSnapshot }, null))
      .toThrow(/identity is stale/i);
    expect(getSnapshot).not.toHaveBeenCalled();
  });

  it('throws CapsuleSnapshotStaleError when range.snapshotId does not match current version', () => {
    const deps = makeDeps({
      getCapsuleExportInputVersion: () => 'v2:0:0:0', // current is v2
    });
    // Range was captured at v1 — user moved on before we built.
    expect(() => buildCapsuleArtifact(deps, {
      snapshotId: 'v1:0:0:0',
      startFrameIndex: 0,
      endFrameIndex: 2,
    })).toThrowError(CapsuleSnapshotStaleError);
  });

  it('throws CapsuleSnapshotStaleError when version matches but snapshot is empty (race with clear())', () => {
    // The version check passes — but between that call and
    // getTimelineExportSnapshot, a `clear()` ran. The builder must
    // NOT let sliceExportSnapshotToCapsuleFrameRange throw a generic
    // Error on empty frames; it must surface as CapsuleSnapshotStaleError
    // so the recoverable trim-abort path fires.
    const deps = makeDeps({
      getTimelineExportSnapshot: () => ({ denseFrames: [], restartFrames: [], checkpoints: [] }),
    });
    expect(() => buildCapsuleArtifact(deps, {
      snapshotId: 'v1:0:0:0',
      startFrameIndex: 0,
      endFrameIndex: 0,
    })).toThrowError(CapsuleSnapshotStaleError);
  });

  it('delegates range-bounds validation to the slice helper (end out of bounds)', () => {
    const deps = makeDeps(); // 4 frames
    expect(() => buildCapsuleArtifact(deps, {
      snapshotId: 'v1:0:0:0',
      startFrameIndex: 0,
      endFrameIndex: 99,
    })).toThrow(); // slice helper throws on out-of-bounds
  });

  it('slice-then-build ordering — the capsule builder only sees the sliced dense frames', () => {
    // Build for range [2, 3] of a 4-frame snapshot. The resulting
    // envelope's frame count must be 2 — proving the slice ran
    // before buildCapsuleHistoryFile.
    const artifact = buildCapsuleArtifact(makeDeps(), {
      snapshotId: 'v1:0:0:0',
      startFrameIndex: 2,
      endFrameIndex: 3,
    });
    expect(artifact).not.toBeNull();
    expect(artifact!.file.timeline.denseFrames).toHaveLength(2);
    expect(artifact!.file.timeline.denseFrames[0].frameId).toBe(2);
    expect(artifact!.file.timeline.denseFrames[1].frameId).toBe(3);
  });

  it('passes appVersion and atom table through to the envelope unchanged', () => {
    const atomTable = [
      { id: 0, element: 'N' },
      { id: 1, element: 'O' },
    ];
    const artifact = buildCapsuleArtifact(makeDeps({
      appVersion: '9.9.9-test',
      getAtomTable: () => atomTable,
    }), null);
    expect(artifact).not.toBeNull();
    expect(artifact!.file.producer.appVersion).toBe('9.9.9-test');
    expect(artifact!.file.atoms.atoms).toHaveLength(2);
    expect(artifact!.file.atoms.atoms[0].element).toBe('N');
  });
});
