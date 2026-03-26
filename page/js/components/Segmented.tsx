/**
 * Segmented — shared native-radio segmented control.
 *
 * Uses <fieldset> + <input type="radio"> for native keyboard behavior:
 * single tab stop, arrow-key navigation, disabled-option skipping.
 * Visual indicator uses --seg-active CSS custom property (derived internally).
 *
 * The name prop is a stable technical ID for radio grouping; legend is the
 * human-readable group label (screen-reader visible via sr-only class).
 * useId() suffix guarantees page-unique radio groups.
 */

import React, { useId } from 'react';

export function Segmented<T extends string>({
  name,
  legend,
  items,
  activeValue,
  onSelect,
  className,
}: {
  name: string;
  legend: string;
  items: readonly { readonly value: T; readonly label: string; readonly disabled?: boolean }[];
  activeValue: T;
  onSelect: (value: T) => void;
  className?: string;
}) {
  const id = useId();
  const groupName = `${name}-${id}`;
  const activeIdx = items.findIndex((i) => i.value === activeValue);
  return (
    <fieldset
      className={className ? `segmented ${className}` : 'segmented'}
      style={{ '--seg-count': items.length, '--seg-active': activeIdx } as React.CSSProperties}
    >
      <legend className="sr-only">{legend}</legend>
      {items.map((item) => (
        <label
          key={item.value}
          className={`${item.value === activeValue ? 'active' : ''}${item.disabled ? ' seg-disabled' : ''}`}
        >
          <input
            type="radio"
            name={groupName}
            value={item.value}
            checked={item.value === activeValue}
            disabled={item.disabled}
            onChange={() => onSelect(item.value)}
          />
          {item.label}
        </label>
      ))}
    </fieldset>
  );
}
