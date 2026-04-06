/**
 * @vitest-environment jsdom
 */
/**
 * Review-lock DOM structure tests — validates that review-locked surfaces
 * preserve correct DOM structure and provide discoverable hints.
 *
 * Protects against:
 * - Invalid list structure (<span> wrapping <li> inside <ul>)
 * - Missing keyboard activation on locked list items
 */
import { describe, it, expect, beforeEach } from 'vitest';
import React from 'react';
import { render } from '@testing-library/react';
import { useAppStore } from '../../lab/js/store/app-store';
import {
  selectReviewUiLockState,
  REVIEW_LOCK_TOOLTIP,
} from '../../lab/js/store/selectors/review-ui-lock';
import { ReviewLockedListItem } from '../../lab/js/components/ReviewLockedListItem';

describe('ReviewLockedListItem DOM contract', () => {
  it('renders <li> as a direct child of <ul> — no span wrapper', () => {
    const { container } = render(
      <ul className="group-list">
        <ReviewLockedListItem label="Test item" className="group-item group-action">
          Test Content
        </ReviewLockedListItem>
      </ul>
    );

    const ul = container.querySelector('ul.group-list')!;
    expect(ul).not.toBeNull();

    // First child of <ul> must be <li>, not <span>
    const firstChild = ul.firstElementChild!;
    expect(firstChild.tagName).toBe('LI');
    expect(firstChild.classList.contains('group-item')).toBe(true);
    expect(firstChild.classList.contains('review-locked-list-item')).toBe(true);

    // No span > li structure anywhere in the subtree
    const spans = ul.querySelectorAll(':scope > span');
    expect(spans.length).toBe(0);
  });

  it('locked list item does NOT use timeline-hint-anchor (would break row layout)', () => {
    const { container } = render(
      <ul className="group-list">
        <ReviewLockedListItem label="Test" className="group-item group-action">
          Content
        </ReviewLockedListItem>
      </ul>
    );

    const li = container.querySelector('li.group-item')!;
    expect(li).not.toBeNull();
    // timeline-hint-anchor sets display:inline-flex which breaks full-width group-item rows
    expect(li.classList.contains('timeline-hint-anchor')).toBe(false);
    // Should use the row-safe class instead
    expect(li.classList.contains('review-locked-list-item')).toBe(true);
  });

  it('locked list item contains tooltip inside the <li>, not wrapping it', () => {
    const { container } = render(
      <ul>
        <ReviewLockedListItem label="Locked" className="group-item">
          Locked Row
        </ReviewLockedListItem>
      </ul>
    );

    const li = container.querySelector('li.group-item')!;
    expect(li).not.toBeNull();

    // Tooltip should be inside the <li>
    const tooltip = li.querySelector('[role="tooltip"]');
    expect(tooltip).not.toBeNull();
    expect(tooltip!.textContent).toContain(REVIEW_LOCK_TOOLTIP);
  });

  it('tooltip is NOT inside the dimmed content wrapper (stays full contrast)', () => {
    const { container } = render(
      <ul>
        <ReviewLockedListItem label="Contrast test" className="group-item">
          Dimmed Text
        </ReviewLockedListItem>
      </ul>
    );

    const li = container.querySelector('li.group-item')!;
    const dimmedContent = li.querySelector('.review-locked-content');
    expect(dimmedContent).not.toBeNull();
    expect(dimmedContent!.textContent).toContain('Dimmed Text');

    // Tooltip must be a sibling of the content wrapper, NOT inside it
    const tooltip = li.querySelector('[role="tooltip"]');
    expect(tooltip).not.toBeNull();
    expect(dimmedContent!.contains(tooltip)).toBe(false);
  });

  it('settings row uses bottom-start placement by default', () => {
    const { container } = render(
      <ul>
        <ReviewLockedListItem label="Placement test" className="group-item">
          Test
        </ReviewLockedListItem>
      </ul>
    );

    const tooltip = container.querySelector('[role="tooltip"]');
    expect(tooltip).not.toBeNull();
    expect(tooltip!.classList.contains('timeline-hint--bottom-start')).toBe(true);
  });

  it('locked list item is keyboard-focusable and has role="button"', () => {
    const { container } = render(
      <ul>
        <ReviewLockedListItem label="KB test" className="group-item">
          Test
        </ReviewLockedListItem>
      </ul>
    );

    const li = container.querySelector('li.group-item')!;
    expect(li.getAttribute('role')).toBe('button');
    expect(li.getAttribute('tabindex')).toBe('0');
    expect(li.getAttribute('aria-disabled')).toBe('true');
  });
});

describe('Review-lock selector integration', () => {
  beforeEach(() => {
    useAppStore.getState().resetTransientState();
  });

  it('review mode locks all settings actions', () => {
    useAppStore.getState().setTimelineMode('review');
    const state = selectReviewUiLockState(useAppStore.getState());
    expect(state.disableSettingsAddMolecule).toBe(true);
    expect(state.disableSettingsClear).toBe(true);
    expect(state.disableAdd).toBe(true);
    expect(state.disableInteractionModes).toBe(true);
    expect(state.disablePauseResume).toBe(true);
  });

  it('live mode unlocks all settings actions', () => {
    useAppStore.getState().setTimelineMode('live');
    const state = selectReviewUiLockState(useAppStore.getState());
    expect(state.disableSettingsAddMolecule).toBe(false);
    expect(state.disableSettingsClear).toBe(false);
  });

  it('tooltip text is consistent across all review-locked surfaces', () => {
    expect(REVIEW_LOCK_TOOLTIP).toContain('read-only');
    expect(REVIEW_LOCK_TOOLTIP).toContain('Simulation');
  });
});
