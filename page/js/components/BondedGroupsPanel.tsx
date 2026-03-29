/**
 * BondedGroupsPanel — compact side panel showing live bonded clusters.
 *
 * Two-level expansion:
 * 1. Header click: expand/collapse the full cluster list
 * 2. "Small clusters" row click: expand/collapse clusters with <= 3 atoms
 *
 * Cluster rows are interactive — clicking selects/deselects via selectedBondedGroupId.
 * Selection state is stored for future highlight/action features.
 */

import React, { useMemo, useCallback } from 'react';
import { useAppStore } from '../store/app-store';
import { partitionBondedGroups } from '../store/selectors/bonded-groups';

function ClusterRow({ id, displayIndex, atomCount, isSmall }: {
  id: string; displayIndex: number; atomCount: number; isSmall?: boolean;
}) {
  const selectedId = useAppStore((s) => s.selectedBondedGroupId);
  const setSelected = useAppStore((s) => s.setSelectedBondedGroup);
  const isSelected = selectedId === id;

  const handleClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setSelected(isSelected ? null : id);
  }, [id, isSelected, setSelected]);

  return (
    <button
      className={`bonded-groups-row${isSmall ? ' bonded-groups-small-row' : ''}${isSelected ? ' bonded-groups-selected' : ''}`}
      onClick={handleClick}
      type="button"
    >
      <span className="bonded-groups-label">Cluster {displayIndex}</span>
      <span className="bonded-groups-atoms">{atomCount} atoms</span>
    </button>
  );
}

export function BondedGroupsPanel() {
  const groups = useAppStore((s) => s.bondedGroups);
  const expanded = useAppStore((s) => s.bondedGroupsExpanded);
  const smallExpanded = useAppStore((s) => s.bondedSmallGroupsExpanded);
  const toggleExpanded = useAppStore((s) => s.toggleBondedGroupsExpanded);
  const toggleSmall = useAppStore((s) => s.toggleBondedSmallGroupsExpanded);
  const side = useAppStore((s) => s.bondedGroupsSide);

  const { large, small } = useMemo(() => partitionBondedGroups(groups), [groups]);

  if (groups.length === 0) return null;

  return (
    <div className={`bonded-groups-panel side-${side}`}>
      <button className="bonded-groups-header" onClick={toggleExpanded} type="button">
        Bonded Clusters <span className="bonded-groups-count">{groups.length}</span>
      </button>
      {expanded && (
        <div className="bonded-groups-list">
          {large.map((g) => (
            <ClusterRow key={g.id} id={g.id} displayIndex={g.displayIndex} atomCount={g.atomCount} />
          ))}
          {small.length > 0 && (
            <>
              <button
                className="bonded-groups-row bonded-groups-small-toggle"
                onClick={(e) => { e.stopPropagation(); toggleSmall(); }}
                type="button"
              >
                <span className="bonded-groups-label">Small clusters</span>
                <span className="bonded-groups-atoms">{small.length}</span>
              </button>
              {smallExpanded && small.map((g) => (
                <ClusterRow key={g.id} id={g.id} displayIndex={g.displayIndex} atomCount={g.atomCount} isSmall />
              ))}
            </>
          )}
        </div>
      )}
    </div>
  );
}
