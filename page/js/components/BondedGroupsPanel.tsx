/**
 * BondedGroupsPanel — compact side panel showing live bonded clusters.
 *
 * Two-level expansion + highlight:
 * 1. Header click: expand/collapse the full cluster list
 * 2. "Small clusters" row click: expand/collapse clusters with <= 3 atoms
 * 3. Row click: toggle persistent selection highlight
 * 4. Row hover (desktop): temporary preview highlight (disabled during tracked set)
 * 5. Clear Highlight button: visible whenever tracked highlight exists (even after group disappears)
 *
 * Callbacks are read from store.bondedGroupCallbacks (registered by main.ts),
 * following the same pattern as dockCallbacks/settingsCallbacks/chooserCallbacks.
 */

import React, { useMemo, useCallback } from 'react';
import { useAppStore } from '../store/app-store';
import { partitionBondedGroups } from '../store/selectors/bonded-groups';

function ClusterRow({ id, displayIndex, atomCount, isSmall }: {
  id: string; displayIndex: number; atomCount: number; isSmall?: boolean;
}) {
  const selectedId = useAppStore((s) => s.selectedBondedGroupId);
  const hoveredId = useAppStore((s) => s.hoveredBondedGroupId);
  const hasTracked = useAppStore((s) => s.hasTrackedBondedHighlight);
  const callbacks = useAppStore((s) => s.bondedGroupCallbacks);
  const isSelected = selectedId === id;
  const isHovered = hoveredId === id && !hasTracked;

  const handleClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    callbacks?.onToggleSelect(id);
  }, [id, callbacks]);

  const handleMouseEnter = useCallback(() => {
    callbacks?.onHover(id);
  }, [id, callbacks]);

  return (
    <button
      className={`bonded-groups-row${isSmall ? ' bonded-groups-small-row' : ''}${isSelected ? ' bonded-groups-selected' : ''}${isHovered ? ' bonded-groups-hovered' : ''}`}
      onClick={handleClick}
      onMouseEnter={handleMouseEnter}
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
  const hasTrackedHighlight = useAppStore((s) => s.hasTrackedBondedHighlight);
  const callbacks = useAppStore((s) => s.bondedGroupCallbacks);
  const timelineMode = useAppStore((s) => s.timelineMode);

  const { large, small } = useMemo(() => partitionBondedGroups(groups), [groups]);

  const handleListLeave = useCallback(() => {
    callbacks?.onHover(null);
  }, [callbacks]);

  // Hide during timeline review — live topology doesn't match historical positions
  if (groups.length === 0 || timelineMode === 'review') return null;

  return (
    <div className={`bonded-groups-panel side-${side}`}>
      <button className="bonded-groups-header" onClick={toggleExpanded} type="button">
        Bonded Clusters <span className="bonded-groups-count">{groups.length}</span>
      </button>
      {expanded && (
        <div className="bonded-groups-list" onMouseLeave={handleListLeave}>
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
      {hasTrackedHighlight && (
        <button
          className="bonded-groups-clear"
          onClick={() => callbacks?.onClearHighlight()}
          type="button"
        >
          Clear Highlight
        </button>
      )}
    </div>
  );
}
