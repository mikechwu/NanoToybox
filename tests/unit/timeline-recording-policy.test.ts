/**
 * Tests for the timeline recording policy 3-state machine.
 *
 * States: off → ready → active
 * Transitions:
 *   off  → ready   via turnOn()
 *   ready → active  via markAtomInteractionStarted()
 *   any  → off      via turnOff() or disarm()
 */

import { describe, it, expect } from 'vitest';
import { createTimelineRecordingPolicy } from '../../page/js/runtime/timeline-recording-policy';

describe('TimelineRecordingPolicy', () => {
  it('starts in off mode', () => {
    const policy = createTimelineRecordingPolicy();
    expect(policy.getMode()).toBe('off');
    expect(policy.isArmed()).toBe(false);
  });

  // ── turnOn transitions ──

  it('turnOn transitions off → ready', () => {
    const policy = createTimelineRecordingPolicy();
    policy.turnOn();
    expect(policy.getMode()).toBe('ready');
    expect(policy.isArmed()).toBe(false);
  });

  it('turnOn from ready is no-op', () => {
    const policy = createTimelineRecordingPolicy();
    policy.turnOn();
    policy.turnOn();
    expect(policy.getMode()).toBe('ready');
  });

  it('turnOn from active is no-op', () => {
    const policy = createTimelineRecordingPolicy();
    policy.turnOn();
    policy.markAtomInteractionStarted();
    expect(policy.getMode()).toBe('active');
    policy.turnOn();
    expect(policy.getMode()).toBe('active');
  });

  // ── markAtomInteractionStarted transitions ──

  it('markAtomInteractionStarted transitions ready → active', () => {
    const policy = createTimelineRecordingPolicy();
    policy.turnOn();
    policy.markAtomInteractionStarted();
    expect(policy.getMode()).toBe('active');
    expect(policy.isArmed()).toBe(true);
  });

  it('markAtomInteractionStarted from off is no-op', () => {
    const policy = createTimelineRecordingPolicy();
    policy.markAtomInteractionStarted();
    expect(policy.getMode()).toBe('off');
    expect(policy.isArmed()).toBe(false);
  });

  it('markAtomInteractionStarted from active is idempotent', () => {
    const policy = createTimelineRecordingPolicy();
    policy.turnOn();
    policy.markAtomInteractionStarted();
    policy.markAtomInteractionStarted();
    policy.markAtomInteractionStarted();
    expect(policy.getMode()).toBe('active');
    expect(policy.isArmed()).toBe(true);
  });

  // ── turnOff / disarm transitions ──

  it('turnOff from ready → off', () => {
    const policy = createTimelineRecordingPolicy();
    policy.turnOn();
    policy.turnOff();
    expect(policy.getMode()).toBe('off');
    expect(policy.isArmed()).toBe(false);
  });

  it('turnOff from active → off', () => {
    const policy = createTimelineRecordingPolicy();
    policy.turnOn();
    policy.markAtomInteractionStarted();
    policy.turnOff();
    expect(policy.getMode()).toBe('off');
    expect(policy.isArmed()).toBe(false);
  });

  it('turnOff from off is no-op', () => {
    const policy = createTimelineRecordingPolicy();
    policy.turnOff();
    expect(policy.getMode()).toBe('off');
  });

  it('disarm transitions to off (same as turnOff)', () => {
    const policy = createTimelineRecordingPolicy();
    policy.turnOn();
    policy.markAtomInteractionStarted();
    expect(policy.isArmed()).toBe(true);
    policy.disarm();
    expect(policy.getMode()).toBe('off');
    expect(policy.isArmed()).toBe(false);
  });

  // ── Full lifecycle cycles ──

  it('full cycle: off → ready → active → off → ready → active', () => {
    const policy = createTimelineRecordingPolicy();
    expect(policy.getMode()).toBe('off');

    policy.turnOn();
    expect(policy.getMode()).toBe('ready');

    policy.markAtomInteractionStarted();
    expect(policy.getMode()).toBe('active');

    policy.turnOff();
    expect(policy.getMode()).toBe('off');

    policy.turnOn();
    expect(policy.getMode()).toBe('ready');

    policy.markAtomInteractionStarted();
    expect(policy.getMode()).toBe('active');
  });

  it('re-arm after disarm requires turnOn first', () => {
    const policy = createTimelineRecordingPolicy();
    policy.turnOn();
    policy.markAtomInteractionStarted();
    policy.disarm();
    // Now in off — markAtomInteractionStarted is no-op
    policy.markAtomInteractionStarted();
    expect(policy.getMode()).toBe('off');
    // Must turnOn first
    policy.turnOn();
    policy.markAtomInteractionStarted();
    expect(policy.getMode()).toBe('active');
  });

  // ── startNow (explicit enable) ──

  it('startNow transitions off → active directly', () => {
    const policy = createTimelineRecordingPolicy();
    policy.startNow();
    expect(policy.getMode()).toBe('active');
    expect(policy.isArmed()).toBe(true);
  });

  it('startNow from ready is no-op', () => {
    const policy = createTimelineRecordingPolicy();
    policy.turnOn();
    expect(policy.getMode()).toBe('ready');
    policy.startNow();
    expect(policy.getMode()).toBe('ready');
  });

  it('startNow from active is no-op', () => {
    const policy = createTimelineRecordingPolicy();
    policy.startNow();
    expect(policy.getMode()).toBe('active');
    policy.startNow();
    expect(policy.getMode()).toBe('active');
  });

  it('full cycle with startNow: off → active → off → active', () => {
    const policy = createTimelineRecordingPolicy();
    policy.startNow();
    expect(policy.getMode()).toBe('active');
    policy.turnOff();
    expect(policy.getMode()).toBe('off');
    policy.startNow();
    expect(policy.getMode()).toBe('active');
  });
});
