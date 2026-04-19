/**
 * @vitest-environment jsdom
 *
 * Tests for the account uploads-row preview thumbnail (spec §5).
 *
 * Closes the gap left by account/ being outside the original tsconfig include
 * glob: this file imports the actual account/main.tsx component used at
 * runtime (not a mock) and asserts the thumb renders an SVG within the
 * per-thumb DOM-node budget defined by spec §2.
 */

import { describe, it, expect } from 'vitest';
// jsdom is the default vitest env via vite.config.ts test config
import { render } from '@testing-library/react';
import { CapsulePreviewThumb, downsampleFigureForThumb } from '../../account/main';
import { buildCapsulePreviewDescriptor } from '../../src/share/capsule-preview';
import { buildFigureGraph } from '../../src/share/capsule-preview-figure';

function thumbForFixture() {
  const descriptor = buildCapsulePreviewDescriptor({
    shareCode: '7M4K2D8Q9T1V',
    title: 'Diamond cluster',
    kind: 'capsule',
    atomCount: 64,
    frameCount: 240,
  });
  return buildFigureGraph(descriptor);
}

describe('CapsulePreviewThumb (account row)', () => {
  it('renders a decorative SVG marked aria-hidden', () => {
    const { container } = render(<CapsulePreviewThumb graph={thumbForFixture()} />);
    const svg = container.querySelector('svg');
    expect(svg).not.toBeNull();
    expect(svg?.getAttribute('aria-hidden')).toBe('true');
    expect(svg?.getAttribute('role')).toBe('presentation');
  });

  it('contains nodes from the figure graph', () => {
    const { container } = render(<CapsulePreviewThumb graph={thumbForFixture()} />);
    expect(container.querySelectorAll('circle').length).toBeGreaterThan(0);
  });

  it('stays within the per-thumb DOM-node budget (≤20 elements)', () => {
    const { container } = render(<CapsulePreviewThumb graph={thumbForFixture()} />);
    expect(container.querySelectorAll('*').length).toBeLessThanOrEqual(20);
  });

  it('uses the descriptor accent color for the node fill', () => {
    const graph = thumbForFixture();
    const { container } = render(<CapsulePreviewThumb graph={graph} />);
    const circle = container.querySelector('circle');
    expect(circle?.getAttribute('fill')).toBe(graph.accentColor);
  });

  it('preserves at least one edge when the source graph has links and budget allows', () => {
    // Use a high-density graph (atomCount > 256 → 18 nodes + edges).
    const descriptor = buildCapsulePreviewDescriptor({
      shareCode: '7M4K2D8Q9T1V',
      title: 'dense',
      kind: 'capsule',
      atomCount: 1024,
      frameCount: 240,
    });
    const graph = buildFigureGraph(descriptor);
    expect(graph.links.length).toBeGreaterThan(0); // sanity for the source
    const { container } = render(<CapsulePreviewThumb graph={graph} />);
    expect(container.querySelectorAll('line').length).toBeGreaterThan(0);
  });
});

describe('downsampleFigureForThumb', () => {
  it('produces ≤ childBudget total elements', () => {
    const descriptor = buildCapsulePreviewDescriptor({
      shareCode: '7M4K2D8Q9T1V',
      title: null,
      kind: 'capsule',
      atomCount: 1024,
      frameCount: 240,
    });
    const graph = buildFigureGraph(descriptor);
    const out = downsampleFigureForThumb(graph, 19);
    expect(out.nodes.length + out.links.length).toBeLessThanOrEqual(19);
  });

  it('reserves edge budget so dense graphs keep some links', () => {
    const descriptor = buildCapsulePreviewDescriptor({
      shareCode: '7M4K2D8Q9T1V',
      title: null,
      kind: 'capsule',
      atomCount: 1024,
      frameCount: 240,
    });
    const graph = buildFigureGraph(descriptor);
    expect(graph.links.length).toBeGreaterThan(0);
    const out = downsampleFigureForThumb(graph, 19);
    expect(out.links.length).toBeGreaterThan(0);
  });

  it('every kept link has both endpoints in the kept node set', () => {
    const descriptor = buildCapsulePreviewDescriptor({
      shareCode: '7M4K2D8Q9T1V',
      title: null,
      kind: 'capsule',
      atomCount: 1024,
      frameCount: 240,
    });
    const graph = buildFigureGraph(descriptor);
    const out = downsampleFigureForThumb(graph, 19);
    const keptIds = new Set(out.nodes.map((n) => n.id));
    for (const l of out.links) {
      expect(keptIds.has(l.from)).toBe(true);
      expect(keptIds.has(l.to)).toBe(true);
    }
  });

  it('actually fills the reserved node budget on dense graphs', () => {
    // Regression for the under-utilization bug: the previous stride
    // sampler turned an 18-node, 15-budget input into 9 kept nodes.
    // The replacement must hit the budget (15 nodes, 4 edges = 19).
    const descriptor = buildCapsulePreviewDescriptor({
      shareCode: '7M4K2D8Q9T1V',
      title: null,
      kind: 'capsule',
      atomCount: 1024,
      frameCount: 240,
    });
    const graph = buildFigureGraph(descriptor);
    expect(graph.nodes.length).toBe(18); // density=high → 18 nodes
    const out = downsampleFigureForThumb(graph, 19);
    // With 4 reserved edge slots and 15 available node slots, we should
    // keep all 15 of the requested nodes (or be within a tight tolerance).
    expect(out.nodes.length).toBeGreaterThanOrEqual(15);
  });

  it('keeps endpoints — first and last source nodes — when sampling', () => {
    // Even-spaced sampling must always include index 0 and index n-1 so
    // the thumb retains the visual extents of the figure.
    const descriptor = buildCapsulePreviewDescriptor({
      shareCode: '7M4K2D8Q9T1V',
      title: null,
      kind: 'capsule',
      atomCount: 1024,
      frameCount: 240,
    });
    const graph = buildFigureGraph(descriptor);
    const out = downsampleFigureForThumb(graph, 19);
    expect(out.nodes[0].id).toBe(graph.nodes[0].id);
    expect(out.nodes[out.nodes.length - 1].id).toBe(graph.nodes[graph.nodes.length - 1].id);
  });

  it('neutral-brand graph (no links) downsamples to nodes-only', () => {
    const descriptor = buildCapsulePreviewDescriptor({
      shareCode: '7M4K2D8Q9T1V',
      title: null,
      kind: 'unknown',
      atomCount: 64,
      frameCount: 60,
    });
    const graph = buildFigureGraph(descriptor);
    expect(graph.links.length).toBe(0);
    const out = downsampleFigureForThumb(graph, 19);
    expect(out.links.length).toBe(0);
    expect(out.nodes.length).toBeGreaterThan(0);
  });
});
