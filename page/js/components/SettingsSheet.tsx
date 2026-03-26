/**
 * SettingsSheet — React-authoritative settings sheet with all controls.
 *
 * Replaces imperative #settings-sheet and SettingsSheetController.
 * Renders the full sheet markup with same CSS classes for visual parity.
 * Uses useSheetAnimation for open/close CSS transitions.
 *
 * Groups: Scene, Simulation, Interaction, Appearance, Boundary, Help.
 * Help drill-in page managed via store helpPageActive flag.
 */

import React, { useCallback } from 'react';
import { useAppStore } from '../store/app-store';
import { useSheetAnimation } from '../hooks/useSheetAnimation';
import { Segmented } from './Segmented';

// ── Slider helper ──

function SliderRow({
  label,
  min,
  max,
  step,
  value,
  formatValue,
  onChange,
}: {
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  formatValue: (v: number) => string;
  onChange: (v: number) => void;
}) {
  const handleChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    onChange(parseFloat(e.target.value));
  }, [onChange]);

  return (
    <li className="group-item">
      <span>{label}</span>
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-sm)' }}>
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          className="panel-slider"
          style={{ width: 100 }}
          onChange={handleChange}
        />
        <span className="panel-value">{formatValue(value)}</span>
      </div>
    </li>
  );
}

// ── Main component ──

const SPEED_ITEMS = [
  { value: '0.5', label: '0.5x' },
  { value: '1', label: '1x' },
  { value: '2', label: '2x' },
  { value: '4', label: '4x' },
  { value: 'max', label: 'Max' },
];

const THEME_ITEMS = [
  { value: 'dark', label: 'Dark' },
  { value: 'light', label: 'Light' },
];

const TEXT_SIZE_ITEMS = [
  { value: 'normal', label: 'Normal' },
  { value: 'large', label: 'Large' },
];

const BOUNDARY_ITEMS = [
  { value: 'contain', label: 'Contain' },
  { value: 'remove', label: 'Remove' },
];

function formatDamping(sliderVal: number): string {
  const t = sliderVal / 100;
  const d = t === 0 ? 0 : 0.5 * t * t * t;
  if (d === 0) return 'None';
  if (d < 0.001) return d.toExponential(0);
  return d.toFixed(3);
}

function sliderToDamping(sliderVal: number): number {
  const t = sliderVal / 100;
  return t === 0 ? 0 : 0.5 * t * t * t;
}

export function SettingsSheet() {
  const activeSheet = useAppStore((s) => s.activeSheet);
  const theme = useAppStore((s) => s.theme);
  const textSize = useAppStore((s) => s.textSize);
  const targetSpeed = useAppStore((s) => s.targetSpeed);
  const atomCount = useAppStore((s) => s.atomCount);
  const activeAtomCount = useAppStore((s) => s.activeAtomCount);
  const wallRemovedCount = useAppStore((s) => s.wallRemovedCount);
  const molecules = useAppStore((s) => s.molecules);
  const dragStrength = useAppStore((s) => s.dragStrength);
  const rotateStrength = useAppStore((s) => s.rotateStrength);
  const dampingSliderValue = useAppStore((s) => s.dampingSliderValue);
  const boundaryMode = useAppStore((s) => s.boundaryMode);
  const maxSpeed = useAppStore((s) => s.maxSpeed);
  const warmUpComplete = useAppStore((s) => s.warmUpComplete);
  const helpPageActive = useAppStore((s) => s.helpPageActive);
  const setHelpPageActive = useAppStore((s) => s.setHelpPageActive);
  const settingsCallbacks = useAppStore((s) => s.settingsCallbacks);

  const isOpen = activeSheet === 'settings';
  const { ref, mounted, animating, onTransitionEnd } = useSheetAnimation(isOpen);

  // Derive active speed label + gating (matches imperative updateSpeedButtons)
  const speedValue = targetSpeed === Infinity ? 'max' : String(targetSpeed);
  const gatedSpeedItems = SPEED_ITEMS.map((item) => {
    if (item.value === 'max') return item; // Max never disabled
    if (!warmUpComplete) return { ...item, disabled: true };
    return { ...item, disabled: parseFloat(item.value) > maxSpeed };
  });

  // Placed count — shows total atoms, not molecule count
  const placedCount = atomCount;

  const handleSpeed = useCallback((val: '0.5' | '1' | '2' | '4' | 'max') => settingsCallbacks?.onSpeedChange(val), [settingsCallbacks]);
  const handleTheme = useCallback((val: 'dark' | 'light') => settingsCallbacks?.onThemeChange(val), [settingsCallbacks]);
  const handleTextSize = useCallback((val: 'normal' | 'large') => settingsCallbacks?.onTextSizeChange(val), [settingsCallbacks]);
  const handleBoundary = useCallback((val: 'contain' | 'remove') => settingsCallbacks?.onBoundaryChange(val), [settingsCallbacks]);
  const handleDrag = useCallback((v: number) => settingsCallbacks?.onDragChange(v), [settingsCallbacks]);
  const handleRotate = useCallback((v: number) => settingsCallbacks?.onRotateChange(v), [settingsCallbacks]);
  const handleDamping = useCallback((sliderVal: number) => {
    settingsCallbacks?.onDampingChange(sliderToDamping(sliderVal));
  }, [settingsCallbacks]);

  if (!mounted) return null;

  const sheetClass = `sheet${animating ? ' open' : ''}`;

  return (
    <aside
      ref={ref as React.RefObject<HTMLElement>}
      className={sheetClass}
      aria-hidden={!isOpen}
      inert={!isOpen ? true : undefined}
      onTransitionEnd={onTransitionEnd}
    >
      <div className="sheet-handle" />

      {/* Main settings page */}
      <div className={`sheet-page${helpPageActive ? ' sheet-page-hidden' : ''}`}>
        <div className="sheet-header">Settings</div>
        <div style={{
          padding: 'var(--space-md) var(--space-lg)',
          paddingBottom: 'calc(var(--space-lg) + env(safe-area-inset-bottom, 0px))',
        }}>
          {/* Scene group */}
          <div className="group">
            <div className="group-header">Scene</div>
            <ul className="group-list">
              <li className="group-item group-action" onClick={() => settingsCallbacks?.onAddMolecule()}>
                Add Molecule
              </li>
              <li
                className="group-item group-action"
                style={{ color: 'var(--color-danger)' }}
                onClick={() => settingsCallbacks?.onClear()}
              >
                Clear
              </li>
              <li className="group-item group-action" onClick={() => settingsCallbacks?.onResetView()}>
                Reset View
              </li>
              <li className="group-item">
                <span>Atoms</span>
                <span className="group-value">
                  {wallRemovedCount > 0 ? `${activeAtomCount} / ${placedCount}` : placedCount}
                </span>
              </li>
            </ul>
          </div>

          {/* Simulation group */}
          <div className="group">
            <div className="group-header">Simulation</div>
            <ul className="group-list">
              <li className="group-item">
                <span>Speed</span>
                <Segmented
                  name="speed"
                  legend="Simulation speed"
                  items={gatedSpeedItems}
                  activeValue={speedValue}
                  onSelect={handleSpeed}
                />
              </li>
              <SliderRow
                label="Damping"
                min={0}
                max={100}
                step={1}
                value={dampingSliderValue}
                formatValue={formatDamping}
                onChange={handleDamping}
              />
            </ul>
          </div>

          {/* Interaction group */}
          <div className="group">
            <div className="group-header">Interaction</div>
            <ul className="group-list">
              <SliderRow
                label="Drag Strength"
                min={0.5}
                max={10}
                step={0.5}
                value={dragStrength}
                formatValue={(v) => v.toFixed(1)}
                onChange={handleDrag}
              />
              <SliderRow
                label="Rotate Strength"
                min={1}
                max={20}
                step={1}
                value={rotateStrength}
                formatValue={(v) => v.toFixed(1)}
                onChange={handleRotate}
              />
            </ul>
          </div>

          {/* Appearance group */}
          <div className="group">
            <div className="group-header">Appearance</div>
            <ul className="group-list">
              <li className="group-item">
                <span>Theme</span>
                <Segmented
                  name="theme"
                  legend="Theme"
                  items={THEME_ITEMS}
                  activeValue={theme}
                  onSelect={handleTheme}
                />
              </li>
              <li className="group-item">
                <span>Text Size</span>
                <Segmented
                  name="text-size"
                  legend="Text size"
                  items={TEXT_SIZE_ITEMS}
                  activeValue={textSize}
                  onSelect={handleTextSize}
                />
              </li>
            </ul>
          </div>

          {/* Boundary group */}
          <div className="group">
            <div className="group-header">Boundary</div>
            <ul className="group-list">
              <li className="group-item">
                <span>Mode</span>
                <Segmented
                  name="boundary-mode"
                  legend="Boundary mode"
                  items={BOUNDARY_ITEMS}
                  activeValue={boundaryMode}
                  onSelect={handleBoundary}
                />
              </li>
            </ul>
          </div>

          {/* Help group */}
          <div className="group">
            <div className="group-header">Help</div>
            <ul className="group-list">
              <li
                className="group-item"
                style={{ cursor: 'pointer' }}
                onClick={() => setHelpPageActive(true)}
              >
                <span>Controls</span>
                <span className="group-value">{'\u203A'}</span>
              </li>
            </ul>
          </div>
        </div>
      </div>

      {/* Help drill-in page */}
      <div className={`sheet-page${helpPageActive ? '' : ' sheet-page-hidden'}`}>
        <div className="sheet-header" style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-sm)' }}>
          <button
            className="panel-btn"
            style={{ padding: '4px 8px' }}
            onClick={() => setHelpPageActive(false)}
          >
            {'\u2039'} Back
          </button>
          <span>Controls</span>
        </div>
        <div style={{ padding: 'var(--space-md) var(--space-lg)', lineHeight: 1.7, fontSize: 'var(--font-sm)' }}>
          <div className="help-section-title">Interaction Modes</div>
          <div><b>Atom</b> — drag individual atom (spring force)</div>
          <div><b>Move</b> — translate entire molecule</div>
          <div><b>Rotate</b> — spin molecule (torque)</div>
          <div className="help-section-title" style={{ marginTop: 12 }}>Desktop</div>
          <div><b>Left-drag on atom</b> — interact (depends on mode)</div>
          <div><b>Left-drag fast + release</b> — flick / push atom (Atom mode)</div>
          <div><b>Ctrl + click on atom</b> — rotate (shortcut, any mode)</div>
          <div><b>Right-drag</b> — orbit camera</div>
          <div><b>Scroll wheel</b> — zoom</div>
          <div className="help-section-title" style={{ marginTop: 12 }}>Mobile</div>
          <div><b>1-finger drag on atom</b> — interact (depends on mode)</div>
          <div><b>2-finger pinch</b> — zoom</div>
          <div><b>2-finger drag</b> — pan camera</div>
          <div className="help-section-title" style={{ marginTop: 12 }}>Playground</div>
          <div><b>Add</b> — place a new molecule in the scene</div>
          <div><b>Clear</b> — remove all molecules</div>
          <div>New molecules appear next to the molecule nearest the center of your view.</div>
        </div>
      </div>
    </aside>
  );
}
