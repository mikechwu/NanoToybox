/**
 * AtomMetadataRegistry — persistent atom metadata keyed by stable atom ID.
 *
 * Owns:        id → { element, source } mapping
 * Depends on:  nothing (pure state)
 * Called by:   scene-runtime (registerAppendedAtoms after commit),
 *              history-export (getAtomTable for export)
 * Teardown:    reset() clears all state
 */

export interface AtomMetadataEntry {
  id: number;
  element: string;
}

export interface AtomSource {
  file: string;
  label: string;
}

/** Opaque snapshot handle — plain array of entries so the restore path
 *  rebuilds the Map deterministically without holding a reference to
 *  the live internal state. See `snapshot()` / `restore()`. */
export type AtomMetadataSnapshot = readonly AtomMetadataEntry[];

export interface AtomMetadataRegistry {
  /** Register metadata for newly appended atoms.
   *
   *  NOTE: the optional `source` argument is accepted for future use
   *  but is NOT persisted in the registry's state today. The snapshot /
   *  restore cycle round-trips only `{id, element}` per atom, so
   *  rollback cannot restore source attribution that was never
   *  captured. If a future feature needs rollback-safe source tags,
   *  extend `AtomMetadataEntry` with a `source` field and update
   *  `snapshot()` / `restore()` together — do NOT add a parallel
   *  store that skips the snapshot path. Documented explicitly so
   *  the silent drop isn't mistaken for an oversight. */
  registerAppendedAtoms(
    ids: number[],
    atoms: { element: string }[],
    source?: AtomSource,
  ): void;
  /** Return the full atom table for export (all atoms ever registered). */
  getAtomTable(): AtomMetadataEntry[];
  /** Capture a deep copy of the registry's current state. Used by the
   *  Watch → Lab hydrate transaction (§7.1) to support rollback: the
   *  transaction calls `snapshot()` before destructive commits, and
   *  `restore(snap)` on any mid-transaction failure. Pure clone of the
   *  `id → {id, element}` map — no references into live state. */
  snapshot(): AtomMetadataSnapshot;
  /** Atomically replace the registry's state with a prior snapshot.
   *  Discards any state accumulated since `snapshot()` was called. */
  restore(snapshot: AtomMetadataSnapshot): void;
  /** Reset all state (new scene / teardown). */
  reset(): void;
}

export function createAtomMetadataRegistry(): AtomMetadataRegistry {
  const _entries = new Map<number, AtomMetadataEntry>();

  return {
    registerAppendedAtoms(ids, atoms, _source) {
      if (ids.length !== atoms.length) {
        throw new Error(`registerAppendedAtoms: ids.length (${ids.length}) !== atoms.length (${atoms.length})`);
      }
      for (let i = 0; i < ids.length; i++) {
        const element = atoms[i]?.element;
        if (!element) {
          throw new Error(`registerAppendedAtoms: atom at index ${i} (id=${ids[i]}) has no element`);
        }
        _entries.set(ids[i], { id: ids[i], element });
      }
    },

    getAtomTable(): AtomMetadataEntry[] {
      return Array.from(_entries.values()).sort((a, b) => a.id - b.id);
    },

    snapshot(): AtomMetadataSnapshot {
      // Deep copy each entry so a later `registerAppendedAtoms` that
      // writes `_entries.set(ids[i], { id, element })` cannot mutate
      // the snapshotted objects. Order is irrelevant to restore since
      // it rebuilds the Map keyed by id.
      const out: AtomMetadataEntry[] = new Array(_entries.size);
      let i = 0;
      for (const entry of _entries.values()) {
        out[i++] = { id: entry.id, element: entry.element };
      }
      return out;
    },

    restore(snapshot: AtomMetadataSnapshot): void {
      _entries.clear();
      for (const entry of snapshot) {
        _entries.set(entry.id, { id: entry.id, element: entry.element });
      }
    },

    reset(): void {
      _entries.clear();
    },
  };
}
