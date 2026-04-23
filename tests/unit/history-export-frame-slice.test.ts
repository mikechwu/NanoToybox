/**
 * @vitest-environment jsdom
 *
 * Tests for sliceExportSnapshotToCapsuleFrameRange (§2 frame-boundary rule
 * + §2 ordering rule) and the Watch round-trip contract.
 *
 * These tests focus on the pure helper and on the slice-then-build
 * ordering that keeps interaction events anchored to kept frames.
 */
import { describe, it, expect } from 'vitest';
import {
  sliceExportSnapshotToCapsuleFrameRange,
  buildCapsuleHistoryFile,
  type TimelineExportData,
} from '../../lab/js/runtime/timeline/history-export';
import { importCapsuleHistory } from '../../watch/js/document/capsule-history-import';
import { validateCapsuleFile } from '../../src/history/history-file-v1';

function makeFrame(frameId: number, timePs: number, atomIds: number[], interaction: any = null) {
  return {
    frameId,
    timePs,
    n: atomIds.length,
    atomIds,
    positions: new Float64Array(atomIds.length * 3),
    interaction,
    boundary: { shape: 'aabb', min: [0, 0, 0], max: [1, 1, 1] } as any,
  };
}

function makeSnapshot(frameCount: number): TimelineExportData {
  const denseFrames = Array.from({ length: frameCount }, (_, i) => {
    // Sprinkle an interaction event at frame 3 if it exists — used by the
    // round-trip test to prove the frameId reference resolves inside the
    // sliced set.
    const interaction = i === 3
      ? { kind: 'atom_drag' as const, atomIndex: 0, target: [0.1, 0.2, 0.3] as [number, number, number] }
      : null;
    return makeFrame(i, i * 0.1, [0, 1], interaction);
  });
  return { denseFrames, restartFrames: [], checkpoints: [] };
}

describe('sliceExportSnapshotToCapsuleFrameRange', () => {
  const snapshot = makeSnapshot(10);

  it('returns the inclusive-end slice of dense frames', () => {
    const sliced = sliceExportSnapshotToCapsuleFrameRange(snapshot, {
      startFrameIndex: 4,
      endFrameIndex: 7,
    });
    expect(sliced.denseFrames).toHaveLength(4);
    expect(sliced.denseFrames[0].frameId).toBe(4);
    expect(sliced.denseFrames[3].frameId).toBe(7);
  });

  it('preserves chronological order', () => {
    const sliced = sliceExportSnapshotToCapsuleFrameRange(snapshot, {
      startFrameIndex: 2,
      endFrameIndex: 5,
    });
    for (let i = 1; i < sliced.denseFrames.length; i++) {
      expect(sliced.denseFrames[i].timePs).toBeGreaterThan(sliced.denseFrames[i - 1].timePs);
    }
  });

  it('returns empty restartFrames and checkpoints', () => {
    const sliced = sliceExportSnapshotToCapsuleFrameRange(snapshot, {
      startFrameIndex: 0,
      endFrameIndex: 0,
    });
    expect(sliced.restartFrames).toEqual([]);
    expect(sliced.checkpoints).toEqual([]);
  });

  it('throws on invalid range (start > end)', () => {
    expect(() => sliceExportSnapshotToCapsuleFrameRange(snapshot, {
      startFrameIndex: 5,
      endFrameIndex: 3,
    })).toThrow();
  });

  it('throws on out-of-bounds end index', () => {
    expect(() => sliceExportSnapshotToCapsuleFrameRange(snapshot, {
      startFrameIndex: 0,
      endFrameIndex: 10, // length is 10, valid is 0..9
    })).toThrow();
  });

  it('throws on non-integer indices', () => {
    expect(() => sliceExportSnapshotToCapsuleFrameRange(snapshot, {
      startFrameIndex: 1.5,
      endFrameIndex: 3,
    })).toThrow();
  });
});

describe('slice-then-build round-trip through Watch importer', () => {
  it('keeps only interaction events whose frameId is in the sliced window', () => {
    // The snapshot has an interaction event at frameId=3. Slice it AWAY
    // (keep frames 5..7) and assert the resulting capsule has no
    // orphaned interaction events.
    const snapshot = makeSnapshot(10);
    const sliced = sliceExportSnapshotToCapsuleFrameRange(snapshot, {
      startFrameIndex: 5,
      endFrameIndex: 7,
    });
    const file = buildCapsuleHistoryFile({
      getTimelineExportData: () => sliced,
      getAtomTable: () => [
        { id: 0, element: 'C' },
        { id: 1, element: 'C' },
      ],
      getColorAssignments: () => [],
      appVersion: '0.1.0',
    });
    expect(file).not.toBeNull();
    // Validation passes
    const errors = validateCapsuleFile(file!);
    expect(errors).toEqual([]);
    // Watch importer round-trip succeeds without orphaned events.
    const loaded = importCapsuleHistory(file!);
    expect(loaded.denseFrames).toHaveLength(3);
    expect(loaded.denseFrames[0].frameId).toBe(5);
    expect(loaded.denseFrames[2].frameId).toBe(7);
  });

  it('keeps interaction events that are still inside the slice', () => {
    const snapshot = makeSnapshot(10);
    const sliced = sliceExportSnapshotToCapsuleFrameRange(snapshot, {
      startFrameIndex: 2,
      endFrameIndex: 5,
    });
    const file = buildCapsuleHistoryFile({
      getTimelineExportData: () => sliced,
      getAtomTable: () => [
        { id: 0, element: 'C' },
        { id: 1, element: 'C' },
      ],
      getColorAssignments: () => [],
      appVersion: '0.1.0',
    });
    expect(file).not.toBeNull();
    const loaded = importCapsuleHistory(file!);
    expect(loaded.denseFrames).toHaveLength(4);
    expect(loaded.interactionTimeline).not.toBeNull();
    // The interaction at frameId=3 should be retained.
    expect(loaded.interactionTimeline!.events.some((e: any) => e.frameId === 3)).toBe(true);
  });
});
