/**
 * BondedGroupsPanel — compact side panel showing bonded clusters.
 *
 * Grid layout: label | atoms | center | follow columns.
 * Header row labels the action columns once.
 *
 * Interactions:
 * - Row body click: toggle persistent selection highlight
 * - Row hover (desktop): temporary preview highlight
 * - Center button: one-shot camera frame (no persistent state)
 * - Follow button: toggle orbit-follow for the group (persistent active state)
 * - Clear Highlight button: visible when tracked highlight exists
 *
 * Camera actions gated on canTargetBondedGroups capability.
 * Only Follow shows active state (via store orbitFollowEnabled + cameraTargetRef).
 */

import React, { useMemo, useCallback } from 'react';
import { selectCanInspectBondedGroups, selectCanTargetBondedGroups } from '../store/selectors/bonded-group-capabilities';
import { useAppStore } from '../store/app-store';
import { partitionBondedGroups } from '../store/selectors/bonded-groups';
import { IconCenter, IconFollow } from './Icons';

function ClusterRow({ id, displayIndex, atomCount, isSmall, canTarget }: {
  id: string; displayIndex: number; atomCount: number; isSmall?: boolean; canTarget: boolean;
}) {
  const selectedId = useAppStore((s) => s.selectedBondedGroupId);
  const hoveredId = useAppStore((s) => s.hoveredBondedGroupId);
  const hasTracked = useAppStore((s) => s.hasTrackedBondedHighlight);
  const callbacks = useAppStore((s) => s.bondedGroupCallbacks);
  const orbitFollowEnabled = useAppStore((s) => s.orbitFollowEnabled);
  const isSelected = selectedId === id;
  const isHovered = hoveredId === id && !hasTracked;
  // Row-local active hint: best-effort, shown only while the originating row exists.
  // Persistent follow state is owned by orbitFollowTargetRef (frozen atom-set).
  // The global "Follow On" indicator above the list is the authoritative off-switch.
  const cameraTargetRef = useAppStore((s) => s.cameraTargetRef);
  const isFollowingThisGroup = orbitFollowEnabled && cameraTargetRef?.kind === 'bonded-group' && cameraTargetRef.groupId === id;

  const handleClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    callbacks?.onToggleSelect(id);
  }, [id, callbacks]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      callbacks?.onToggleSelect(id);
    }
  }, [id, callbacks]);

  const handleMouseEnter = useCallback(() => {
    callbacks?.onHover(id);
  }, [id, callbacks]);

  const handleCenter = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    callbacks?.onCenterGroup?.(id);
  }, [id, callbacks]);

  const handleFollow = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    callbacks?.onFollowGroup?.(id);
  }, [id, callbacks]);

  return (
    <div
      className={`bonded-groups-row${isSmall ? ' bonded-groups-small-row' : ''}${isSelected ? ' bonded-groups-selected' : ''}${isHovered ? ' bonded-groups-hovered' : ''}`}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      onMouseEnter={handleMouseEnter}
      role="button"
      tabIndex={0}
    >
      <span className="bonded-groups-label">Cluster {displayIndex}</span>
      <span className="bonded-groups-atoms">{atomCount}</span>
      {canTarget && (
        <>
          <button
            className="bonded-groups-action-btn"
            onClick={handleCenter}
            aria-label={`Center camera on cluster ${displayIndex}`}
            type="button"
          >
            <IconCenter size={12} />
          </button>
          <button
            className={`bonded-groups-action-btn${isFollowingThisGroup ? ' active' : ''}`}
            onClick={handleFollow}
            aria-label={isFollowingThisGroup ? `Stop following cluster ${displayIndex}` : `Follow cluster ${displayIndex}`}
            aria-pressed={isFollowingThisGroup || undefined}
            type="button"
          >
            <IconFollow size={12} />
          </button>
        </>
      )}
    </div>
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
  const canInspect = useAppStore(selectCanInspectBondedGroups);
  const canTarget = useAppStore(selectCanTargetBondedGroups);
  const { large, small } = useMemo(() => partitionBondedGroups(groups), [groups]);

  const handleListLeave = useCallback(() => {
    callbacks?.onHover(null);
  }, [callbacks]);

  const orbitFollowEnabled = useAppStore((s) => s.orbitFollowEnabled);
  const followTargetRef = useAppStore((s) => s.orbitFollowTargetRef);
  const isFollowActive = orbitFollowEnabled && followTargetRef != null;

  const handleStopFollow = useCallback(() => {
    const store = useAppStore.getState();
    store.setOrbitFollowEnabled(false);
    store.setOrbitFollowTargetRef(null);
    // Clear stale bonded-group camera target so it doesn't leak into other camera flows
    if (store.cameraTargetRef?.kind === 'bonded-group') {
      store.setCameraTargetRef(null);
    }
  }, []);

  if (groups.length === 0 || !canInspect) return null;

  return (
    <div className={`bonded-groups-panel side-${side}`}>
      <button className="bonded-groups-header" onClick={toggleExpanded} type="button">
        Bonded Clusters <span className="bonded-groups-count">{groups.length}</span>
      </button>
      {/* Persistent follow indicator — visible even if the original row disappears */}
      {isFollowActive && (
        <button
          className="bonded-groups-follow-indicator"
          onClick={handleStopFollow}
          aria-label="Stop following"
          type="button"
        >
          <IconFollow size={12} />
          <span>Follow On</span>
        </button>
      )}
      {expanded && (
        <div className="bonded-groups-list" onMouseLeave={handleListLeave}>
          {/* Column header row */}
          {canTarget && (
            <div className="bonded-groups-col-header">
              <span />
              <span>atoms</span>
              <span>Center</span>
              <span>Follow</span>
            </div>
          )}
          {large.map((g) => (
            <ClusterRow key={g.id} id={g.id} displayIndex={g.displayIndex} atomCount={g.atomCount} canTarget={canTarget} />
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
                <ClusterRow key={g.id} id={g.id} displayIndex={g.displayIndex} atomCount={g.atomCount} isSmall canTarget={canTarget} />
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
