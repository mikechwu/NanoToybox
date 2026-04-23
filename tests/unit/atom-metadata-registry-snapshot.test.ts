/**
 * @vitest-environment jsdom
 */
/**
 * Standalone round-trip tests for AtomMetadataRegistry.snapshot/restore.
 * The hydrate transaction tests exercise these via the full commit/
 * rollback cycle; these tests lock the API contract in isolation so a
 * future consumer can rely on the documented behavior without running
 * the whole transaction.
 */
import { describe, it, expect } from 'vitest';
import { createAtomMetadataRegistry } from '../../lab/js/runtime/timeline/atom-metadata-registry';

describe('AtomMetadataRegistry snapshot + restore', () => {
  it('snapshot() of an empty registry is an empty array', () => {
    const r = createAtomMetadataRegistry();
    expect(r.snapshot()).toEqual([]);
  });

  it('snapshot captures all registered entries', () => {
    const r = createAtomMetadataRegistry();
    r.registerAppendedAtoms([0, 1], [{ element: 'C' }, { element: 'H' }]);
    const snap = r.snapshot();
    expect(snap).toHaveLength(2);
    // Order is Map-insertion order; sorted assertion is more stable.
    const byId = [...snap].sort((a, b) => a.id - b.id);
    expect(byId[0]).toEqual({ id: 0, element: 'C' });
    expect(byId[1]).toEqual({ id: 1, element: 'H' });
  });

  it('restore() replaces current state with the snapshot (discarding intervening registrations)', () => {
    const r = createAtomMetadataRegistry();
    r.registerAppendedAtoms([0, 1], [{ element: 'C' }, { element: 'C' }]);
    const snap = r.snapshot();
    // Register more atoms AFTER the snapshot.
    r.registerAppendedAtoms([2, 3], [{ element: 'H' }, { element: 'O' }]);
    expect(r.getAtomTable()).toHaveLength(4);
    // Restore discards the later registrations.
    r.restore(snap);
    expect(r.getAtomTable()).toHaveLength(2);
    expect(r.getAtomTable().map((e) => e.element)).toEqual(['C', 'C']);
  });

  it('restore() followed by new registrations does not re-mix into the restored state', () => {
    const r = createAtomMetadataRegistry();
    r.registerAppendedAtoms([10, 11], [{ element: 'C' }, { element: 'C' }]);
    const snap = r.snapshot();
    r.reset();
    expect(r.getAtomTable()).toHaveLength(0);
    r.restore(snap);
    expect(r.getAtomTable()).toHaveLength(2);
    // Registering a new id collides with nothing (they were already
    // written during restore via Map.set).
    r.registerAppendedAtoms([12], [{ element: 'N' }]);
    expect(r.getAtomTable()).toHaveLength(3);
  });

  it('snapshot is a deep copy — later registrations do not mutate the captured array', () => {
    const r = createAtomMetadataRegistry();
    r.registerAppendedAtoms([0], [{ element: 'C' }]);
    const snap = r.snapshot();
    r.registerAppendedAtoms([1], [{ element: 'H' }]);
    // The snapshot still reflects the pre-append state.
    expect(snap).toHaveLength(1);
    expect(snap[0]).toEqual({ id: 0, element: 'C' });
  });

  it('registerAppendedAtoms is append-only — re-registering an existing id throws', () => {
    // Stable atom IDs are monotonic for the lifetime of a session;
    // they are never reused. A caller trying to "overwrite" an id
    // is almost certainly confusing id with slot index — a
    // lifecycle bug that would corrupt identity upstream. Throw so
    // it surfaces at the origin instead of causing ghost atoms on
    // export.
    const r = createAtomMetadataRegistry();
    r.registerAppendedAtoms([0], [{ element: 'C' }]);
    expect(() => r.registerAppendedAtoms([0], [{ element: 'N' }]))
      .toThrow(/already registered/i);
    // The prior entry is preserved intact — atomic validation before
    // commit means a failed call never partially mutates state.
    expect(r.getAtomTable()[0].element).toBe('C');
  });

  it('registerAppendedAtoms rejects duplicate ids within the same batch', () => {
    const r = createAtomMetadataRegistry();
    expect(() => r.registerAppendedAtoms([5, 5], [{ element: 'C' }, { element: 'H' }]))
      .toThrow(/duplicate id/i);
    // Atomic: the registry stays empty — neither element committed.
    expect(r.getAtomTable()).toHaveLength(0);
  });

  it('registerAppendedAtoms is atomic under a mid-batch collision', () => {
    // If id N is already registered and a batch [new, N, also-new]
    // is submitted, NONE of the three entries should land. This
    // keeps the registry in a well-defined state after the throw.
    const r = createAtomMetadataRegistry();
    r.registerAppendedAtoms([1], [{ element: 'C' }]);
    expect(() => r.registerAppendedAtoms(
      [2, 1, 3],
      [{ element: 'H' }, { element: 'X' }, { element: 'O' }],
    )).toThrow(/already registered/i);
    expect(r.getAtomTable()).toHaveLength(1);
    expect(r.getAtomTable()[0].element).toBe('C');
  });

  it('restore into a pre-populated registry cleanly replaces all prior entries', () => {
    const r = createAtomMetadataRegistry();
    r.registerAppendedAtoms([0, 1], [{ element: 'Ne' }, { element: 'Ne' }]);
    const snap = r.snapshot();
    r.reset();
    r.registerAppendedAtoms([5, 6, 7], [{ element: 'Ar' }, { element: 'Ar' }, { element: 'Ar' }]);
    expect(r.getAtomTable()).toHaveLength(3);
    r.restore(snap);
    expect(r.getAtomTable()).toHaveLength(2);
    expect(r.getAtomTable().map((e) => e.id)).toEqual([0, 1]);
    expect(r.getAtomTable().every((e) => e.element === 'Ne')).toBe(true);
  });
});
