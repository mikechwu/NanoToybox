/**
 * Even-spaced index sampling for the capsule preview pipeline (spec §S1,
 * §Account Integration §3).
 *
 * Single source of truth for "pick exactly `target` items from `items`,
 * keeping the first and last so the visual extents survive". Used by:
 *   - `src/share/publish-core.ts` — server-side downsample to the storage cap
 *   - `functions/api/account/capsules/index.ts` — server-side downsample to
 *     the account-row atom cap (ROW_ATOM_CAP)
 *
 * **Not a V2 client consumer.** The account client renders
 * `previewThumb.atoms` verbatim — the server is the single point of
 * downsampling on the read path (spec AC #26).
 */

/** Pick exactly `target` items from `items`, evenly spaced across the
 *  range. Preserves array coverage by index — **not** silhouette — so
 *  it's appropriate for small-ordered sequences (e.g. linear chains)
 *  but poor for clustered molecular structures. For molecular preview
 *  generation, prefer {@link sampleForSilhouette}. Kept as the
 *  deterministic fallback and for non-spatial contexts.
 *
 *  Guarantees:
 *   - `n === 0` → `[]`
 *   - `target <= 0` → `[]`
 *   - `n <= target` → `items.slice()` (no over-eager re-sampling)
 *   - `target === 1` → the middle item
 *   - `n > target >= 2` → strictly monotone index sequence, no collisions */
export function sampleEvenly<T>(items: ReadonlyArray<T>, target: number): T[] {
  const n = items.length;
  if (n === 0 || target <= 0) return [];
  if (n <= target) return items.slice();
  if (target === 1) return [items[Math.floor((n - 1) / 2)]];
  const out: T[] = [];
  const denom = target - 1;
  for (let i = 0; i < target; i++) {
    const idx = Math.round((i * (n - 1)) / denom);
    out.push(items[idx]);
  }
  return out;
}

/**
 * Silhouette-preserving sampler (spec follow-up — replaces `sampleEvenly`
 * for molecular preview generation).
 *
 * Strategy:
 *   1. Seed with the four axis-aligned extrema (min/max x, min/max y). These
 *      anchor the structure's visual envelope, which index-sampling misses.
 *   2. Fill remaining budget with farthest-point sampling (FPS): repeatedly
 *      pick the point maximally distant from any already-picked point.
 *      This preserves cluster representatives and distinctive substructures
 *      (inner atoms, protrusions) that even-index stride drops.
 *
 * Returns items in their original array order so the caller can reconcile
 * index-based references (e.g. bond pairs) by id translation.
 *
 * Complexity: O(target × n). For the production case n ≤ 512, target ≤ 32,
 * this is ≤16 000 operations per scene — trivial on the publish path.
 *
 * Pure; no side effects; deterministic for identical input (ties broken by
 * first-seen index).
 */
export function sampleForSilhouette<T>(
  items: ReadonlyArray<T>,
  target: number,
  getX: (item: T) => number,
  getY: (item: T) => number,
  getZ?: (item: T) => number,
): T[] {
  const n = items.length;
  if (n === 0 || target <= 0) return [];
  if (n <= target) return items.slice();

  const kept = new Set<number>();
  // Phase 1: axis extrema (up to 4 unique indices). Seed only while we
  // still have budget — when `target` is 1..3 we intentionally skip some
  // extrema so the output respects the exact-count contract.
  let iMinX = 0, iMaxX = 0, iMinY = 0, iMaxY = 0;
  for (let i = 1; i < n; i++) {
    if (getX(items[i]) < getX(items[iMinX])) iMinX = i;
    if (getX(items[i]) > getX(items[iMaxX])) iMaxX = i;
    if (getY(items[i]) < getY(items[iMinY])) iMinY = i;
    if (getY(items[i]) > getY(items[iMaxY])) iMaxY = i;
  }
  // Deterministic seed order: minX, maxX, minY, maxY. If target caps us
  // before all four fit, at least the x-axis extrema survive — those are
  // usually the more visually load-bearing anchors in a horizontal OG pane.
  for (const idx of [iMinX, iMaxX, iMinY, iMaxY]) {
    if (kept.size >= target) break;
    kept.add(idx);
  }

  // Phase 2: farthest-point sampling. Maintain a per-item cached distance
  // to the current picked set so each FPS pick is O(n), not O(n × picked).
  const dist: Float64Array = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    if (kept.has(i)) { dist[i] = -1; continue; }
    let best = Infinity;
    for (const j of kept) {
      const dx = getX(items[i]) - getX(items[j]);
      const dy = getY(items[i]) - getY(items[j]);
      const dz = getZ ? getZ(items[i]) - getZ(items[j]) : 0;
      const d = dx * dx + dy * dy + dz * dz;
      if (d < best) best = d;
    }
    dist[i] = best;
  }
  while (kept.size < target) {
    let pickIdx = -1;
    let pickDist = -1;
    for (let i = 0; i < n; i++) {
      if (dist[i] < 0) continue;
      if (dist[i] > pickDist) { pickDist = dist[i]; pickIdx = i; }
    }
    if (pickIdx === -1) break;
    kept.add(pickIdx);
    dist[pickIdx] = -1;
    // Update cached distances against the newly picked point.
    for (let i = 0; i < n; i++) {
      if (dist[i] < 0) continue;
      const dx = getX(items[i]) - getX(items[pickIdx]);
      const dy = getY(items[i]) - getY(items[pickIdx]);
      const dz = getZ ? getZ(items[i]) - getZ(items[pickIdx]) : 0;
      const d = dx * dx + dy * dy + dz * dz;
      if (d < dist[i]) dist[i] = d;
    }
  }

  const indices = Array.from(kept).sort((a, b) => a - b);
  return indices.map((i) => items[i]);
}

/**
 * Bond-aware thumb sampler. Picks an atom subset that preserves both
 * the structure's shape envelope AND enough local adjacency for a
 * rendered bond skeleton to survive.
 *
 * The pure `sampleForSilhouette` sampler is structurally hostile to
 * bonded thumbs: its farthest-point objective spreads survivors to the
 * extremes, and bonds (which connect spatial neighbors by definition)
 * rarely have both endpoints in the output. This sampler splits the
 * budget into three phases:
 *
 *   1. **Silhouette seed** — up to ~half the target via extrema + FPS.
 *      Locks in shape anchors that make the thumb recognizable.
 *   2. **Bond expansion** — iterate storage bonds in descending
 *      projected-length order. For each bond:
 *        - if one endpoint is already kept, add the other (completes
 *          a visible edge by stretching outward from the kept atom)
 *        - if neither endpoint is kept AND 2 slots remain, add both
 *          (creates a brand-new edge anchored to nothing, but still
 *          carries a bonded pair into the thumb)
 *   3. **FPS fill** — spend any leftover budget on farthest-point
 *      picks from the remainder so the final set isn't just
 *      connected clusters.
 *
 * Returns items in original storage order (sorted ascending indices),
 * preserving the `ThumbAtomSampler` contract for bond-index translation
 * in `derivePreviewThumbV1`.
 */
export function sampleForBondedThumb<T>(
  atoms: ReadonlyArray<T>,
  bonds: ReadonlyArray<{ a: number; b: number }>,
  target: number,
  getX: (item: T) => number,
  getY: (item: T) => number,
  getZ?: (item: T) => number,
): T[] {
  const n = atoms.length;
  if (n === 0 || target <= 0) return [];
  if (n <= target) return atoms.slice();

  // Phase 1: silhouette seed — small, so bond expansion (Phase 2)
  // dominates the final set. Using only a few anchors preserves the
  // structure's envelope without pushing the budget into spatially-
  // spread dots that can't be connected by surviving bonds.
  const silhouetteBudget = Math.min(target, Math.max(2, Math.ceil(target / 4)));
  const silhouetteAtoms = sampleForSilhouette(
    atoms, silhouetteBudget, getX, getY, getZ,
  );
  const refToIdx = new Map<T, number>();
  for (let i = 0; i < n; i++) refToIdx.set(atoms[i], i);
  const kept = new Set<number>();
  for (const a of silhouetteAtoms) {
    const idx = refToIdx.get(a);
    if (idx != null) kept.add(idx);
  }

  // Build adjacency for graph-aware BFS expansion.
  const adj = new Map<number, number[]>();
  for (const b of bonds) {
    if (b.a === b.b || b.a < 0 || b.a >= n || b.b < 0 || b.b >= n) continue;
    if (!adj.has(b.a)) adj.set(b.a, []);
    if (!adj.has(b.b)) adj.set(b.b, []);
    adj.get(b.a)!.push(b.b);
    adj.get(b.b)!.push(b.a);
  }

  // Phase 2: graph-aware BFS expansion from the seeded atoms. For each
  // candidate atom, prefer those whose inclusion CLOSES the most new
  // edges against the already-kept set (i.e., atoms connected to many
  // kept atoms). This preserves recognizable local topology — cycles
  // in a cage, chains in a CNT, neighborhoods in a lattice — rather
  // than just maximizing long edges.
  while (kept.size < target) {
    let bestIdx = -1;
    let bestScore = -Infinity;
    for (let i = 0; i < n; i++) {
      if (kept.has(i)) continue;
      const neighbors = adj.get(i);
      if (!neighbors) continue;
      // Count how many already-kept neighbors this atom would connect to.
      // Atoms that complete multiple kept-adjacencies are strongly
      // preferred — they add both connectivity and local-structure cues.
      let connections = 0;
      for (const nb of neighbors) {
        if (kept.has(nb)) connections++;
      }
      if (connections === 0) continue;
      // Secondary tiebreak: distance from nearest kept atom. Prefer
      // candidates that are FARTHER (so the kept set still expands
      // spatially instead of collapsing into one cluster).
      let minDist = Infinity;
      for (const j of kept) {
        const dx = getX(atoms[i]) - getX(atoms[j]);
        const dy = getY(atoms[i]) - getY(atoms[j]);
        const dz = getZ ? getZ(atoms[i]) - getZ(atoms[j]) : 0;
        const d = dx * dx + dy * dy + dz * dz;
        if (d < minDist) minDist = d;
      }
      // Score: connection count dominates; distance is the tiebreak.
      // `connections * 10 + sqrt(minDist)` keeps both influences without
      // one swamping the other for typical scales (connections 1-4,
      // distance 0.1-10).
      const score = connections * 10 + Math.sqrt(minDist);
      if (score > bestScore) {
        bestScore = score;
        bestIdx = i;
      }
    }
    if (bestIdx < 0) break; // no more atoms share a bond with the kept set
    kept.add(bestIdx);
  }

  // Phase 3: FPS fill if BFS exhausted (e.g. the bond graph is
  // disconnected, or seeds landed on isolated atoms). Purely spatial
  // fallback so the final atom count hits `target` when possible.
  if (kept.size < target) {
    while (kept.size < target) {
      let bestIdx = -1;
      let bestMinDist = -1;
      for (let i = 0; i < n; i++) {
        if (kept.has(i)) continue;
        let minDist = Infinity;
        for (const j of kept) {
          const dx = getX(atoms[i]) - getX(atoms[j]);
          const dy = getY(atoms[i]) - getY(atoms[j]);
          const dz = getZ ? getZ(atoms[i]) - getZ(atoms[j]) : 0;
          const d = dx * dx + dy * dy + dz * dz;
          if (d < minDist) minDist = d;
        }
        if (minDist > bestMinDist) {
          bestMinDist = minDist;
          bestIdx = i;
        }
      }
      if (bestIdx < 0) break;
      kept.add(bestIdx);
    }
  }

  const indices = Array.from(kept).sort((a, b) => a - b);
  return indices.map((i) => atoms[i]);
}
