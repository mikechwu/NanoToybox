/**
 * Tests for the timeline recording policy module.
 *
 * Verifies:
 *  - disarmed by default
 *  - armed after markUserEngaged
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

  it('arms on markUserEngaged', () => {
    const policy = createTimelineRecordingPolicy();
    policy.markUserEngaged();
    expect(policy.isArmed()).toBe(true);
  });

  it('arming is idempotent', () => {
    const policy = createTimelineRecordingPolicy();
    policy.markUserEngaged();
    policy.markUserEngaged();
    policy.markUserEngaged();
    expect(policy.isArmed()).toBe(true);
  });

  it('disarm resets to unarmed', () => {
    const policy = createTimelineRecordingPolicy();
    policy.markUserEngaged();
    expect(policy.isArmed()).toBe(true);
    policy.disarm();
    expect(policy.isArmed()).toBe(false);
  });

  it('can re-arm after disarm', () => {
    const policy = createTimelineRecordingPolicy();
    policy.markUserEngaged();
    policy.disarm();
    policy.markUserEngaged();
    expect(policy.isArmed()).toBe(true);
  });
});
