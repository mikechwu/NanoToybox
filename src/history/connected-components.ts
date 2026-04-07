/**
 * Connected-component computation from bond topology using union-find.
 *
 * Shared between lab/ (simulation-timeline review topology) and watch/ (imported bond topology).
 *
 * Owns:        union-find algorithm, component grouping
 * Depends on:  nothing (pure function)
 */

export interface BondedComponent {
  atoms: number[];
  size: number;
}

/**
 * Compute connected components from a bond list.
 * @param n — total atom count (dense prefix: indices 0..n-1)
 * @param bonds — bond tuples [atomA, atomB, distance]
 * @returns array of components, each with atom indices and size
 */
export function computeConnectedComponents(
  n: number,
  bonds: [number, number, number][],
): BondedComponent[] {
  if (n === 0) return [];

  // Zero bonds → every atom is its own singleton component
  if (bonds.length === 0) {
    return Array.from({ length: n }, (_, i) => ({ atoms: [i], size: 1 }));
  }

  // Union-find with path compression and union-by-rank
  const parent = new Int32Array(n);
  const rank = new Int32Array(n);
  for (let i = 0; i < n; i++) parent[i] = i;

  function find(x: number): number {
    while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; }
    return x;
  }

  function union(a: number, b: number): void {
    const ra = find(a), rb = find(b);
    if (ra === rb) return;
    if (rank[ra] < rank[rb]) parent[ra] = rb;
    else if (rank[ra] > rank[rb]) parent[rb] = ra;
    else { parent[rb] = ra; rank[ra]++; }
  }

  for (const [i, j] of bonds) {
    if (i >= 0 && j >= 0 && i < n && j < n) union(i, j);
  }

  const groups = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const root = find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root)!.push(i);
  }

  return Array.from(groups.values()).map(atoms => ({ atoms, size: atoms.length }));
}
