/**
 * Physics-config → store sync.
 *
 * The Settings sheet binds three physics knobs — damping, drag strength,
 * rotate strength — to the Zustand store (damping via a derived slider
 * position, drag/rotate directly). User edits flow store → physics via
 * `ui-bindings.onDampingChange` and siblings; nothing writes back the
 * other direction automatically.
 *
 * Two restore paths replace the physics config wholesale and must
 * therefore also push the new values into the store, or the UI drifts
 * out of sync with what the engine is actually using:
 *
 *   - Timeline restart-from-here (simulation-timeline-coordinator after
 *     applyRestartState)
 *   - Watch→Lab capsule hydrate (hydrate-from-watch-seed after the
 *     physics.setDamping/setDragStrength/setRotateStrength block)
 *
 * This module is the single place either path calls. Keep both paths
 * pointed here; do not inline the three `useAppStore.getState()` calls
 * at the call sites.
 *
 * Depends on: `src/ui/damping-slider` for the slider-value derivation
 *             (the one file that owns the cubic scale constant).
 */

import { useAppStore } from '../store/app-store';
import { dampingToSliderValue } from '../../../src/ui/damping-slider';

/** The subset of physics config that has a user-visible store mirror.
 *  Kept structurally compatible with both `RestartState['config']`
 *  (timeline path) and `WatchToLabHandoffPayload['workerConfig']`
 *  (hydrate path), so both restore sites pass their existing objects
 *  without a shape adapter. */
export interface MirroredPhysicsConfig {
  damping: number;
  kDrag: number;
  kRotate: number;
}

/** Push restored physics-config values into the Zustand store so the
 *  Settings sheet reflects engine reality after a restore. Idempotent
 *  and synchronous; safe to call inside a transaction's success branch
 *  before the pause/resume handoff. */
export function syncPhysicsConfigToStore(config: MirroredPhysicsConfig): void {
  const store = useAppStore.getState();
  store.setDampingSliderValue(dampingToSliderValue(config.damping));
  store.setDragStrength(config.kDrag);
  store.setRotateStrength(config.kRotate);
}
