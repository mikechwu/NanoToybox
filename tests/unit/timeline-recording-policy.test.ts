/**
 * Tests for the timeline recording policy module.
 *
 * Verifies:
 *  - disarmed by default
 *  - armed after markAtomInteractionStarted
 *  - idempotent arming
 *  - disarm resets to unarmed
 *  - re-arm after disarm works
 */

import { describe, it, expect } from 'vitest';
import { createTimelineRecordingPolicy } from '../../page/js/runtime/timeline-recording-policy';

describe('TimelineRecordingPolicy', () => {
  it('starts disarmed', () => {
    const policy = createTimelineRecordingPolicy();
    expect(policy.isArmed()).toBe(false);
  });

  it('arms on markAtomInteractionStarted', () => {
    const policy = createTimelineRecordingPolicy();
    policy.markAtomInteractionStarted();
    expect(policy.isArmed()).toBe(true);
  });

  it('arming is idempotent', () => {
    const policy = createTimelineRecordingPolicy();
    policy.markAtomInteractionStarted();
    policy.markAtomInteractionStarted();
    policy.markAtomInteractionStarted();
    expect(policy.isArmed()).toBe(true);
  });

  it('disarm resets to unarmed', () => {
    const policy = createTimelineRecordingPolicy();
    policy.markAtomInteractionStarted();
    expect(policy.isArmed()).toBe(true);
    policy.disarm();
    expect(policy.isArmed()).toBe(false);
  });

  it('can re-arm after disarm', () => {
    const policy = createTimelineRecordingPolicy();
    policy.markAtomInteractionStarted();
    policy.disarm();
    policy.markAtomInteractionStarted();
    expect(policy.isArmed()).toBe(true);
  });
});
