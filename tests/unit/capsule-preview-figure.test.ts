/**
 * Tests for src/share/capsule-preview-figure.ts (pure geometry).
 * Spec §2: deterministic, density-bucket-driven node count, framework-free.
 */

import { describe, it, expect } from 'vitest';
import { buildCapsulePreviewDescriptor } from '../../src/share/capsule-preview';
import {
  buildFigureGraph,
  FIGURE_DENSITY_NODE_COUNT,
} from '../../src/share/capsule-preview-figure';

describe('buildFigureGraph', () => {
  it('same descriptor → deep-equal node/link arrays', () => {
    const d = buildCapsulePreviewDescriptor({
      shareCode: '7M4K2D8Q9T1V',
      title: 't',
      kind: 'capsule',
      atomCount: 64,
      frameCount: 240,
    });
    expect(buildFigureGraph(d)).toEqual(buildFigureGraph(d));
  });

  it('density bucket → expected node count (low=6, medium=12, high=18)', () => {
    for (const [density, expected] of Object.entries(FIGURE_DENSITY_NODE_COUNT)) {
      const atomCount = density === 'low' ? 8 : density === 'medium' ? 64 : 1024;
      const d = buildCapsulePreviewDescriptor({
        shareCode: '7M4K2D8Q9T1V',
        title: null,
        kind: 'capsule',
        atomCount,
        frameCount: 10,
      });
      expect(buildFigureGraph(d).nodes.length).toBe(expected);
    }
  });

  it('node positions stay within the unit canvas', () => {
    const d = buildCapsulePreviewDescriptor({
      shareCode: '7M4K2D8Q9T1V',
      title: null,
      kind: 'capsule',
      atomCount: 1024,
      frameCount: 10,
    });
    for (const n of buildFigureGraph(d).nodes) {
      expect(n.x).toBeGreaterThanOrEqual(-0.05);
      expect(n.x).toBeLessThanOrEqual(1.05);
      expect(n.y).toBeGreaterThanOrEqual(-0.05);
      expect(n.y).toBeLessThanOrEqual(1.05);
    }
  });

  it('neutral-brand variant produces no edges', () => {
    const d = buildCapsulePreviewDescriptor({
      shareCode: '7M4K2D8Q9T1V',
      title: null,
      kind: 'unknown',
      atomCount: 64,
      frameCount: 10,
    });
    const g = buildFigureGraph(d);
    expect(g.variant).toBe('neutral-brand');
    expect(g.links).toEqual([]);
  });
});
