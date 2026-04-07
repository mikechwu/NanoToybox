/**
 * WatchBondedGroupsPanel — review-parity bonded-groups display.
 * Uses shared partitionBondedGroups + review-parity CSS.
 * No color editing, hover preview, or follow — display only.
 */

import React from 'react';
import { partitionBondedGroups } from '../../../src/history/bonded-group-utils';
import type { BondedGroupSummary } from '../watch-bonded-groups';

interface WatchBondedGroupsPanelProps {
  groups: BondedGroupSummary[];
  expanded: boolean;
  smallExpanded: boolean;
  onToggleExpanded: () => void;
  onToggleSmallExpanded: () => void;
  atomCount: number;
  frameCount: number;
}

function GroupRow({ group }: { group: BondedGroupSummary }) {
  return (
    <li className="review-panel-row">
      <span className="review-panel-row__index">#{group.displayIndex}</span>
      <span className="review-panel-row__atoms">{group.atomCount} atoms</span>
    </li>
  );
}

export function WatchBondedGroupsPanel({
  groups, expanded, smallExpanded,
  onToggleExpanded, onToggleSmallExpanded,
  atomCount, frameCount,
}: WatchBondedGroupsPanelProps) {
  const { large, small } = partitionBondedGroups(groups);

  return (
    <div className="review-panel">
      <button
        className="review-panel__header"
        onClick={onToggleExpanded}
        type="button"
        aria-expanded={expanded}
        {...(expanded ? { 'aria-controls': 'watch-bonded-groups-body' } : {})}
      >
        <span className="review-panel__title">Analysis</span>
        <span className="review-panel__toggle">{expanded ? 'Collapse' : 'Expand'}</span>
      </button>

      {expanded && (
        <div className="review-panel__body" id="watch-bonded-groups-body">
          <dl className="review-panel__stats">
            <dt>Atoms</dt><dd>{atomCount}</dd>
            <dt>Frames</dt><dd>{frameCount}</dd>
            <dt>Groups</dt><dd>{groups.length}</dd>
          </dl>

          {large.length > 0 && (
            <ul className="review-panel__list">
              {large.map(g => <GroupRow key={g.id} group={g} />)}
            </ul>
          )}

          {small.length > 0 && (
            <>
              <button
                className="review-panel__small-toggle"
                onClick={onToggleSmallExpanded}
                type="button"
                aria-expanded={smallExpanded}
              >
                <span className="review-panel__toggle">{smallExpanded ? 'Collapse' : 'Expand'}</span>
                <span>{small.length} small cluster{small.length !== 1 ? 's' : ''}</span>
              </button>
              {smallExpanded && (
                <ul className="review-panel__list">
                  {small.map(g => <GroupRow key={g.id} group={g} />)}
                </ul>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
