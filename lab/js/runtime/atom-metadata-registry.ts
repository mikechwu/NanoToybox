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

export interface AtomMetadataRegistry {
  /** Register metadata for newly appended atoms. */
  registerAppendedAtoms(
    ids: number[],
    atoms: { element: string }[],
    source?: AtomSource,
  ): void;
  /** Return the full atom table for export (all atoms ever registered). */
  getAtomTable(): AtomMetadataEntry[];
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

    reset(): void {
      _entries.clear();
    },
  };
}
