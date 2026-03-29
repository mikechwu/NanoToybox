/**
 * BondedGroupsPanel — compact side panel showing live bonded clusters.
 *
 * Two-level expansion + highlight:
 * 1. Header click: expand/collapse the full cluster list
 * 2. "Small clusters" row click: expand/collapse clusters with <= 3 atoms
 * 3. Row click: toggle persistent selection highlight
 * 4. Row hover (desktop): temporary preview highlight (disabled during selection)
 * 5. Clear Highlight button: visible only during persistent selection
 */

import React, { useMemo, useCallback } from 'react';
import { useAppStore } from '../store/app-store';
import { partitionBondedGroups } from '../store/selectors/bonded-groups';

/** Callbacks provided by the highlight runtime, wired via main.ts. */
export interface BondedGroupsPanelCallbacks {
  onToggleSelect: (id: string) => void;
  onHover: (id: string | null) => void;
  onClearHighlight: () => void;
}

// Module-level callback holder — set by main.ts after panel mounts
let _callbacks: BondedGroupsPanelCallbacks | null = null;
export function setBondedGroupsPanelCallbacks(cbs: BondedGroupsPanelCallbacks | null) {
  _callbacks = cbs;
}

function ClusterRow({ id, displayIndex, atomCount, isSmall }: {
  id: string; displayIndex: number; atomCount: number; isSmall?: boolean;
}) {
  const selectedId = useAppStore((s) => s.selectedBondedGroupId);
  const hoveredId = useAppStore((s) => s.hoveredBondedGroupId);
  const isSelected = selectedId === id;
  const isHovered = hoveredId === id && !selectedId;

  const handleClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    _callbacks?.onToggleSelect(id);
  }, [id]);

  const handleMouseEnter = useCallback(() => {
    _callbacks?.onHover(id);
  }, [id]);

  // No per-row onMouseLeave — hover is cleared at the list container level only,
  // preventing flicker when cursor moves directly between rows.
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
  const selectedId = useAppStore((s) => s.selectedBondedGroupId);

  const { large, small } = useMemo(() => partitionBondedGroups(groups), [groups]);

  const handleListLeave = useCallback(() => {
    _callbacks?.onHover(null);
  }, []);

  if (groups.length === 0) return null;

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
      {selectedId && (
        <button
          className="bonded-groups-clear"
          onClick={() => _callbacks?.onClearHighlight()}
          type="button"
        >
          Clear Highlight
        </button>
      )}
    </div>
  );
}
