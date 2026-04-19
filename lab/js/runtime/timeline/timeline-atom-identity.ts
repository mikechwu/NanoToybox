/**
 * TimelineAtomIdentityTracker — stable atom ID assignment through the
 * dense-prefix append/compaction lifecycle.
 *
 * Owns:        slotToAtomId mapping, nextAtomId counter
 * Depends on:  nothing (pure state machine)
 * Called by:   scene-runtime (append), physics compaction listener,
 *              recording orchestrator (capture for each frame)
 * Teardown:    reset() clears all state
 */

/** Opaque tracker state snapshot. Plain data so `restore()` rebuilds
 *  deterministically without sharing references with the live state. */
export interface TimelineAtomIdentitySnapshot {
  readonly slotToAtomId: readonly number[];
  readonly nextAtomId: number;
}

export interface TimelineAtomIdentityTracker {
  /** Return current atomIds for slots 0..n-1 (cloned snapshot). */
  captureForCurrentState(n: number): number[];
  /** Assign new stable IDs for appended atoms. Returns the assigned IDs. */
  handleAppend(atomOffset: number, atomCount: number): number[];
  /** Update mapping after wall-remove compaction. keep[newIndex] = oldIndex. */
  handleCompaction(keep: number[]): void;
  /** Capture a deep copy of the tracker's state for rollback (§7.1
   *  Watch → Lab hydrate transaction). Called before destructive
   *  commits so a mid-transaction failure can reinstate the prior
   *  identity mapping verbatim. */
  snapshot(): TimelineAtomIdentitySnapshot;
  /** Atomically replace the tracker's state with a prior snapshot.
   *  Discards any identity assignments made since `snapshot()`. */
  restore(snapshot: TimelineAtomIdentitySnapshot): void;
  /** Reset all state (new scene / teardown). */
  reset(): void;
  /** Total number of unique atoms ever assigned (for atom table size). */
  getTotalAssigned(): number;
}

export function createTimelineAtomIdentityTracker(): TimelineAtomIdentityTracker {
  let _slotToAtomId: number[] = [];
  let _nextAtomId = 0;

  return {
    captureForCurrentState(n: number): number[] {
      // If tracker hasn't been initialized yet (initial atoms before first append),
      // auto-assign IDs for slots 0..n-1
      while (_slotToAtomId.length < n) {
        _slotToAtomId.push(_nextAtomId++);
      }
      return _slotToAtomId.slice(0, n);
    },

    handleAppend(atomOffset: number, atomCount: number): number[] {
      if (atomOffset !== _slotToAtomId.length) {
        throw new Error(`handleAppend: non-contiguous append (expected offset ${_slotToAtomId.length}, got ${atomOffset}). Tracker may be uninitialized for pre-existing atoms.`);
      }
      const assignedIds: number[] = [];
      for (let i = 0; i < atomCount; i++) {
        const id = _nextAtomId++;
        assignedIds.push(id);
        _slotToAtomId.push(id);
      }
      return assignedIds;
    },

    handleCompaction(keep: number[]): void {
      const newMapping: number[] = [];
      for (let newIdx = 0; newIdx < keep.length; newIdx++) {
        const oldIdx = keep[newIdx];
        if (oldIdx < 0 || oldIdx >= _slotToAtomId.length) {
          throw new Error(`handleCompaction: oldIdx ${oldIdx} out of range [0, ${_slotToAtomId.length})`);
        }
        newMapping[newIdx] = _slotToAtomId[oldIdx];
      }
      _slotToAtomId = newMapping;
    },

    snapshot(): TimelineAtomIdentitySnapshot {
      // Array copy — numbers are primitives so a shallow copy is a
      // full deep copy for this state.
      return {
        slotToAtomId: _slotToAtomId.slice(),
        nextAtomId: _nextAtomId,
      };
    },

    restore(snapshot: TimelineAtomIdentitySnapshot): void {
      _slotToAtomId = snapshot.slotToAtomId.slice();
      _nextAtomId = snapshot.nextAtomId;
    },

    reset(): void {
      _slotToAtomId = [];
      _nextAtomId = 0;
    },

    getTotalAssigned(): number {
      return _nextAtomId;
    },
  };
}
