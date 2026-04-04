/**
 * BondedGroupsPanel — compact side panel showing bonded clusters.
 *
 * Grid layout: color | label | atoms | center | follow columns.
 *
 * Interactions:
 * - Color chip: opens preset swatch popover for that row (independent of selection)
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

/** Preset palette — tuned for luminance separation under 3D atom lighting. */
const PRESET_COLORS = ['#ff5555', '#ffbb33', '#33dd66', '#55aaff', '#aa77ff', '#ff66aa'];

/**
 * Derived color state for a group's chip.
 *
 * The chip is a summary indicator, not an exact histogram:
 * - Capped to the first 4 unique override colors for readability.
 * - Conic-gradient slices are equal-angle (not proportional to atom count).
 * - When a group has mixed colors, no single preset swatch is marked active.
 *
 * These are intentional design simplifications. Proportional display can
 * be added later if exact per-atom color breakdown becomes important.
 */
type GroupColorState =
  | { kind: 'default' }
  | { kind: 'single'; hex: string }
  | { kind: 'multi'; hexes: string[]; hasDefault: boolean };

function useGroupColorState(groupId: string): GroupColorState {
  const colorOverrides = useAppStore((s) => s.bondedGroupColorOverrides);
  const callbacks = useAppStore((s) => s.bondedGroupCallbacks);
  // bondedGroups reference changes on every topology projection (projectNow → setBondedGroups).
  // This invalidates the cache when the runtime's groupAtomMap changes — without it,
  // getGroupAtoms() returns new atoms but the useMemo returns stale results because
  // colorOverrides and callbacks are unchanged.
  const groups = useAppStore((s) => s.bondedGroups);
  return useMemo(() => {
    const atomIndices = callbacks?.getGroupAtoms?.(groupId);
    if (!atomIndices || atomIndices.length === 0) return { kind: 'default' };
    const unique = new Set<string>();
    let hasDefault = false;
    for (const idx of atomIndices) {
      if (colorOverrides[idx]) {
        unique.add(colorOverrides[idx].hex);
      } else {
        hasDefault = true;
      }
    }
    if (unique.size === 0) return { kind: 'default' };
    const hexes = [...unique].slice(0, 4);
    if (hexes.length === 1 && !hasDefault) return { kind: 'single', hex: hexes[0] };
    return { kind: 'multi', hexes, hasDefault };
  }, [groupId, colorOverrides, callbacks, groups]);
}

/** Build chip background style from group color state. */
function chipBackground(state: GroupColorState): React.CSSProperties | undefined {
  if (state.kind === 'single') return { background: state.hex };
  if (state.kind === 'multi') {
    const colors = [...state.hexes];
    if (state.hasDefault) colors.push('var(--atom-base-color, #444)');
    const n = colors.length;
    const stops = colors.map((c, i) =>
      `${c} ${(i / n) * 360}deg ${((i + 1) / n) * 360}deg`
    ).join(', ');
    return { background: `conic-gradient(${stops})` };
  }
  return undefined; // CSS fallback: var(--atom-base-color)
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
  const hasAuthoredColor = colorState.kind !== 'default';
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

  const handleApplyColor = useCallback((hex: string) => {
    callbacks?.onApplyGroupColor?.(id, hex);
  }, [id, callbacks]);

  const handleClearColor = useCallback(() => {
    callbacks?.onClearGroupColor?.(id);
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
      return { position: 'fixed', top, left: rect.right + 8, transform: 'translateY(-50%)' };
    }
    return { position: 'fixed', top, right: window.innerWidth - rect.left + 8, transform: 'translateY(-50%)' };
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
          className={`bonded-groups-color-chip${hasAuthoredColor ? ' has-color' : ''}${colorState.kind === 'multi' ? ' multi-color' : ''}`}
          style={chipStyle}
          onClick={handleColorChipClick}
          aria-label={colorState.kind === 'multi' ? `Multiple colors in cluster ${displayIndex}` : `Edit color for cluster ${displayIndex}`}
          type="button"
        />
      ) : <span />}
      <span className="bonded-groups-label">Cluster {displayIndex}</span>
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
            {PRESET_COLORS.map(hex => (
              <button
                key={hex}
                role="menuitem"
                className={`bonded-groups-swatch${activeHex === hex ? ' active' : ''}`}
                style={{ background: hex }}
                onClick={() => handleApplyColor(hex)}
                aria-label={`Set color ${hex}`}
                type="button"
              />
            ))}
            <button
              role="menuitem"
              className={`bonded-groups-swatch bonded-groups-swatch-original${colorState.kind === 'default' ? ' active' : ''}`}
              onClick={handleClearColor}
              aria-label="Restore original color"
              type="button"
            />
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
      <button className="bonded-groups-header" onClick={toggleExpanded} type="button">
        Bonded Clusters <span className="bonded-groups-count">{groups.length}</span>
      </button>
      {isFollowActive && (
        <button className="bonded-groups-follow-indicator" onClick={handleStopFollow} aria-label="Stop following" type="button">
          <IconFollow size={12} />
          <span>Follow On</span>
        </button>
      )}
      {expanded && (
        <div className="bonded-groups-list" onMouseLeave={handleListLeave}>
          {(canTarget || canEditColor) && (
            <div className="bonded-groups-col-header">
              {canEditColor && <span />}
              <span />
              <span>atoms</span>
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
              <button className="bonded-groups-row bonded-groups-small-toggle"
                onClick={(e) => { e.stopPropagation(); toggleSmall(); }} type="button">
                <span className="bonded-groups-label">Small clusters</span>
                <span className="bonded-groups-atoms">{small.length}</span>
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
