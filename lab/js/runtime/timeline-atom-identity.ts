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

export interface TimelineAtomIdentityTracker {
  /** Return current atomIds for slots 0..n-1 (cloned snapshot). */
  captureForCurrentState(n: number): number[];
  /** Assign new stable IDs for appended atoms. Returns the assigned IDs. */
  handleAppend(atomOffset: number, atomCount: number): number[];
  /** Update mapping after wall-remove compaction. keep[newIndex] = oldIndex. */
  handleCompaction(keep: number[]): void;
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
      const assignedIds: number[] = [];
      for (let i = 0; i < atomCount; i++) {
        const id = _nextAtomId++;
        assignedIds.push(id);
        // Ensure array is large enough, then set at the correct slot
        while (_slotToAtomId.length <= atomOffset + i) {
          _slotToAtomId.push(-1); // placeholder
        }
        _slotToAtomId[atomOffset + i] = id;
      }
      return assignedIds;
    },

    handleCompaction(keep: number[]): void {
      const newMapping: number[] = [];
      for (let newIdx = 0; newIdx < keep.length; newIdx++) {
        const oldIdx = keep[newIdx];
        newMapping[newIdx] = _slotToAtomId[oldIdx];
      }
      _slotToAtomId = newMapping;
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
