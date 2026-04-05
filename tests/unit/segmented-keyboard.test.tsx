/**
 * @vitest-environment jsdom
 */
/**
 * Unit tests for Segmented DOM structure that enables keyboard behavior.
 *
 * Native radio-group keyboard behavior (arrow-key navigation, disabled-option
 * skipping) is provided by the browser, not by React code. These tests verify
 * the DOM prerequisites: shared group name, disabled attributes, label wrapping.
 * Actual arrow-key navigation is tested in E2E (see smoke.spec.ts).
 */
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { Segmented } from '../../lab/js/components/Segmented';

const ITEMS = [
  { value: 'a', label: 'Alpha' },
  { value: 'b', label: 'Beta' },
  { value: 'c', label: 'Gamma' },
] as const;

describe('Segmented DOM structure for keyboard', () => {
  it('fires onSelect when a radio is clicked', () => {
    const onSelect = vi.fn();
    const { container } = render(
      <Segmented name="kb" legend="Test" items={ITEMS} activeValue="a" onSelect={onSelect} />
    );
    const radios = container.querySelectorAll('input[type="radio"]');
    fireEvent.click(radios[1]);
    expect(onSelect).toHaveBeenCalledWith('b');
  });

  it('disabled radio has disabled attribute set', () => {
    const items = [
      { value: 'x', label: 'X' },
      { value: 'y', label: 'Y', disabled: true },
      { value: 'z', label: 'Z' },
    ] as const;
    const { container } = render(
      <Segmented name="kb" legend="Test" items={items} activeValue="x" onSelect={() => {}} />
    );
    const radios = container.querySelectorAll('input[type="radio"]');
    expect((radios[0] as HTMLInputElement).disabled).toBe(false);
    expect((radios[1] as HTMLInputElement).disabled).toBe(true);
    expect((radios[2] as HTMLInputElement).disabled).toBe(false);
  });

  it('all radios share the same group name (keyboard navigation prerequisite)', () => {
    const { container } = render(
      <Segmented name="nav" legend="Nav" items={ITEMS} activeValue="a" onSelect={() => {}} />
    );
    const radios = Array.from(container.querySelectorAll('input[type="radio"]'));
    const names = radios.map(r => (r as HTMLInputElement).name);
    expect(new Set(names).size).toBe(1);
  });

  it('radio inputs are inside labels (wrapping pattern for click delegation)', () => {
    const { container } = render(
      <Segmented name="size" legend="Size" items={ITEMS} activeValue="a" onSelect={() => {}} />
    );
    const radio = container.querySelector('input[type="radio"]') as HTMLInputElement;
    const label = radio.closest('label');
    expect(label).not.toBeNull();
    expect(label!.contains(radio)).toBe(true);
  });
});
