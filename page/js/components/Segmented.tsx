/**
 * Segmented — shared native-radio segmented control.
 *
 * Uses <fieldset> + <input type="radio"> for native keyboard behavior:
 * single tab stop, arrow-key navigation, disabled-option skipping.
 * Visual indicator uses --seg-active CSS custom property (derived internally).
 *
 * Every item is wrapped in a stable .seg-item container for layout. This
 * ensures live and disabled/review modes have identical flex children,
 * preventing alignment differences when ActionHint wraps disabled items.
 *
 * The name prop is a stable technical ID for radio grouping; legend is the
 * human-readable group label (screen-reader visible via sr-only class).
 * useId() suffix guarantees page-unique radio groups.
 */

import React, { useId } from 'react';
import { ActionHint } from './ActionHint';

/** Internal helper: renders one segmented item with a stable layout wrapper. */
function SegmentedItemShell<T extends string>({
  item,
  groupName,
  activeValue,
  onSelect,
  onDisabledSelect,
}: {
  item: { readonly value: T; readonly label: string; readonly disabled?: boolean; readonly disabledReason?: string };
  groupName: string;
  activeValue: T;
  onSelect: (value: T) => void;
  onDisabledSelect?: (value: T, reason?: string) => void;
}) {
  const isActive = item.value === activeValue;
  const label = (
    <label
      className={`seg-label${isActive ? ' active' : ''}`}
      onClick={item.disabled && onDisabledSelect ? (e) => { e.preventDefault(); onDisabledSelect(item.value, item.disabledReason); } : undefined}
    >
      <input
        type="radio"
        name={groupName}
        value={item.value}
        checked={isActive}
        disabled={item.disabled}
        onChange={() => onSelect(item.value)}
      />
      {item.label}
    </label>
  );

  return (
    <span className={`seg-item${item.disabled ? ' seg-item--disabled' : ''}`}>
      <span className="seg-item__content">
        {item.disabled && item.disabledReason ? (
          <ActionHint text={item.disabledReason} focusableWhenDisabled focusLabel={`${item.label} (unavailable)`}>
            {label}
          </ActionHint>
        ) : label}
      </span>
    </span>
  );
}

export function Segmented<T extends string>({
  name,
  legend,
  items,
  activeValue,
  onSelect,
  onDisabledSelect,
  className,
}: {
  name: string;
  legend: string;
  items: readonly { readonly value: T; readonly label: string; readonly disabled?: boolean; readonly disabledReason?: string }[];
  activeValue: T;
  onSelect: (value: T) => void;
  /** Called when a disabled item is tapped/clicked. Used for review-mode hint delivery. */
  onDisabledSelect?: (value: T, reason?: string) => void;
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
        <SegmentedItemShell
          key={item.value}
          item={item}
          groupName={groupName}
          activeValue={activeValue}
          onSelect={onSelect}
          onDisabledSelect={onDisabledSelect}
        />
      ))}
    </fieldset>
  );
}
