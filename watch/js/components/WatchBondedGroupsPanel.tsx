/**
 * WatchBondedGroupsPanel — lab-parity bonded-groups panel with color editing.
 *
 * Round 4 additions: color chip state, honeycomb popover, preset swatches,
 * apply/clear color actions. Color editor open/close state is local React
 * state (not domain state), auto-cleared when the open group disappears.
 */

import React, { useState, useRef, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { partitionBondedGroups } from '../../../src/history/bonded-group-utils';
import {
  type GroupColorOption, GROUP_COLOR_OPTIONS, buildGroupColorLayout,
  type GroupColorState,
  SWATCH_DIAMETER, ACTIVE_SCALE, RING_GAP, computeHexGeometry,
} from '../../../src/appearance/bonded-group-color-assignments';
import { chipBackgroundValue } from '../../../src/ui/bonded-group-chip-style';
import type { BondedGroupSummary } from '../watch-bonded-groups';
import { IconCenter, IconFollow } from '../../../lab/js/components/Icons';

// ── Color layout (precomputed from shared constants) ──

const COLOR_LAYOUT = buildGroupColorLayout(GROUP_COLOR_OPTIONS);
const HEX_GEO = computeHexGeometry(COLOR_LAYOUT.secondary.length, SWATCH_DIAMETER, ACTIVE_SCALE, RING_GAP);

function ringSlotStyle(i: number, n: number): React.CSSProperties {
  const angle = (i * 2 * Math.PI) / n;
  const radiusPct = (HEX_GEO.radius / HEX_GEO.containerSize) * 100;
  const xPct = 50 + radiusPct * Math.sin(angle);
  const yPct = 50 - radiusPct * Math.cos(angle);
  return { left: `${xPct.toFixed(1)}%`, top: `${yPct.toFixed(1)}%` };
}

// ── ColorSwatch component ──

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

// ── Props ──

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
  // Round 4: color
  onApplyGroupColor: (groupId: string, colorHex: string) => void;
  onClearGroupColor: (groupId: string) => void;
  getGroupColorState: (groupId: string) => GroupColorState;
}

// ── GroupRow ──

function GroupRow({
  group, isFollowed, isSmall, colorState,
  onHover, onCenter, onFollow, onToggleColorEditor,
}: {
  group: BondedGroupSummary;
  isFollowed: boolean;
  isSmall?: boolean;
  colorState: GroupColorState;
  onHover: (id: string | null) => void;
  onCenter: (id: string) => void;
  onFollow: (id: string) => void;
  onToggleColorEditor: (id: string, anchorRect: DOMRect) => void;
}) {
  const bg = chipBackgroundValue(colorState);
  return (
    <div
      className={`bg-panel__row${isSmall ? ' bg-panel__row--small' : ''}`}
      onMouseEnter={() => onHover(group.id)}
      onMouseLeave={() => onHover(null)}
    >
      <button
        className="bg-panel__row-chip"
        style={bg ? { background: bg } : undefined}
        onClick={(e) => onToggleColorEditor(group.id, e.currentTarget.getBoundingClientRect())}
        aria-label={`Edit color for group ${group.displayIndex}`}
        type="button"
      />
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

// ── Color Popover ──

function ColorPopover({
  groupId, colorState, anchorRect,
  onApply, onClear, onClose,
}: {
  groupId: string;
  colorState: GroupColorState;
  anchorRect: DOMRect;
  onApply: (groupId: string, colorHex: string) => void;
  onClear: (groupId: string) => void;
  onClose: () => void;
}) {
  const activeHex = colorState.kind === 'single' ? colorState.hex : null;

  const handleSelect = useCallback((option: GroupColorOption) => {
    if (option.kind === 'default') {
      onClear(groupId);
    } else {
      onApply(groupId, option.hex);
    }
    onClose();
  }, [groupId, onApply, onClear, onClose]);

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  // Watch panel is on the right side — popover opens to the LEFT of the chip (matches lab right-panel behavior)
  const style: React.CSSProperties = {
    position: 'fixed',
    right: window.innerWidth - anchorRect.left + 12,
    top: anchorRect.top + anchorRect.height / 2,
    transform: 'translateY(-50%)',
  };

  return createPortal(
    <>
      <div className="bonded-groups-color-backdrop" onClick={onClose} />
      <div className="bonded-groups-color-popover" style={style}>
        <div className="bonded-groups-color-hex" style={{ width: HEX_GEO.containerSize, height: HEX_GEO.containerSize }}>
          {/* Center: default swatch */}
          {COLOR_LAYOUT.primary && (
            <div className="bonded-groups-hex-slot" style={{ left: '50%', top: '50%' }}>
              <ColorSwatch
                option={COLOR_LAYOUT.primary}
                active={colorState.kind === 'default'}
                onSelect={handleSelect}
              />
            </div>
          )}
          {/* Ring: preset swatches */}
          {COLOR_LAYOUT.secondary.map((opt, i) => (
            <div key={i} className="bonded-groups-hex-slot" style={ringSlotStyle(i, COLOR_LAYOUT.secondary.length)}>
              <ColorSwatch
                option={opt}
                active={opt.kind === 'preset' && opt.hex === activeHex}
                onSelect={handleSelect}
              />
            </div>
          ))}
        </div>
      </div>
    </>,
    document.body,
  );
}

// ── Main Panel ──

export function WatchBondedGroupsPanel({
  groups, expanded, smallExpanded,
  onToggleExpanded, onToggleSmallExpanded,
  following, followedGroupId,
  onHover, onCenter, onFollow, onUnfollow,
  onApplyGroupColor, onClearGroupColor, getGroupColorState,
}: WatchBondedGroupsPanelProps) {
  const { large, small } = partitionBondedGroups(groups);

  // Color editor open/close state — local React state, not domain
  const [editorOpenId, setEditorOpenId] = useState<string | null>(null);
  const [editorAnchorRect, setEditorAnchorRect] = useState<DOMRect | null>(null);

  // Auto-clear when the open group disappears (mirrors lab app-store.ts:480)
  useEffect(() => {
    if (editorOpenId && !groups.some(g => g.id === editorOpenId)) {
      setEditorOpenId(null);
      setEditorAnchorRect(null);
    }
  }, [groups, editorOpenId]);

  const handleToggleColorEditor = useCallback((groupId: string, anchorRect: DOMRect) => {
    if (editorOpenId === groupId) {
      setEditorOpenId(null);
      setEditorAnchorRect(null);
    } else {
      setEditorOpenId(groupId);
      setEditorAnchorRect(anchorRect);
    }
  }, [editorOpenId]);

  const handleCloseEditor = useCallback(() => {
    setEditorOpenId(null);
    setEditorAnchorRect(null);
  }, []);

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
              colorState={getGroupColorState(g.id)}
              onHover={onHover} onCenter={onCenter} onFollow={onFollow}
              onToggleColorEditor={handleToggleColorEditor}
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
              colorState={getGroupColorState(g.id)}
              onHover={onHover} onCenter={onCenter} onFollow={onFollow}
              onToggleColorEditor={handleToggleColorEditor}
            />
          ))}
        </div>
      )}

      {/* Color editor popover — portalled */}
      {editorOpenId && editorAnchorRect && (
        <ColorPopover
          groupId={editorOpenId}
          colorState={getGroupColorState(editorOpenId)}
          anchorRect={editorAnchorRect}
          onApply={onApplyGroupColor}
          onClear={onClearGroupColor}
          onClose={handleCloseEditor}
        />
      )}
    </div>
  );
}
