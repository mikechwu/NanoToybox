/**
 * Unified figure renderer for the capsule-preview pipeline.
 *
 * Owns the renderer-input type ({@link PreviewSketchScene}), three
 * explicit adapters that convert each of the codebase's three distinct
 * atom/bond carriers into that input, a pure primitive builder
 * ({@link buildPreviewSketchPrimitives}), and two render entry points
 * that emit the same primitives as either a plain SVG string (audit
 * page) or a React element (Satori poster + browser DOM thumb).
 *
 * **Three-layer architecture.** The renderer never branches on source:
 *
 *     adapter (source → PreviewSketchScene)
 *       → buildPreviewSketchPrimitives (PreviewSketchScene + preset → PreviewSketchPrimitives)
 *         → renderPreviewSketchSvgString | renderPreviewSketchSvgNode
 *
 * **Depth tiers.** Audit-tier inputs (from `projectPreviewScene`) carry
 * per-atom `depth`; the primitives builder uses it for back-to-front
 * paint order and subtle radius scaling. Production-tier inputs (from
 * stored `PreviewSceneV1` / `PreviewThumbV1`) have no depth; the
 * builder degrades gracefully to depth-free mode (all atoms at `z=0`,
 * stable draw order, no radius scaling). This is the "phase 5 last"
 * invariant — the renderer is parametric over depth presence and
 * production presets never need storage to carry depth.
 *
 * **Color modes.** `colorMode: 'flat'` ignores per-atom color and
 * fills every atom `#111111` (audit default — isolates depth/bond
 * legibility from color variation). `colorMode: 'cpk'` uses the
 * stored/projected `colorHex` verbatim (poster + thumb defaults —
 * preserves D135's per-atom CPK commitment for mixed-element capsules).
 *
 * Pure module: no DOM, no React runtime dependencies in the primitive
 * path. Only `renderPreviewSketchSvgNode` imports React.
 */

import { createElement, type ReactElement } from 'react';
import {
  CapsulePreviewRenderScene,
  CapsulePreviewAtom2D,
} from './capsule-preview-project';
import type {
  PreviewSceneV1,
  PreviewSceneBondV1,
  PreviewThumbV1,
} from './capsule-preview-scene-store';

// ── Scene input type (adapters' common target) ─────────────────────────

export interface PreviewSketchSceneAtom {
  /** 0..1 normalized horizontal position inside `bounds`. */
  x: number;
  /** 0..1 normalized vertical position inside `bounds`. */
  y: number;
  /** 0..1 normalized radius (relative to the shorter bound axis). */
  r: number;
  /** `#RRGGBB`. Rendered verbatim when `preset.colorMode === 'cpk'`;
   *  ignored in `'flat'` mode. */
  colorHex: string;
  /** Audit tier: post-projection z (larger = closer). Production tier:
   *  undefined. */
  depth?: number;
}

export interface PreviewSketchSceneBond {
  /** Atom index into {@link PreviewSketchScene.atoms}. */
  a: number;
  b: number;
  /** Midpoint depth policy. Audit tier only; production absent. */
  depth?: number;
}

export interface PreviewSketchScene {
  atoms: PreviewSketchSceneAtom[];
  bonds?: PreviewSketchSceneBond[];
  /** Source pane dimensions before renderer fit. The primitives
   *  builder needs these to preserve aspect ratio when mapping into
   *  the preset's width×height. */
  bounds: { width: number; height: number };
}

// ── Adapters ───────────────────────────────────────────────────────────

/**
 * Audit-tier adapter. Converts `projectPreviewScene` output (pixel-space
 * atoms inside `bounds.width × bounds.height`) into the 0..1 normalized
 * `PreviewSketchScene`. Atoms retain `colorHex` + `depth`. Bonds must
 * be supplied separately via
 * `deriveBondPairsForProjectedScene(scene3D, projected, cutoff, minDist)`
 * — this helper NEVER reads `deriveBondPairs` directly because those
 * indices reference the pre-depth-sort `scene3D.atoms`, not the
 * already-sorted `projected.atoms` (classic bond-index drift trap).
 */
export function toSketchSceneFromProjectedScene(
  scene: CapsulePreviewRenderScene,
  bonds?: ReadonlyArray<{ a: number; b: number; depth: number }>,
): PreviewSketchScene {
  const { width, height } = scene.bounds;
  const norm = Math.min(width, height) || 1;
  return {
    atoms: scene.atoms.map((a: CapsulePreviewAtom2D) => ({
      x: a.x / width,
      y: a.y / height,
      r: a.r / norm,
      colorHex: a.colorHex,
      depth: a.depth,
    })),
    bonds: bonds && bonds.length > 0
      ? bonds.map((b) => ({ a: b.a, b: b.b, depth: b.depth }))
      : undefined,
    bounds: { width, height },
  };
}

/**
 * Production-poster adapter. Converts the stored `PreviewSceneV1`
 * payload (already 0..1 normalized, `c` instead of `colorHex`, no
 * depth) into the renderer-input shape.
 */
export function toSketchSceneFromStoredPoster(
  stored: PreviewSceneV1,
): PreviewSketchScene {
  return {
    atoms: stored.atoms.map((a) => ({
      x: a.x,
      y: a.y,
      r: a.r,
      colorHex: a.c,
    })),
    bonds: stored.bonds && stored.bonds.length > 0
      ? stored.bonds.map((b: PreviewSceneBondV1) => ({ a: b.a, b: b.b }))
      : undefined,
    // Poster scene: stored atoms live in the 0..1 space of the OG
    // poster pane (600×500 at publish time). The primitives builder
    // fits them into whichever preset the caller picks.
    bounds: { width: 1, height: 1 },
  };
}

/**
 * Production-thumb adapter. Thumb atoms are already refit into the
 * 40×40 thumb cell as 0..1 coords; this is a field-rename only (no
 * projection work). No depth.
 */
export function toSketchSceneFromThumb(
  thumb: PreviewThumbV1,
): PreviewSketchScene {
  return {
    atoms: thumb.atoms.map((a) => ({
      x: a.x,
      y: a.y,
      r: a.r,
      colorHex: a.c,
    })),
    bonds: thumb.bonds && thumb.bonds.length > 0
      ? thumb.bonds.map((b: PreviewSceneBondV1) => ({ a: b.a, b: b.b }))
      : undefined,
    bounds: { width: 1, height: 1 },
  };
}

// ── Presets ────────────────────────────────────────────────────────────

export type PreviewColorMode = 'flat' | 'cpk';

export interface PreviewSketchSurfacePreset {
  /** Output width (primitive coords are in the same space). */
  width: number;
  /** Output height. */
  height: number;
  /** Floor for the rendered atom radius, in output-space units. Protects
   *  dense thumbs from collapsing to sub-pixel dots. */
  atomRadiusMin: number;
  /** Ceiling for the rendered atom radius. Prevents sparse thumbs from
   *  rendering giant blobs that swallow bonds. */
  atomRadiusMax: number;
  /** Outer bond-stroke width — drawn first in a darker color. */
  bondOuterWidth: number;
  /** Inner bond-stroke width — drawn second in a lighter color, thinner
   *  so the darker outer rim remains visible as a border. */
  bondInnerWidth: number;
  /** Padding as a fraction of the shorter output axis. Leaves breathing
   *  room so glyph strokes don't clip the cell edge. */
  padding: number;
  colorMode: PreviewColorMode;
}

/** Audit workbench — 800×800, flat-black atoms, thick bond strokes.
 *  Isolates depth + bond legibility from color variation. This is the
 *  design authority for layout; poster and thumb scale DOWN from
 *  figures that look right here. */
export const AUDIT_LARGE_PRESET: PreviewSketchSurfacePreset = {
  width: 800,
  height: 800,
  atomRadiusMin: 8,
  atomRadiusMax: 28,
  bondOuterWidth: 8,
  bondInnerWidth: 3,
  padding: 0.06,
  colorMode: 'flat',
};

/** Poster figure pane — 600×500 matches the existing `SceneSvg` pane
 *  inside the 1200×630 OG poster. CPK color defaults preserve D135's
 *  per-atom color commitment. */
export const POSTER_PRESET: PreviewSketchSurfacePreset = {
  width: 600,
  height: 500,
  atomRadiusMin: 6,
  atomRadiusMax: 18,
  bondOuterWidth: 5,
  bondInnerWidth: 2,
  padding: 0.08,
  colorMode: 'cpk',
};

/** Account thumb — 100×100 viewBox scaled to 40×40 physical px. CPK
 *  preserves O=red / N=blue / Si=tan distinctions that mixed-element
 *  capsules rely on for recognizability. */
export const THUMB_PRESET: PreviewSketchSurfacePreset = {
  width: 100,
  height: 100,
  atomRadiusMin: 3.5,
  atomRadiusMax: 8,
  bondOuterWidth: 2.5,
  bondInnerWidth: 1.0,
  padding: 0.08,
  colorMode: 'cpk',
};

// ── Primitives builder ─────────────────────────────────────────────────

export interface PreviewSketchPrimitiveCircle {
  cx: number;
  cy: number;
  r: number;
  fill: string;
  /** Sort key — larger = closer. In depth-aware scenes this is the
   *  atom's `depth`; in depth-free scenes all circles share `z = 0`
   *  and source order determines paint order. */
  z: number;
}

export interface PreviewSketchPrimitiveLine {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  /** Darker outer stroke — drawn first. */
  outerStroke: string;
  outerWidth: number;
  /** Lighter inner stroke — drawn on top of outer. */
  innerStroke: string;
  innerWidth: number;
  z: number;
}

export interface PreviewSketchPrimitives {
  width: number;
  height: number;
  /** Pre-sorted back-to-front. Renderers walk in order. */
  circles: PreviewSketchPrimitiveCircle[];
  /** Pre-sorted back-to-front. Renderers walk lines first so atoms
   *  overpaint the bond endpoints — standard molecular convention. */
  lines: PreviewSketchPrimitiveLine[];
}

const FLAT_ATOM_FILL = '#111111';
const BOND_OUTER_COLOR = '#000000';
const BOND_INNER_COLOR = '#ffffff';
/** Depth-aware radius multiplier range. Matches the plan's §4 style
 *  rule: subtle enough to feel spatial, bounded enough to stay honest. */
const DEPTH_SCALE_MIN = 0.82;
const DEPTH_SCALE_MAX = 1.18;

/**
 * Pure geometric primitives. No SVG text, no React — just the
 * quantities a renderer needs to emit bonds-under-atoms.
 */
export function buildPreviewSketchPrimitives(
  scene: PreviewSketchScene,
  preset: PreviewSketchSurfacePreset,
): PreviewSketchPrimitives {
  const { width, height } = preset;
  const padding = preset.padding;
  const availFraction = Math.max(0.01, 1 - 2 * padding);
  const availShort = Math.min(width, height) * availFraction;

  // Depth presence: we treat the scene as depth-aware only if at least
  // one atom carries a finite depth. Mixed scenes (some depth, some
  // absent) would be a bug in the adapter — fall back to depth-free.
  let hasDepth = false;
  let minDepth = Infinity;
  let maxDepth = -Infinity;
  for (const a of scene.atoms) {
    if (typeof a.depth === 'number' && Number.isFinite(a.depth)) {
      hasDepth = true;
      if (a.depth < minDepth) minDepth = a.depth;
      if (a.depth > maxDepth) maxDepth = a.depth;
    }
  }
  const depthSpan = hasDepth ? Math.max(1e-9, maxDepth - minDepth) : 0;

  // Map atom-normalized (0..1) coords to output space with padding.
  function toOutX(nx: number): number {
    return padding * width + nx * (width - 2 * padding * width);
  }
  function toOutY(ny: number): number {
    return padding * height + ny * (height - 2 * padding * height);
  }

  // Per-atom radius in output-space units, with optional depth scaling.
  function atomRadius(a: PreviewSketchSceneAtom): number {
    const baseFromStored = a.r * availShort;
    const clamped = Math.max(
      preset.atomRadiusMin,
      Math.min(preset.atomRadiusMax, baseFromStored || preset.atomRadiusMin),
    );
    if (!hasDepth || a.depth == null) return clamped;
    const t = (a.depth - minDepth) / depthSpan;
    const scale = DEPTH_SCALE_MIN + t * (DEPTH_SCALE_MAX - DEPTH_SCALE_MIN);
    return Math.max(preset.atomRadiusMin, Math.min(preset.atomRadiusMax, clamped * scale));
  }

  // Circles first (we need their centers to position bonds).
  const circles: PreviewSketchPrimitiveCircle[] = scene.atoms.map((a) => {
    const cx = toOutX(a.x);
    const cy = toOutY(a.y);
    const r = atomRadius(a);
    const fill = preset.colorMode === 'flat' ? FLAT_ATOM_FILL : a.colorHex;
    const z = hasDepth && a.depth != null ? a.depth : 0;
    return { cx, cy, r, fill, z };
  });

  const lines: PreviewSketchPrimitiveLine[] = [];
  if (scene.bonds) {
    for (const bond of scene.bonds) {
      const a = circles[bond.a];
      const b = circles[bond.b];
      if (!a || !b) continue;
      let z = 0;
      if (typeof bond.depth === 'number' && Number.isFinite(bond.depth)) {
        z = bond.depth;
      } else if (hasDepth) {
        z = (a.z + b.z) / 2;
      }
      lines.push({
        x1: a.cx,
        y1: a.cy,
        x2: b.cx,
        y2: b.cy,
        outerStroke: BOND_OUTER_COLOR,
        outerWidth: preset.bondOuterWidth,
        innerStroke: BOND_INNER_COLOR,
        innerWidth: preset.bondInnerWidth,
        z,
      });
    }
  }

  // Stable sort: lower z (farther) first so it draws under closer items.
  // The order within same z preserves source order (JS sort is stable
  // on modern engines; we don't rely on key uniqueness).
  circles.sort((p, q) => p.z - q.z);
  lines.sort((p, q) => p.z - q.z);

  return { width, height, circles, lines };
}

// ── Renderer entry points ──────────────────────────────────────────────

/**
 * Emit a plain SVG string — the audit page's entry point. Pure text;
 * no React dependency. Walks lines first (bonds under atoms), then
 * circles, matching `buildPreviewSketchPrimitives` sort order.
 */
export function renderPreviewSketchSvgString(
  p: PreviewSketchPrimitives,
): string {
  const parts: string[] = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${p.width}" height="${p.height}" viewBox="0 0 ${p.width} ${p.height}">`,
  );
  parts.push(`<rect x="0" y="0" width="${p.width}" height="${p.height}" fill="#ffffff"/>`);
  for (const line of p.lines) {
    parts.push(svgLine(line));
  }
  for (const c of p.circles) {
    parts.push(
      `<circle cx="${fmt(c.cx)}" cy="${fmt(c.cy)}" r="${fmt(c.r)}" fill="${c.fill}"/>`,
    );
  }
  parts.push('</svg>');
  return parts.join('');
}

function svgLine(line: PreviewSketchPrimitiveLine): string {
  const outer =
    `<line x1="${fmt(line.x1)}" y1="${fmt(line.y1)}" x2="${fmt(line.x2)}" y2="${fmt(line.y2)}"` +
    ` stroke="${line.outerStroke}" stroke-width="${fmt(line.outerWidth)}" stroke-linecap="round"/>`;
  const inner =
    `<line x1="${fmt(line.x1)}" y1="${fmt(line.y1)}" x2="${fmt(line.x2)}" y2="${fmt(line.y2)}"` +
    ` stroke="${line.innerStroke}" stroke-width="${fmt(line.innerWidth)}" stroke-linecap="round"/>`;
  return outer + inner;
}

function fmt(n: number): string {
  // Three decimal places; trim trailing zeros. Keeps the SVG compact
  // without sacrificing sub-pixel positioning for anti-aliasing.
  return Number.isFinite(n) ? Number(n.toFixed(3)).toString() : '0';
}

/**
 * Emit a React element — the Satori / browser-DOM entry point.
 * Identical paint order to the string renderer; no shared logic below
 * the primitives layer. Consumers embed the result inside a JSX tree
 * (`<img>`/`<svg>`/`<div>`). Satori walks the returned element's
 * children the same way it walks any other JSX subtree.
 */
export function renderPreviewSketchSvgNode(
  p: PreviewSketchPrimitives,
): ReactElement {
  // createElement is required so Satori and the React runtime see the
  // $typeof Symbol marker — object literals with `{ type, props, key }`
  // are not valid React elements and silently fail to render.
  const children: ReactElement[] = [];
  children.push(
    createElement('rect', {
      key: 'bg',
      x: 0,
      y: 0,
      width: p.width,
      height: p.height,
      fill: '#ffffff',
    }),
  );
  p.lines.forEach((line, idx) => {
    children.push(
      createElement('line', {
        key: `lo${idx}`,
        x1: line.x1,
        y1: line.y1,
        x2: line.x2,
        y2: line.y2,
        stroke: line.outerStroke,
        strokeWidth: line.outerWidth,
        strokeLinecap: 'round',
      }),
    );
    children.push(
      createElement('line', {
        key: `li${idx}`,
        x1: line.x1,
        y1: line.y1,
        x2: line.x2,
        y2: line.y2,
        stroke: line.innerStroke,
        strokeWidth: line.innerWidth,
        strokeLinecap: 'round',
      }),
    );
  });
  p.circles.forEach((c, idx) => {
    children.push(
      createElement('circle', {
        key: `c${idx}`,
        cx: c.cx,
        cy: c.cy,
        r: c.r,
        fill: c.fill,
      }),
    );
  });
  return createElement(
    'svg',
    {
      xmlns: 'http://www.w3.org/2000/svg',
      width: p.width,
      height: p.height,
      viewBox: `0 0 ${p.width} ${p.height}`,
    },
    ...children,
  );
}
