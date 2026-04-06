/** Timeline hint text constants — single source of truth for all timeline tooltip copy.
 *  Used by TimelineBar, timeline-mode-switch, and timeline-clear-dialog via ActionHint.
 *
 *  These hints are desktop/keyboard discoverability only. On touch/coarse-pointer
 *  devices, ActionHint tooltips are CSS-hidden (see lab/index.html media query).
 *  Touch discoverability relies on visible button labels and aria-labels instead. */

export const TIMELINE_HINTS = {
  startRecording: 'Start saving timeline history now.',
  returnToSimulation: 'Back to the current simulation.',
  enterReview: 'Enter review mode at the current time.',
  enterReviewDisabled: 'No recorded history to review yet.',
  restartFromHere: 'Restart the simulation from this point.',
  clearHistory: 'Stop recording and clear timeline history.',
} as const;
