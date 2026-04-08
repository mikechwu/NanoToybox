/**
 * useSheetAnimation — re-exports shared sheet lifecycle hook.
 *
 * Lab consumers (SettingsSheet, StructureChooser) import from this path.
 * The implementation is in src/ui/useSheetLifecycle.ts (shared with watch).
 */

import { useSheetLifecycle, type SheetLifecycle } from '../../../src/ui/useSheetLifecycle';

export function useSheetAnimation(isOpen: boolean): SheetLifecycle {
  return useSheetLifecycle(isOpen);
}
