/**
 * @vitest-environment jsdom
 *
 * Tests for the account uploads-row preview thumbnail (spec §Account
 * Integration §5, follow-up: bonds reopened for dense thumbs).
 *
 * Coverage:
 *   - decorative SVG / aria attributes
 *   - one <circle> per atom (verbatim, no client-side downsampling)
 *   - optional bonds rendered as <line> under the atoms
 *   - DOM budget ≤ 20 at the worst-case 12 atoms + 6 bonds payload
 *   - PlaceholderThumb renders for null previewThumb
 *   - distinctiveness: two different fixtures render materially different
 *     thumb geometry (regression against "all thumbs look the same" bug)
 */

import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { CapsulePreviewThumb, PlaceholderThumb } from '../../account/main';
import type { PreviewThumbV1 } from '../../src/share/capsule-preview-scene-store';

function thumbFixture(n: number, seed = 0): PreviewThumbV1 {
  const atoms = [];
  for (let i = 0; i < n; i++) {
    atoms.push({
      x: ((i + seed) % n) / Math.max(1, n - 1),
      y: (i % 3) / 2,
      r: 0.04,
      c: i % 2 === 0 ? '#222222' : '#3050f8',
    });
  }
  return { v: 1, atoms };
}

function thumbWithBonds(n: number, bondCount: number): PreviewThumbV1 {
  const base = thumbFixture(n);
  const bonds = [];
  for (let i = 0; i < bondCount; i++) {
    bonds.push({ a: i % n, b: (i + 1) % n });
  }
  return { ...base, bonds };
}

describe('CapsulePreviewThumb — atoms-only payload', () => {
  it('renders a decorative SVG marked aria-hidden', () => {
    const { container } = render(<CapsulePreviewThumb thumb={thumbFixture(8)} />);
    const svg = container.querySelector('svg');
    expect(svg).not.toBeNull();
    expect(svg?.getAttribute('aria-hidden')).toBe('true');
    expect(svg?.getAttribute('role')).toBe('presentation');
  });

  it('renders one circle per atom (verbatim — no client-side downsampling)', () => {
    const thumb = thumbFixture(5);
    const { container } = render(<CapsulePreviewThumb thumb={thumb} />);
    expect(container.querySelectorAll('circle').length).toBe(thumb.atoms.length);
  });

  it('uses per-atom stored color', () => {
    const thumb = thumbFixture(2);
    const { container } = render(<CapsulePreviewThumb thumb={thumb} />);
    const circles = container.querySelectorAll('circle');
    expect(circles[0].getAttribute('fill')).toBe('#222222');
    expect(circles[1].getAttribute('fill')).toBe('#3050f8');
  });

  it('renders no <line> elements when the payload has no bonds', () => {
    const { container } = render(<CapsulePreviewThumb thumb={thumbFixture(10)} />);
    expect(container.querySelectorAll('line').length).toBe(0);
  });
});

describe('CapsulePreviewThumb — bonds-aware payload', () => {
  it('renders one <line> per bond, under the atoms', () => {
    const thumb = thumbWithBonds(6, 4);
    const { container } = render(<CapsulePreviewThumb thumb={thumb} />);
    const lines = container.querySelectorAll('line');
    expect(lines.length).toBe(4);
    const svg = container.querySelector('svg')!;
    // Bonds rendered before atoms in paint order so atoms occlude the stroke
    // endpoints visually. Check DOM order: first line index < first circle.
    const firstLine = Array.from(svg.children).findIndex((n) => n.tagName.toLowerCase() === 'line');
    const firstCircleAfterRect = Array.from(svg.children).findIndex(
      (n, idx) => n.tagName.toLowerCase() === 'circle' && idx > 0,
    );
    expect(firstLine).toBeLessThan(firstCircleAfterRect);
  });

  it('stays within the ≤20-element DOM budget at the worst-case (12 atoms + 6 bonds)', () => {
    const thumb = thumbWithBonds(12, 6);
    const { container } = render(<CapsulePreviewThumb thumb={thumb} />);
    expect(container.querySelectorAll('*').length).toBeLessThanOrEqual(20);
  });

  it('skips bonds whose endpoints exceed the atom array', () => {
    const thumb: PreviewThumbV1 = {
      ...thumbFixture(3),
      bonds: [{ a: 0, b: 99 }, { a: 5, b: 1 }],
    };
    const { container } = render(<CapsulePreviewThumb thumb={thumb} />);
    // Both bonds reference out-of-range indices → no <line> elements.
    expect(container.querySelectorAll('line').length).toBe(0);
  });
});

describe('CapsulePreviewThumb — visual distinctiveness', () => {
  it('two different atom layouts produce different DOM geometry', () => {
    const a = thumbFixture(10, 0);
    const b = thumbFixture(10, 3);
    const { container: ca } = render(<CapsulePreviewThumb thumb={a} />);
    const { container: cb } = render(<CapsulePreviewThumb thumb={b} />);
    const posA = Array.from(ca.querySelectorAll('circle')).map(
      (c) => `${c.getAttribute('cx')},${c.getAttribute('cy')}`,
    ).join('|');
    const posB = Array.from(cb.querySelectorAll('circle')).map(
      (c) => `${c.getAttribute('cx')},${c.getAttribute('cy')}`,
    ).join('|');
    expect(posA).not.toBe(posB);
  });
});

describe('CapsulePreviewThumb — renderer/derivation coupling', () => {
  it('renders bonded-mode atoms at the radius the derivation filter assumes (2.8 viewBox)', () => {
    // `derivePreviewThumbV1` filters bonds by `visible = len − 2×atomRadius`
    // where `atomRadius=2.8` for n>6 bonded thumbs. If the renderer ever
    // enlarges its bonded atom radius above 2.8 without updating the
    // derivation constant, silently-visible-to-derivation bonds will be
    // occluded by larger rendered glyphs. This test locks the renderer
    // side of that contract.
    const thumb: PreviewThumbV1 = {
      v: 1,
      atoms: Array.from({ length: 12 }, (_, i) => ({
        x: 0.1 + (i / 11) * 0.8,
        y: 0.5,
        r: 0.028,
        c: '#222222',
      })),
      bonds: [{ a: 0, b: 1 }],
    };
    const { container } = render(<CapsulePreviewThumb thumb={thumb} />);
    const circles = container.querySelectorAll('circle');
    const r = parseFloat(circles[0].getAttribute('r') ?? '0');
    expect(r).toBeLessThanOrEqual(2.8);
  });

  it('renders low-N bonded atoms at ≤ 3.5 viewBox (derivation constant)', () => {
    const thumb: PreviewThumbV1 = {
      v: 1,
      atoms: Array.from({ length: 5 }, (_, i) => ({
        x: 0.1 + (i / 4) * 0.8,
        y: 0.5,
        r: 0.028,
        c: '#222222',
      })),
      bonds: [{ a: 0, b: 1 }],
    };
    const { container } = render(<CapsulePreviewThumb thumb={thumb} />);
    const r = parseFloat(container.querySelector('circle')!.getAttribute('r') ?? '0');
    expect(r).toBeLessThanOrEqual(3.5);
  });

  it('renders atoms-only sparse atoms at ≤ 8 viewBox (derivation constant)', () => {
    const thumb: PreviewThumbV1 = {
      v: 1,
      atoms: [{ x: 0.5, y: 0.5, r: 0.028, c: '#222222' }],
    };
    const { container } = render(<CapsulePreviewThumb thumb={thumb} />);
    const r = parseFloat(container.querySelector('circle')!.getAttribute('r') ?? '0');
    expect(r).toBeLessThanOrEqual(8);
  });
});

describe('PlaceholderThumb', () => {
  it('renders a small presentational SVG', () => {
    const { container } = render(<PlaceholderThumb />);
    const svg = container.querySelector('svg');
    expect(svg).not.toBeNull();
    expect(svg?.getAttribute('aria-hidden')).toBe('true');
    expect(svg?.getAttribute('role')).toBe('presentation');
  });

  it('keeps a well-under-budget element count (≤ 5 elements)', () => {
    const { container } = render(<PlaceholderThumb />);
    expect(container.querySelectorAll('*').length).toBeLessThanOrEqual(5);
  });
});
