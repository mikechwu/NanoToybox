/**
 * @vitest-environment jsdom
 */
/**
 * Unit tests for shared Segmented component.
 *
 * Tests: correct active index, radio checked state, onSelect callback,
 * disabled options, group labeling.
 */
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { Segmented } from '../../page/js/components/Segmented';

const ITEMS = [
  { value: 'a', label: 'Alpha' },
  { value: 'b', label: 'Beta' },
  { value: 'c', label: 'Gamma' },
] as const;

describe('Segmented', () => {
  it('renders all items as radio inputs', () => {
    const { container } = render(
      <Segmented name="test" legend="Test group" items={ITEMS} activeValue="a" onSelect={() => {}} />
    );
    const radios = container.querySelectorAll('input[type="radio"]');
    expect(radios.length).toBe(3);
  });

  it('checks the active radio', () => {
    const { container } = render(
      <Segmented name="test" legend="Test group" items={ITEMS} activeValue="b" onSelect={() => {}} />
    );
    const radios = container.querySelectorAll('input[type="radio"]');
    expect((radios[0] as HTMLInputElement).checked).toBe(false);
    expect((radios[1] as HTMLInputElement).checked).toBe(true);
    expect((radios[2] as HTMLInputElement).checked).toBe(false);
  });

  it('sets --seg-active CSS variable to the active index', () => {
    const { container } = render(
      <Segmented name="test" legend="Test group" items={ITEMS} activeValue="c" onSelect={() => {}} />
    );
    const fieldset = container.querySelector('fieldset.segmented') as HTMLElement;
    expect(fieldset.style.getPropertyValue('--seg-active')).toBe('2');
  });

  it('sets --seg-count CSS variable to item count', () => {
    const { container } = render(
      <Segmented name="test" legend="Test group" items={ITEMS} activeValue="a" onSelect={() => {}} />
    );
    const fieldset = container.querySelector('fieldset.segmented') as HTMLElement;
    expect(fieldset.style.getPropertyValue('--seg-count')).toBe('3');
  });

  it('calls onSelect with the typed value on change', () => {
    const onSelect = vi.fn();
    const { container } = render(
      <Segmented name="test" legend="Test group" items={ITEMS} activeValue="a" onSelect={onSelect} />
    );
    const radios = container.querySelectorAll('input[type="radio"]');
    // Simulate clicking the second radio
    (radios[1] as HTMLInputElement).click();
    expect(onSelect).toHaveBeenCalledWith('b');
  });

  it('renders a sr-only legend', () => {
    const { container } = render(
      <Segmented name="test" legend="My Legend" items={ITEMS} activeValue="a" onSelect={() => {}} />
    );
    const legend = container.querySelector('legend.sr-only');
    expect(legend).not.toBeNull();
    expect(legend?.textContent).toBe('My Legend');
  });

  it('disables individual items', () => {
    const items = [
      { value: 'x', label: 'X' },
      { value: 'y', label: 'Y', disabled: true },
    ] as const;
    const { container } = render(
      <Segmented name="test" legend="Test" items={items} activeValue="x" onSelect={() => {}} />
    );
    const radios = container.querySelectorAll('input[type="radio"]');
    expect((radios[0] as HTMLInputElement).disabled).toBe(false);
    expect((radios[1] as HTMLInputElement).disabled).toBe(true);
  });

  it('applies additional className', () => {
    const { container } = render(
      <Segmented name="test" legend="Test" className="extra" items={ITEMS} activeValue="a" onSelect={() => {}} />
    );
    const fieldset = container.querySelector('fieldset.segmented.extra');
    expect(fieldset).not.toBeNull();
  });

  it('uses unique radio names via useId', () => {
    const { container } = render(
      <div>
        <Segmented name="group" legend="First" items={ITEMS} activeValue="a" onSelect={() => {}} />
        <Segmented name="group" legend="Second" items={ITEMS} activeValue="b" onSelect={() => {}} />
      </div>
    );
    const radios = container.querySelectorAll('input[type="radio"]');
    // 6 radios total (3 + 3), grouped by unique names
    expect(radios.length).toBe(6);
    const firstName = (radios[0] as HTMLInputElement).name;
    const secondName = (radios[3] as HTMLInputElement).name;
    // Names should differ despite same base "group"
    expect(firstName).not.toBe(secondName);
    // Both should start with "group-"
    expect(firstName.startsWith('group-')).toBe(true);
    expect(secondName.startsWith('group-')).toBe(true);
  });
});
