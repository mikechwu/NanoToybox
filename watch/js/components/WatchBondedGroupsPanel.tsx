/**
 * WatchBondedGroupsPanel — lab-parity bonded-groups panel.
 *
 * Structure matches lab/js/components/BondedGroupsPanel.tsx:
 *   - header: "Bonded Clusters: N" + collapse toggle
 *   - follow-active indicator strip when following
 *   - parent grid: 24px 1fr 4ch 3em 3em (matches lab)
 *   - column header: Cluster (spanning 2) | Atoms | Center | Follow
 *   - subgrid rows: chip | #N | atomCount | center btn | follow btn
 *   - small-clusters: top border, "Small Clusters: N" + Expand/Collapse
 */

import React from 'react';
import { partitionBondedGroups } from '../../../src/history/bonded-group-utils';
import type { BondedGroupSummary } from '../watch-bonded-groups';
import { IconCenter, IconFollow } from '../../../lab/js/components/Icons';

interface WatchBondedGroupsPanelProps {
  groups: BondedGroupSummary[];
  expanded: boolean;
  smallExpanded: boolean;
  onToggleExpanded: () => void;
  onToggleSmallExpanded: () => void;
  following: boolean;
  followedGroupId: string | null;
  onHover: (id: string | null) => void;
  onCenter: (id: string) => void;
  onFollow: (id: string) => void;
  onUnfollow: () => void;
}

function GroupRow({
  group, isFollowed, isSmall,
  onHover, onCenter, onFollow,
}: {
  group: BondedGroupSummary;
  isFollowed: boolean;
  isSmall?: boolean;
  onHover: (id: string | null) => void;
  onCenter: (id: string) => void;
  onFollow: (id: string) => void;
}) {
  return (
    <div
      className={`bg-panel__row${isSmall ? ' bg-panel__row--small' : ''}`}
      onMouseEnter={() => onHover(group.id)}
      onMouseLeave={() => onHover(null)}
    >
      <span className="bg-panel__row-chip" />
      <span className="bg-panel__row-label">#{group.displayIndex}</span>
      <span className="bg-panel__row-atoms">{group.atomCount}</span>
      <button
        className="bg-panel__row-action"
        title="Center"
        aria-label={`Center on group ${group.displayIndex}`}
        onClick={() => onCenter(group.id)}
      >
        <IconCenter size={12} />
      </button>
      <button
        className={`bg-panel__row-action${isFollowed ? ' bg-panel__row-action--active' : ''}`}
        title={isFollowed ? 'Unfollow' : 'Follow'}
        aria-label={isFollowed ? `Stop following group ${group.displayIndex}` : `Follow group ${group.displayIndex}`}
        aria-pressed={isFollowed || undefined}
        onClick={() => onFollow(group.id)}
      >
        <IconFollow size={12} />
      </button>
    </div>
  );
}

export function WatchBondedGroupsPanel({
  groups, expanded, smallExpanded,
  onToggleExpanded, onToggleSmallExpanded,
  following, followedGroupId,
  onHover, onCenter, onFollow, onUnfollow,
}: WatchBondedGroupsPanelProps) {
  const { large, small } = partitionBondedGroups(groups);

  return (
    <div className="bg-panel">
      <button
        className="bg-panel__header"
        onClick={onToggleExpanded}
        type="button"
        aria-expanded={expanded}
        aria-controls="watch-bonded-groups-body"
      >
        <span className="bg-panel__header-label">
          Bonded Clusters: <span className="bg-panel__header-count">{groups.length}</span>
        </span>
        <span className="bg-panel__header-toggle">{expanded ? 'Collapse' : 'Expand'}</span>
      </button>

      {/* Follow On indicator — always visible when following, even when panel collapsed (matches lab) */}
      {following && (
        <button
          className="bg-panel__follow-active"
          onClick={onUnfollow}
          type="button"
          aria-label="Stop following"
        >
          <IconFollow size={12} /> Follow On
        </button>
      )}

      {expanded && (
        <div id="watch-bonded-groups-body" className="bg-panel__list">
          {groups.length > 0 && (
            <div className="bg-panel__col-header">
              <span className="bg-panel__col-cluster">Cluster</span>
              <span>Atoms</span>
              <span>Center</span>
              <span>Follow</span>
            </div>
          )}

          {large.map(g => (
            <GroupRow
              key={g.id} group={g}
              isFollowed={g.id === followedGroupId}
              onHover={onHover} onCenter={onCenter} onFollow={onFollow}
            />
          ))}

          {small.length > 0 && (
            <button
              className="bg-panel__small-toggle"
              onClick={onToggleSmallExpanded}
              type="button"
              aria-expanded={smallExpanded}
            >
              <span className="bg-panel__small-label">Small Clusters: {small.length}</span>
              <span className="bg-panel__header-toggle">{smallExpanded ? 'Collapse' : 'Expand'}</span>
            </button>
          )}
          {smallExpanded && small.map(g => (
            <GroupRow
              key={g.id} group={g} isSmall
              isFollowed={g.id === followedGroupId}
              onHover={onHover} onCenter={onCenter} onFollow={onFollow}
            />
          ))}
        </div>
      )}
    </div>
  );
}
