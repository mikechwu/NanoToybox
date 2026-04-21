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

  it('renders perspective cue as a clamped ±15% multiplier around the bond-length-derived base', () => {
    // Stored `a.r` is used only as a RELATIVE perspective-cue
    // multiplier (poster + thumb unified). Two atoms with stored
    // values close to the median round to the same rendered
    // radius; atoms at opposite ends of the clamp (0.85×, 1.15×)
    // render at measurably different sizes.
    //
    // Uniform-r set: all atoms at the same `r` → identical
    // rendered radii (sNorm = 1 for every atom).
    const uniform: PreviewThumbV1 = {
      v: 1,
      atoms: Array.from({ length: 9 }, (_, i) => ({
        x: 0.1 + (i / 8) * 0.8,
        y: 0.5,
        r: 0.04,
        c: '#222',
      })),
    };
    const { container: cUni } = render(<CapsulePreviewThumb thumb={uniform} />);
    const rsUni = Array.from(cUni.querySelectorAll('circle[data-role="atom"]'))
      .map((c) => c.getAttribute('r'));
    expect(new Set(rsUni).size).toBe(1);

    // Spread-r set: stored `r` straddles the median at both ends
    // of the clamp. 5 atoms at 0.03 (below median → clamp 0.85×),
    // one at 0.06 (at median → 1×), 5 at 0.10 (above → 1.15×).
    const spread: PreviewThumbV1 = {
      v: 1,
      atoms: [
        ...Array.from({ length: 5 }, (_, i) => ({
          x: 0.1 + (i / 10) * 0.8,
          y: 0.4,
          r: 0.03,
          c: '#222',
        })),
        { x: 0.5, y: 0.5, r: 0.06, c: '#222' },
        ...Array.from({ length: 5 }, (_, i) => ({
          x: 0.1 + (i / 10) * 0.8,
          y: 0.6,
          r: 0.10,
          c: '#222',
        })),
      ],
    };
    const { container: cSpread } = render(<CapsulePreviewThumb thumb={spread} />);
    const rsSpread = Array.from(cSpread.querySelectorAll('circle[data-role="atom"]'))
      .map((c) => c.getAttribute('r'))
      .filter((r): r is string => r != null);
    // Three distinct rendered radii — both clamp extremes plus the
    // 1× unclamped mid value.
    expect(new Set(rsSpread).size).toBe(3);
    // Ratio between the clamp extremes should match ±15% range:
    // max/min = 1.15/0.85 ≈ 1.35.
    const nums = [...new Set(rsSpread)].map(Number).sort((a, b) => a - b);
    const ratio = nums[nums.length - 1] / nums[0];
    expect(ratio).toBeGreaterThan(1.25);
    expect(ratio).toBeLessThan(1.45);
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
  it('renders each bond as a <g data-role="bond-pair"> wrapping edge+body+highlight cylinder layers', () => {
    const thumb = thumbWithBonds(6, 4);
    const { container } = render(<CapsulePreviewThumb thumb={thumb} />);
    const edgeLines = container.querySelectorAll('line[data-role="bond-edge"]');
    const bodyLines = container.querySelectorAll('line[data-role="bond-body"]');
    const highlightLines = container.querySelectorAll('line[data-role="bond-highlight"]');
    expect(edgeLines.length).toBe(4);
    expect(bodyLines.length).toBe(4);
    expect(highlightLines.length).toBe(4);
    expect(readBondCount(container)).toBe(4);
    // Each bond emits a <g> wrapper with edge, body, highlight in
    // that paint order (widest darkest at the bottom of the stack
    // so the highlight reads as a spec on top of a lit cylinder).
    const bondPairs = container.querySelectorAll('g[data-role="bond-pair"]');
    expect(bondPairs.length).toBe(4);
    for (const g of Array.from(bondPairs)) {
      const lines = g.querySelectorAll('line');
      expect(lines.length).toBe(3);
      expect(lines[0].getAttribute('data-role')).toBe('bond-edge');
      expect(lines[1].getAttribute('data-role')).toBe('bond-body');
      expect(lines[2].getAttribute('data-role')).toBe('bond-highlight');
    }
    // Widths decrease edge → body → highlight (widest cylinder
    // silhouette at the bottom of the stack, thin spec on top).
    const [e0] = Array.from(edgeLines);
    const [b0] = Array.from(bodyLines);
    const [h0] = Array.from(highlightLines);
    const edgeW = Number(e0.getAttribute('stroke-width'));
    const bodyW = Number(b0.getAttribute('stroke-width'));
    const highlightW = Number(h0.getAttribute('stroke-width'));
    expect(edgeW).toBeGreaterThan(bodyW);
    expect(bodyW).toBeGreaterThan(highlightW);
  });

  it('DOM cost scales O(atoms + bonds) under depth-sorted paint order', () => {
    // Atoms and bonds interleave in a single depth-sorted paint
    // list. Each bond emits <g> + 3 <line> (cylinder edge/body/
    // highlight stack). For 24 atoms + 24 bonds that's ~128
    // elements including svg/defs/gradient/rect wrappers; bound
    // at 150 for headroom and at ≥24 to assert at least one per
    // atom.
    const thumb = thumbWithBonds(24, 24);
    const { container } = render(<CapsulePreviewThumb thumb={thumb} />);
    const total = container.querySelectorAll('*').length;
    expect(total).toBeLessThanOrEqual(150);
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
