/**
 * BondedGroupsPanel — compact side panel showing bonded clusters.
 *
 * Disclosure: expanded by default; header toggles between Collapse / Expand.
 *
 * Grid layout: color | label | atoms | center | follow columns.
 *
 * Interactions:
 * - Color chip (plain solid): opens a portalled honeycomb popover with the
 *   default swatch in the center and preset swatches in a computed ring.
 *   Each swatch is a reusable ColorSwatch component.
 * - Row hover: temporary preview highlight
 * - Center: one-shot camera frame
 * - Follow: toggle orbit-follow (frozen atom set)
 *
 * Persistent row selection and Clear Highlight are feature-gated off
 * (canTrackBondedGroupHighlight: false). Store fields and runtime methods
 * are retained for future re-enablement — see bonded-group-capabilities.ts.
 */

import React, { useMemo, useCallback, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { selectCanInspectBondedGroups, selectCanTargetBondedGroups, selectCanEditBondedGroupColor, selectCanTrackBondedGroupHighlight } from '../store/selectors/bonded-group-capabilities';
import { useAppStore } from '../store/app-store';
import { partitionBondedGroups } from '../store/selectors/bonded-groups';
import { IconCenter, IconFollow } from './Icons';
import {
  type GroupColorOption, GROUP_COLOR_OPTIONS, buildGroupColorLayout,
  type GroupColorState, computeGroupColorState,
  SWATCH_DIAMETER, ACTIVE_SCALE, RING_GAP, computeHexGeometry,
} from '../../../src/appearance/bonded-group-color-assignments';
import { chipBackgroundValue } from '../../../src/ui/bonded-group-chip-style';

// Color option model, geometry, and constants imported from shared module above.

const COLOR_LAYOUT = buildGroupColorLayout(GROUP_COLOR_OPTIONS);

const HEX_GEO = computeHexGeometry(COLOR_LAYOUT.secondary.length, SWATCH_DIAMETER, ACTIVE_SCALE, RING_GAP);
const HEX_CONTAINER_STYLE: React.CSSProperties = {
  position: 'relative',
  width: HEX_GEO.containerSize,
  height: HEX_GEO.containerSize,
};

/** Compute ring slot position for item i of n. Starts at 12 o'clock, clockwise. */
function ringSlotStyle(i: number, n: number): React.CSSProperties {
  const angle = (i * 2 * Math.PI) / n;
  const radiusPct = (HEX_GEO.radius / HEX_GEO.containerSize) * 100;
  const xPct = 50 + radiusPct * Math.sin(angle);
  const yPct = 50 - radiusPct * Math.cos(angle);
  return { left: `${xPct.toFixed(1)}%`, top: `${yPct.toFixed(1)}%` };
}

/** Reusable swatch button — owns active class, visual treatment, and aria-label. */
function ColorSwatch({ option, active, onSelect }: {
  option: GroupColorOption;
  active: boolean;
  onSelect: (option: GroupColorOption) => void;
}) {
  const isDefault = option.kind === 'default';
  return (
    <button
      role="menuitem"
      className={`bonded-groups-swatch${isDefault ? ' bonded-groups-swatch-original' : ''}${active ? ' active' : ''}`}
      style={isDefault ? undefined : { background: option.hex }}
      onClick={() => onSelect(option)}
      aria-label={isDefault ? 'Restore original color' : `Set color ${option.hex}`}
      type="button"
    />
  );
}

// GroupColorState type imported from shared module above.

/** Lab-specific hook: derives group color state from Zustand store.
 *  Wraps shared computeGroupColorState() with store subscriptions. */
function useGroupColorState(groupId: string): GroupColorState {
  const colorOverrides = useAppStore((s) => s.bondedGroupColorOverrides);
  const callbacks = useAppStore((s) => s.bondedGroupCallbacks);
  const groups = useAppStore((s) => s.bondedGroups);
  return useMemo(() => {
    const atomIndices = callbacks?.getGroupAtoms?.(groupId);
    if (!atomIndices || atomIndices.length === 0) return { kind: 'default' };
    return computeGroupColorState(atomIndices, colorOverrides);
  }, [groupId, colorOverrides, callbacks, groups]);
}

/** Lab wrapper: shared chipBackgroundValue → React.CSSProperties. */
function chipBackground(state: GroupColorState): React.CSSProperties | undefined {
  const bg = chipBackgroundValue(state);
  return bg ? { background: bg } : undefined;
}

function ClusterRow({ id, displayIndex, atomCount, isSmall, canTarget, canEditColor, canTrackHighlight, colorEditorOpen, onToggleColorEditor, panelSide }: {
  id: string; displayIndex: number; atomCount: number; isSmall?: boolean;
  canTarget: boolean; canEditColor: boolean; canTrackHighlight: boolean;
  colorEditorOpen: boolean; onToggleColorEditor: (id: string) => void;
  panelSide: 'left' | 'right';
}) {
  const selectedId = useAppStore((s) => s.selectedBondedGroupId);
  const hoveredId = useAppStore((s) => s.hoveredBondedGroupId);
  const hasTracked = useAppStore((s) => s.hasTrackedBondedHighlight);
  const callbacks = useAppStore((s) => s.bondedGroupCallbacks);
  const orbitFollowEnabled = useAppStore((s) => s.orbitFollowEnabled);
  const cameraTargetRef = useAppStore((s) => s.cameraTargetRef);
  const isSelected = selectedId === id;
  const isHovered = hoveredId === id && !hasTracked;
  const isFollowingThisGroup = orbitFollowEnabled && cameraTargetRef?.kind === 'bonded-group' && cameraTargetRef.groupId === id;
  const colorState = useGroupColorState(id);
  const activeHex = colorState.kind === 'single' ? colorState.hex : null;
  const chipStyle = useMemo(() => chipBackground(colorState), [colorState]);
  const chipRef = useRef<HTMLButtonElement>(null);

  const handleClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    if (!canTrackHighlight) return;
    callbacks?.onToggleSelect?.(id);
  }, [canTrackHighlight, id, callbacks]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (!canTrackHighlight) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      callbacks?.onToggleSelect?.(id);
    }
  }, [canTrackHighlight, id, callbacks]);

  const handleMouseEnter = useCallback(() => { callbacks?.onHover(id); }, [id, callbacks]);
  const handleMouseLeave = useCallback(() => { callbacks?.onHover(null); }, [callbacks]);

  const handleCenter = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    callbacks?.onCenterGroup?.(id);
  }, [id, callbacks]);

  const handleFollow = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    callbacks?.onFollowGroup?.(id);
  }, [id, callbacks]);

  const handleColorChipClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    callbacks?.onHover(null); // clear hover preview when entering color edit
    onToggleColorEditor(id);
  }, [id, onToggleColorEditor, callbacks]);

  const handleSelectOption = useCallback((option: GroupColorOption) => {
    if (option.kind === 'default') {
      callbacks?.onClearGroupColor?.(id);
    } else {
      callbacks?.onApplyGroupColor?.(id, option.hex);
    }
  }, [id, callbacks]);

  // Close popover on Escape key
  useEffect(() => {
    if (!colorEditorOpen) return;
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onToggleColorEditor(id);
    };
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [colorEditorOpen, id, onToggleColorEditor]);

  // Compute popover position from chip ref when open
  const popoverStyle = useMemo((): React.CSSProperties => {
    if (!colorEditorOpen || !chipRef.current) return { position: 'fixed' };
    const rect = chipRef.current.getBoundingClientRect();
    const top = rect.top + rect.height / 2;
    if (panelSide === 'left') {
      return { position: 'fixed', top, left: rect.right + 12, transform: 'translateY(-50%)' };
    }
    return { position: 'fixed', top, right: window.innerWidth - rect.left + 12, transform: 'translateY(-50%)' };
  }, [colorEditorOpen, panelSide]);

  return (
    <div
      className={`bonded-groups-row${isSmall ? ' bonded-groups-small-row' : ''}${canTrackHighlight && isSelected ? ' bonded-groups-selected' : ''}${isHovered ? ' bonded-groups-hovered' : ''}${colorEditorOpen ? ' bonded-groups-color-open' : ''}`}
      onClick={canTrackHighlight ? handleClick : undefined}
      onKeyDown={canTrackHighlight ? handleKeyDown : undefined}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      role={canTrackHighlight ? 'button' : undefined}
      tabIndex={canTrackHighlight ? 0 : undefined}
    >
      {/* Color chip — clicking opens a portalled popover, independent of selection */}
      {canEditColor ? (
        <button
          ref={chipRef}
          className="bonded-groups-color-chip"
          style={chipStyle}
          onClick={handleColorChipClick}
          aria-label={colorState.kind === 'multi' ? `Multiple colors in cluster ${displayIndex}` : `Edit color for cluster ${displayIndex}`}
          type="button"
        />
      ) : <span />}
      <span className="bonded-groups-label">#{displayIndex}</span>
      <span className="bonded-groups-atoms">{atomCount}</span>
      {canTarget && (
        <>
          <button className="bonded-groups-action-btn" onClick={handleCenter} aria-label={`Center cluster ${displayIndex}`} type="button">
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
      {/* Portalled popover — escapes panel overflow clipping */}
      {colorEditorOpen && canEditColor && createPortal(
        <>
          <div className="bonded-groups-color-backdrop" role="presentation" onClick={handleColorChipClick} />
          <div className="bonded-groups-color-popover" role="menu" aria-label="Color swatches" style={popoverStyle} onClick={(e) => e.stopPropagation()}>
            <div className="bonded-groups-color-hex" style={HEX_CONTAINER_STYLE}>
              {/* Center: default swatch */}
              {COLOR_LAYOUT.primary && (
                <div className="bonded-groups-hex-slot" style={{ left: '50%', top: '50%' }}>
                  <ColorSwatch
                    option={COLOR_LAYOUT.primary}
                    active={colorState.kind === 'default'}
                    onSelect={handleSelectOption}
                  />
                </div>
              )}
              {/* Ring: preset swatches — positions computed from palette size */}
              {COLOR_LAYOUT.secondary.map((option, i) => (
                <div key={option.kind === 'preset' ? option.hex : 'default'} className="bonded-groups-hex-slot" style={ringSlotStyle(i, COLOR_LAYOUT.secondary.length)}>
                  <ColorSwatch
                    option={option}
                    active={option.kind === 'preset' && activeHex === option.hex}
                    onSelect={handleSelectOption}
                  />
                </div>
              ))}
            </div>
          </div>
        </>,
        document.body
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
  const canEditColor = useAppStore(selectCanEditBondedGroupColor);
  const canTrackHighlight = useAppStore(selectCanTrackBondedGroupHighlight);
  const { large, small } = useMemo(() => partitionBondedGroups(groups), [groups]);

  // Separate color-edit state (not tied to highlight selection)
  const colorEditorOpenForId = useAppStore((s) => s.colorEditorOpenForGroupId);
  const handleToggleColorEditor = useCallback((id: string) => {
    const current = useAppStore.getState().colorEditorOpenForGroupId;
    useAppStore.getState().setColorEditorOpenForGroupId(current === id ? null : id);
  }, []);

  const handleListLeave = useCallback(() => { callbacks?.onHover(null); }, [callbacks]);

  const orbitFollowEnabled = useAppStore((s) => s.orbitFollowEnabled);
  const followTargetRef = useAppStore((s) => s.orbitFollowTargetRef);
  const isFollowActive = orbitFollowEnabled && followTargetRef != null;

  const handleStopFollow = useCallback(() => {
    const store = useAppStore.getState();
    store.setOrbitFollowEnabled(false);
    store.setOrbitFollowTargetRef(null);
    if (store.cameraTargetRef?.kind === 'bonded-group') store.setCameraTargetRef(null);
  }, []);

  if (groups.length === 0 || !canInspect) return null;

  return (
    <div className={`bonded-groups-panel side-${side}`}>
      <button className="bonded-groups-header" onClick={toggleExpanded} aria-expanded={expanded} aria-controls="bonded-groups-list" type="button">
        <span className="bonded-groups-header-label">
          Bonded Clusters: <span className="bonded-groups-count">{groups.length}</span>
        </span>
        <span className="bonded-groups-header-toggle">{expanded ? 'Collapse' : 'Expand'}</span>
      </button>
      {isFollowActive && (
        <button className="bonded-groups-follow-indicator" onClick={handleStopFollow} aria-label="Stop following" type="button">
          <IconFollow size={12} />
          <span>Follow On</span>
        </button>
      )}
      {expanded && (
        <div id="bonded-groups-list" className="bonded-groups-list" onMouseLeave={handleListLeave}>
          {(canTarget || canEditColor) && (
            <div className="bonded-groups-col-header">
              {/* When canEditColor is true, "Cluster" spans both color-chip + index columns.
                  When false, a placeholder keeps the 5-column subgrid aligned. */}
              {!canEditColor && <span />}
              <span className={canEditColor ? 'bonded-groups-col-cluster' : undefined}>Cluster</span>
              <span>Atoms</span>
              {canTarget && <span>Center</span>}
              {canTarget && <span>Follow</span>}
            </div>
          )}
          {large.map((g) => (
            <ClusterRow key={g.id} id={g.id} displayIndex={g.displayIndex} atomCount={g.atomCount}
              canTarget={canTarget} canEditColor={canEditColor} canTrackHighlight={canTrackHighlight}
              colorEditorOpen={colorEditorOpenForId === g.id} onToggleColorEditor={handleToggleColorEditor} panelSide={side} />
          ))}
          {small.length > 0 && (
            <>
              <button className="bonded-groups-small-toggle"
                onClick={(e) => { e.stopPropagation(); toggleSmall(); }}
                aria-expanded={smallExpanded} type="button">
                <span className="bonded-groups-small-label">
                  Small Clusters: <span className="bonded-groups-count">{small.length}</span>
                </span>
                <span className="bonded-groups-header-toggle">{smallExpanded ? 'Collapse' : 'Expand'}</span>
              </button>
              {smallExpanded && small.map((g) => (
                <ClusterRow key={g.id} id={g.id} displayIndex={g.displayIndex} atomCount={g.atomCount} isSmall
                  canTarget={canTarget} canEditColor={canEditColor} canTrackHighlight={canTrackHighlight}
                  colorEditorOpen={colorEditorOpenForId === g.id} onToggleColorEditor={handleToggleColorEditor} panelSide={side} />
              ))}
            </>
          )}
        </div>
      )}
      {canTrackHighlight && hasTrackedHighlight && (
        <button className="bonded-groups-clear" onClick={() => callbacks?.onClearHighlight?.()} type="button">
          Clear Highlight
        </button>
      )}
    </div>
  );
}
