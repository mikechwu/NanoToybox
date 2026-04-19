/**
 * Pure geometry primitives for the capsule preview figure (spec §2).
 *
 * Owns ONLY the abstract geometry system: node positions, link layout, density
 * presets, and the deterministic `descriptor → figure-graph` mapping.
 *
 * Constraints:
 *   - pure, deterministic, no I/O
 *   - no React / JSX / Cloudflare APIs
 *   - .ts only (covered by tsconfig.json:include "src/**\/*.ts")
 *
 * Consumers convert the returned graph into a renderable form:
 *   - account/main.tsx → inline SVG via React JSX
 *   - functions/_lib/capsule-preview-image.tsx → ImageResponse via Satori
 */

import type { CapsulePreviewDescriptor } from './capsule-preview';
import { fnv1a32 } from './capsule-preview';

export interface FigureNode {
  id: string;
  /** Normalized [0, 1] coordinates within the unit canvas. */
  x: number;
  y: number;
  /** Normalized [0, 1] radius — consumers scale by canvas size. */
  r: number;
}

export interface FigureLink {
  id: string;
  from: string;
  to: string;
}

export interface FigureGraph {
  nodes: FigureNode[];
  links: FigureLink[];
  /** Background accent color (CSS string). */
  accentColor: string;
  /** Geometry-relevant variant — drives node arrangement strategy. */
  variant: string;
  density: 'low' | 'medium' | 'high';
  /** Display only — never affects geometry. */
  themeVariant: 'light' | 'dark';
}

const DENSITY_NODE_COUNT = { low: 6, medium: 12, high: 18 } as const;

// ── Deterministic PRNG (mulberry32) seeded from share code ─────────────────

function mulberry32(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = t;
    r = Math.imul(r ^ (r >>> 15), r | 1);
    r ^= r + Math.imul(r ^ (r >>> 7), r | 61);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

// ── Variant layouts ───────────────────────────────────────────────────────

function neutralBrand(rng: () => number, count: number): FigureNode[] {
  // Single anchor node, plus a sparse halo. Used for unknown kinds — no
  // molecular geometry claim.
  const out: FigureNode[] = [{ id: 'n0', x: 0.5, y: 0.5, r: 0.14 }];
  const halo = Math.max(0, count - 1);
  for (let i = 0; i < halo; i++) {
    const a = (i / halo) * Math.PI * 2 + rng() * 0.05;
    out.push({
      id: `n${i + 1}`,
      x: 0.5 + Math.cos(a) * 0.34,
      y: 0.5 + Math.sin(a) * 0.34,
      r: 0.045,
    });
  }
  return out;
}

function latticeHex(rng: () => number, count: number): FigureNode[] {
  const out: FigureNode[] = [];
  const cols = Math.ceil(Math.sqrt(count * 1.5));
  const rows = Math.ceil(count / cols);
  const dx = 0.78 / Math.max(1, cols - 1);
  const dy = 0.62 / Math.max(1, rows - 1);
  let i = 0;
  for (let r = 0; r < rows && i < count; r++) {
    for (let c = 0; c < cols && i < count; c++) {
      const offset = r % 2 === 0 ? 0 : dx / 2;
      const jitter = (rng() - 0.5) * dx * 0.08;
      out.push({
        id: `n${i}`,
        x: 0.11 + c * dx + offset + jitter,
        y: 0.19 + r * dy + jitter,
        r: 0.05,
      });
      i++;
    }
  }
  return out;
}

function latticeCubic(rng: () => number, count: number): FigureNode[] {
  const out: FigureNode[] = [];
  const cols = Math.ceil(Math.sqrt(count));
  const rows = Math.ceil(count / cols);
  const dx = 0.74 / Math.max(1, cols - 1);
  const dy = 0.6 / Math.max(1, rows - 1);
  let i = 0;
  for (let r = 0; r < rows && i < count; r++) {
    for (let c = 0; c < cols && i < count; c++) {
      const jitter = (rng() - 0.5) * dx * 0.05;
      out.push({
        id: `n${i}`,
        x: 0.13 + c * dx + jitter,
        y: 0.2 + r * dy + jitter,
        r: 0.052,
      });
      i++;
    }
  }
  return out;
}

function clusterOrbital(rng: () => number, count: number): FigureNode[] {
  const out: FigureNode[] = [{ id: 'n0', x: 0.5, y: 0.5, r: 0.085 }];
  const shells = Math.max(1, Math.ceil((count - 1) / 6));
  let placed = 1;
  for (let s = 0; s < shells && placed < count; s++) {
    const radius = 0.12 + s * 0.13;
    const here = Math.min(count - placed, 6 + s * 2);
    for (let k = 0; k < here; k++) {
      const a = (k / here) * Math.PI * 2 + rng() * 0.2;
      out.push({
        id: `n${placed}`,
        x: 0.5 + Math.cos(a) * radius,
        y: 0.5 + Math.sin(a) * radius,
        r: 0.045,
      });
      placed++;
    }
  }
  return out;
}

function chainHelix(rng: () => number, count: number): FigureNode[] {
  const out: FigureNode[] = [];
  for (let i = 0; i < count; i++) {
    const t = i / Math.max(1, count - 1);
    out.push({
      id: `n${i}`,
      x: 0.1 + t * 0.8,
      y: 0.5 + Math.sin(t * Math.PI * 3 + rng() * 0.1) * 0.2,
      r: 0.05,
    });
  }
  return out;
}

function ringFused(rng: () => number, count: number): FigureNode[] {
  const out: FigureNode[] = [];
  const rings = Math.max(1, Math.ceil(count / 6));
  let placed = 0;
  for (let ring = 0; ring < rings && placed < count; ring++) {
    const cx = 0.32 + (ring % 2) * 0.36 + rng() * 0.02;
    const cy = 0.36 + Math.floor(ring / 2) * 0.28;
    const here = Math.min(6, count - placed);
    for (let k = 0; k < here; k++) {
      const a = (k / 6) * Math.PI * 2;
      out.push({
        id: `n${placed}`,
        x: cx + Math.cos(a) * 0.12,
        y: cy + Math.sin(a) * 0.12,
        r: 0.045,
      });
      placed++;
    }
  }
  return out;
}

function nodesForVariant(variant: string, rng: () => number, count: number): FigureNode[] {
  switch (variant) {
    case 'lattice-hex': return latticeHex(rng, count);
    case 'lattice-cubic': return latticeCubic(rng, count);
    case 'cluster-orbital': return clusterOrbital(rng, count);
    case 'chain-helix': return chainHelix(rng, count);
    case 'ring-fused': return ringFused(rng, count);
    case 'neutral-brand':
    default:
      return neutralBrand(rng, count);
  }
}

function buildLinks(nodes: FigureNode[], variant: string): FigureLink[] {
  if (variant === 'neutral-brand') {
    // No edges in the brand fallback — keep it visually quiet.
    return [];
  }
  if (variant === 'chain-helix') {
    const out: FigureLink[] = [];
    for (let i = 1; i < nodes.length; i++) {
      out.push({ id: `l${i - 1}`, from: nodes[i - 1].id, to: nodes[i].id });
    }
    return out;
  }
  // Default: nearest-neighbor (3 nearest) deterministic edges.
  const out: FigureLink[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < nodes.length; i++) {
    const a = nodes[i];
    const dists = nodes
      .map((b, j) => ({ j, d: (a.x - b.x) ** 2 + (a.y - b.y) ** 2 }))
      .filter((p) => p.j !== i)
      .sort((p, q) => p.d - q.d)
      .slice(0, 2);
    for (const p of dists) {
      const key = i < p.j ? `${i}-${p.j}` : `${p.j}-${i}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ id: `l${out.length}`, from: a.id, to: nodes[p.j].id });
    }
  }
  return out;
}

/**
 * Map a descriptor to its renderable geometry graph. Pure function of the
 * descriptor — same descriptor in, deep-equal graph out.
 */
export function buildFigureGraph(descriptor: CapsulePreviewDescriptor): FigureGraph {
  const count = DENSITY_NODE_COUNT[descriptor.density];
  const seed = fnv1a32(`${descriptor.shareCode}|${descriptor.figureVariant}`);
  const rng = mulberry32(seed);
  const nodes = nodesForVariant(descriptor.figureVariant, rng, count);
  const links = buildLinks(nodes, descriptor.figureVariant);
  return {
    nodes,
    links,
    accentColor: descriptor.accentColor,
    variant: descriptor.figureVariant,
    density: descriptor.density,
    themeVariant: descriptor.themeVariant,
  };
}

export const FIGURE_DENSITY_NODE_COUNT = DENSITY_NODE_COUNT;
