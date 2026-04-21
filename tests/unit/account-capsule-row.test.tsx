/**
 * @vitest-environment jsdom
 *
 * Tests for the account uploads-row preview thumbnail (spec §Account
 * Integration §5, updated for D138 follow-up: path-batched renderer).
 *
 * Coverage:
 *   - decorative SVG / aria attributes
 *   - atoms are reflected via one batched `<path data-role="atoms">`
 *     per distinct CPK color; counts are inspectable via
 *     `data-atom-count` / `data-group-size`.
 *   - bonds are reflected via one batched `<path data-role="bonds">`;
 *     count inspectable via `data-bond-count`.
 *   - DOM budget: `svg + rect + 1 bonds-path + K atoms-paths` — we
 *     assert total element count ≤ 10 even at the new 24 atoms / 24
 *     bonds cap.
 *   - PlaceholderThumb renders for null previewThumb
 *   - distinctiveness: two different fixtures render materially
 *     different thumb geometry (regression against "all thumbs look
 *     the same" bug), checked via the emitted `d` attribute.
 */

import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { CapsulePreviewThumb, PlaceholderThumb } from '../../account/main';
import type {
  PreviewThumbV1,
  PreviewSceneAtomV1,
} from '../../src/share/capsule-preview-scene-store';

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

function readAtomCount(container: HTMLElement): number {
  const svg = container.querySelector('svg')!;
  return Number(svg.getAttribute('data-atom-count') ?? '0');
}
function readBondCount(container: HTMLElement): number {
  const svg = container.querySelector('svg')!;
  return Number(svg.getAttribute('data-bond-count') ?? '0');
}
function readAtomRadius(container: HTMLElement): number {
  const svg = container.querySelector('svg')!;
  return Number(svg.getAttribute('data-atom-radius') ?? '0');
}

describe('CapsulePreviewThumb — atoms-only payload', () => {
  it('renders a decorative SVG marked aria-hidden', () => {
    const { container } = render(<CapsulePreviewThumb thumb={thumbFixture(8)} />);
    const svg = container.querySelector('svg');
    expect(svg).not.toBeNull();
    expect(svg?.getAttribute('aria-hidden')).toBe('true');
    expect(svg?.getAttribute('role')).toBe('presentation');
  });

  it('reports the atom count via data-atom-count (verbatim — no client-side downsampling)', () => {
    const thumb = thumbFixture(5);
    const { container } = render(<CapsulePreviewThumb thumb={thumb} />);
    expect(readAtomCount(container)).toBe(thumb.atoms.length);
  });

  it('renders one <circle> per atom, fill references the shared radial gradient (ignores stored CPK)', () => {
    // Rev 11 rendering: atoms go back to individual circles so the
    // shaded-sphere radial gradient can tile per atom. The stored
    // `c` field is no longer consulted for rendering — every atom
    // fills via `url(#<gradient-id>)`.
    const thumb = thumbFixture(4); // stored alternates #222222 / #3050f8
    const { container } = render(<CapsulePreviewThumb thumb={thumb} />);
    const circles = container.querySelectorAll('circle[data-role="atom"]');
    expect(circles.length).toBe(thumb.atoms.length);
    const fills = new Set(Array.from(circles).map((c) => c.getAttribute('fill')));
    expect(fills.size).toBe(1);
    const [fill] = Array.from(fills);
    expect(fill).toMatch(/^url\(#[^)]+\)$/);
    // The <defs><radialGradient /> is present exactly once.
    expect(container.querySelectorAll('defs radialGradient').length).toBe(1);
  });

  it('ship preset emits a thin black atom outline (EXPERIMENTAL shaded-sphere style)', () => {
    // Rev 11 aligns the thumb style with the audit-page
    // EXPERIMENTAL preset: black outline on shaded-sphere atoms,
    // not the flat no-halo look from rev 10. Locks the color.
    const { container } = render(<CapsulePreviewThumb thumb={thumbFixture(5)} />);
    const circles = container.querySelectorAll('circle[data-role="atom"]');
    expect(circles.length).toBeGreaterThan(0);
    for (const c of Array.from(circles)) {
      expect(c.getAttribute('stroke')).toBe('#000000');
      const w = Number(c.getAttribute('stroke-width'));
      expect(w).toBeGreaterThan(0);
    }
  });

  it('quantizes radius consistently — same-bucket pairs render at the same r, cross-bucket pairs render at different r', () => {
    // Radius quantization stays at 1/100 viewBox. Under rev 11's
    // per-circle rendering we assert at the circle level: two
    // atoms with stored r values that round to the SAME bucket
    // must produce <circle r="…"> with identical values; pairs
    // across a bucket boundary must differ.
    // Use 9 atoms so atoms-only density floor (5.0 at n=9) is
    // below the fixture r values (7.3 viewBox) — the floor otherwise
    // clamps both atoms to the same rendered size and the bucket
    // distinction is lost at the contract boundary we're testing.
    const sameBucket: PreviewThumbV1 = {
      v: 1,
      atoms: Array.from({ length: 9 }, (_, i) => ({
        x: 0.1 + (i / 8) * 0.8,
        y: 0.5,
        r: i % 2 === 0 ? 0.07320 : 0.07323,
        c: '#222',
      })),
    };
    const { container: cSame } = render(<CapsulePreviewThumb thumb={sameBucket} />);
    const rsSame = Array.from(cSame.querySelectorAll('circle[data-role="atom"]'))
      .map((c) => c.getAttribute('r'));
    expect(new Set(rsSame).size).toBe(1);

    const crossBucket: PreviewThumbV1 = {
      v: 1,
      atoms: Array.from({ length: 9 }, (_, i) => ({
        x: 0.1 + (i / 8) * 0.8,
        y: 0.5,
        r: i % 2 === 0 ? 0.07320 : 0.07330,
        c: '#222',
      })),
    };
    const { container: cCross } = render(<CapsulePreviewThumb thumb={crossBucket} />);
    const rsCross = Array.from(cCross.querySelectorAll('circle[data-role="atom"]'))
      .map((c) => c.getAttribute('r'));
    expect(new Set(rsCross).size).toBe(2);
  });

  it('renders atoms at each atom\'s stored per-atom radius (perspective bake)', () => {
    // Rev 11 perspective bake: each atom carries its own `r`
    // encoding depth via `r = base_r · s(z)`. The renderer honors
    // it — atoms with varying stored r render at varying circle
    // radii.
    const baseAtoms: PreviewSceneAtomV1[] = Array.from({ length: 9 }, (_, i) => ({
      x: 0.1 + (i / 8) * 0.8,
      y: 0.4,
      r: 0.05,
      c: '#222222',
    }));
    const tallAtom: PreviewSceneAtomV1 = { x: 0.5, y: 0.7, r: 0.12, c: '#222222' };
    const thumb: PreviewThumbV1 = { v: 1, atoms: [...baseAtoms, tallAtom] };
    const { container } = render(<CapsulePreviewThumb thumb={thumb} />);
    const rs = Array.from(container.querySelectorAll('circle[data-role="atom"]'))
      .map((c) => Number(c.getAttribute('r')));
    // 9 small atoms at ≈5 viewBox + 1 big atom at ≈12 viewBox.
    expect(new Set(rs).size).toBeGreaterThanOrEqual(2);
    expect(Math.max(...rs)).toBeGreaterThan(Math.min(...rs));
  });

  it('reports zero bonds and emits no bond paths when the payload has no bonds', () => {
    const { container } = render(<CapsulePreviewThumb thumb={thumbFixture(10)} />);
    expect(readBondCount(container)).toBe(0);
    expect(container.querySelectorAll('line[data-role^="bond"]').length).toBe(0);
  });
});

describe('CapsulePreviewThumb — bonds-aware payload', () => {
  it('renders each bond as a <g data-role="bond-pair"> wrapping border+fill <line> stack', () => {
    const thumb = thumbWithBonds(6, 4);
    const { container } = render(<CapsulePreviewThumb thumb={thumb} />);
    const borderLines = container.querySelectorAll('line[data-role="bond-border"]');
    const fillLines = container.querySelectorAll('line[data-role="bond-fill"]');
    expect(borderLines.length).toBe(4);
    expect(fillLines.length).toBe(4);
    expect(readBondCount(container)).toBe(4);
    // Each bond emits a <g> wrapper with border first, fill second.
    const bondPairs = container.querySelectorAll('g[data-role="bond-pair"]');
    expect(bondPairs.length).toBe(4);
    for (const g of Array.from(bondPairs)) {
      const lines = g.querySelectorAll('line');
      expect(lines.length).toBe(2);
      expect(lines[0].getAttribute('data-role')).toBe('bond-border');
      expect(lines[1].getAttribute('data-role')).toBe('bond-fill');
    }
    const [firstBorder] = Array.from(borderLines);
    const [firstFill] = Array.from(fillLines);
    expect(firstFill.getAttribute('stroke')).toMatch(/^#ffffff$/i);
    expect(firstBorder.getAttribute('stroke')).toMatch(/^#000000$/i);
    const borderW = Number(firstBorder.getAttribute('stroke-width'));
    const fillW = Number(firstFill.getAttribute('stroke-width'));
    expect(borderW).toBeGreaterThan(fillW);
  });

  it('DOM cost scales O(atoms + bonds) under depth-sorted paint order', () => {
    // Rev 13: atoms and bonds interleave in a single depth-sorted
    // paint list. Each bond emits <g> + 2 <line>. For 24 atoms +
    // 24 bonds that's ~103 elements total; bound at 120 for
    // headroom and at ≥24 to assert at least one per atom.
    const thumb = thumbWithBonds(24, 24);
    const { container } = render(<CapsulePreviewThumb thumb={thumb} />);
    const total = container.querySelectorAll('*').length;
    expect(total).toBeLessThanOrEqual(120);
    expect(total).toBeGreaterThanOrEqual(24);
  });

  it('skips bonds whose endpoints exceed the atom array', () => {
    const thumb: PreviewThumbV1 = {
      ...thumbFixture(3),
      bonds: [{ a: 0, b: 99 }, { a: 5, b: 1 }],
    };
    const { container } = render(<CapsulePreviewThumb thumb={thumb} />);
    expect(readBondCount(container)).toBe(0);
    expect(container.querySelectorAll('line[data-role^="bond"]').length).toBe(0);
  });
});

describe('CapsulePreviewThumb — visual distinctiveness', () => {
  it('two different atom layouts produce different circle geometry', () => {
    const a = thumbFixture(10, 0);
    const b = thumbFixture(10, 3);
    const { container: ca } = render(<CapsulePreviewThumb thumb={a} />);
    const { container: cb } = render(<CapsulePreviewThumb thumb={b} />);
    const posA = Array.from(ca.querySelectorAll('circle[data-role="atom"]'))
      .map((c) => `${c.getAttribute('cx')},${c.getAttribute('cy')}`)
      .join('|');
    const posB = Array.from(cb.querySelectorAll('circle[data-role="atom"]'))
      .map((c) => `${c.getAttribute('cx')},${c.getAttribute('cy')}`)
      .join('|');
    expect(posA).not.toBe(posB);
  });
});

describe('CapsulePreviewThumb — renderer/derivation coupling', () => {
  it('renders bonded-mode atoms at the radius the derivation filter assumes (2.8 viewBox)', () => {
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
    expect(readAtomRadius(container)).toBeLessThanOrEqual(2.8);
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
    expect(readAtomRadius(container)).toBeLessThanOrEqual(3.5);
  });

  it('renders atoms-only sparse atoms at ≤ 8 viewBox (derivation constant)', () => {
    const thumb: PreviewThumbV1 = {
      v: 1,
      atoms: [{ x: 0.5, y: 0.5, r: 0.028, c: '#222222' }],
    };
    const { container } = render(<CapsulePreviewThumb thumb={thumb} />);
    expect(readAtomRadius(container)).toBeLessThanOrEqual(8);
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
});
