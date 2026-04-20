/**
 * Tests for src/share/capsule-preview-frame.ts — spec §capsule-preview-frame.
 *
 * Covers first-dense-frame extraction, atom-table resolution, color resolution,
 * and the failure modes the poster route maps into the `cause:` log taxonomy.
 */

import { describe, it, expect } from 'vitest';
import {
  buildPreviewSceneFromCapsule,
  PreviewSceneBuildException,
} from '../../src/share/capsule-preview-frame';
import type {
  AtomDojoPlaybackCapsuleFileV1,
} from '../../src/history/history-file-v1';

function makeCapsule(over: Partial<AtomDojoPlaybackCapsuleFileV1> = {}): AtomDojoPlaybackCapsuleFileV1 {
  return {
    format: 'atomdojo-history',
    version: 1,
    kind: 'capsule',
    producer: { app: 'lab', appVersion: '0.1.0', exportedAt: '2026-04-19T00:00:00Z' },
    simulation: {
      units: { time: 'ps', length: 'angstrom' },
      maxAtomCount: 2,
      durationPs: 1.0,
      frameCount: 1,
      indexingModel: 'dense-prefix',
    },
    atoms: { atoms: [
      { id: 0, element: 'C' },
      { id: 1, element: 'O' },
    ] },
    bondPolicy: { policyId: 'default-carbon-v1', cutoff: 1.85, minDist: 0.5 },
    timeline: {
      denseFrames: [
        { frameId: 0, timePs: 0, n: 2, atomIds: [0, 1], positions: [0, 0, 0, 1, 0, 0] },
      ],
    },
    ...over,
  };
}

describe('buildPreviewSceneFromCapsule', () => {
  it('extracts the first dense frame', () => {
    const scene = buildPreviewSceneFromCapsule(makeCapsule());
    expect(scene.frameId).toBe(0);
    expect(scene.atoms.length).toBe(2);
    expect(scene.atoms[0].atomId).toBe(0);
    expect(scene.atoms[0].element).toBe('C');
  });

  it('resolves element colors via the CPK table when no appearance section', () => {
    const scene = buildPreviewSceneFromCapsule(makeCapsule());
    // C = #222222, O = #ff0d0d per the CPK table
    expect(scene.atoms[0].colorHex).toBe('#222222');
    expect(scene.atoms[1].colorHex).toBe('#ff0d0d');
  });

  it('respects appearance.colorAssignments (per-group fan-out)', () => {
    const cap = makeCapsule({
      appearance: {
        colorAssignments: [
          { atomIds: [0, 1], colorHex: '#ff00ff' },
        ],
      },
    });
    const scene = buildPreviewSceneFromCapsule(cap);
    expect(scene.atoms[0].colorHex).toBe('#ff00ff');
    expect(scene.atoms[1].colorHex).toBe('#ff00ff');
  });

  it('computes bounds (min/max/center) from frame positions', () => {
    const scene = buildPreviewSceneFromCapsule(makeCapsule());
    expect(scene.bounds.min).toEqual([0, 0, 0]);
    expect(scene.bounds.max).toEqual([1, 0, 0]);
    expect(scene.bounds.center).toEqual([0.5, 0, 0]);
  });

  it('throws PreviewSceneBuildException when denseFrames is empty', () => {
    const cap = makeCapsule({
      timeline: { denseFrames: [] },
    });
    expect(() => buildPreviewSceneFromCapsule(cap)).toThrow(PreviewSceneBuildException);
    try {
      buildPreviewSceneFromCapsule(cap);
    } catch (err) {
      expect((err as PreviewSceneBuildException).cause.kind).toBe('no-dense-frames');
    }
  });

  it('throws invalid-positions when positions length != n*3', () => {
    const cap = makeCapsule();
    cap.timeline.denseFrames[0].positions = [0, 0];
    try {
      buildPreviewSceneFromCapsule(cap);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(PreviewSceneBuildException);
      expect((err as PreviewSceneBuildException).cause.kind).toBe('invalid-positions');
    }
  });

  it('silently drops atom IDs not in the atom table but keeps the valid ones', () => {
    const cap = makeCapsule();
    cap.timeline.denseFrames[0].atomIds = [0, 999];
    const scene = buildPreviewSceneFromCapsule(cap);
    expect(scene.atoms.length).toBe(1);
    expect(scene.atoms[0].atomId).toBe(0);
  });

  it('throws when every atom filters out', () => {
    const cap = makeCapsule();
    cap.timeline.denseFrames[0].atomIds = [999, 998];
    expect(() => buildPreviewSceneFromCapsule(cap)).toThrow(PreviewSceneBuildException);
  });
});
