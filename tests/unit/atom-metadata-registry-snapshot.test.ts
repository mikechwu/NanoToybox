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
import { createAtomMetadataRegistry } from '../../lab/js/runtime/atom-metadata-registry';

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

  it('overwriting an id via registerAppendedAtoms survives snapshot/restore (last-write-wins)', () => {
    const r = createAtomMetadataRegistry();
    r.registerAppendedAtoms([0], [{ element: 'C' }]);
    r.registerAppendedAtoms([0], [{ element: 'N' }]); // overwrite
    const snap = r.snapshot();
    expect(snap).toHaveLength(1);
    expect(snap[0].element).toBe('N');
    r.reset();
    r.restore(snap);
    expect(r.getAtomTable()[0].element).toBe('N');
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
