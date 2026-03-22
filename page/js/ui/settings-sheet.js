/**
 * Settings sheet controller — manages all settings sheet bindings.
 *
 * Owns: speed/theme/boundary segmented controls, drag/rotate/damping sliders,
 *   placed/active count rows, sheet action buttons (add molecule, clear, reset view, help).
 *
 * DOM ownership: all elements inside #settings-sheet content area.
 * Lifecycle: destroy() removes all attached listeners and nulls callbacks.
 */
import { wireSegmented } from '../shared/segmented.js';
import { requireEl } from '../shared/require-el.js';

export class SettingsSheetController {
  /**
   * @param {object} opts - DOM element refs
   */
  constructor({
    speedSeg, themeSeg, boundarySeg,
    dragSlider, dragVal, rotateSlider, rotateVal, dampingSlider, dampingVal,
    placedCountEl, activeRowEl, activeCountEl,
    addMoleculeBtn, clearBtn, resetViewBtn, helpLink, helpBackBtn,
  }) {
    // Validate required DOM refs
    requireEl('speed-seg', speedSeg);
    requireEl('theme-seg', themeSeg);
    requireEl('boundary-seg', boundarySeg);
    requireEl('drag-strength', dragSlider);
    requireEl('drag-val', dragVal);
    requireEl('rotate-strength', rotateSlider);
    requireEl('rotate-val', rotateVal);
    requireEl('damping-slider', dampingSlider);
    requireEl('damping-val', dampingVal);
    requireEl('sheet-add-molecule', addMoleculeBtn);
    requireEl('sheet-clear', clearBtn);
    requireEl('sheet-reset-view', resetViewBtn);
    requireEl('sheet-help-link', helpLink);
    requireEl('help-back', helpBackBtn);

    this._speedSeg = speedSeg;
    this._placedCountEl = placedCountEl;
    this._activeRowEl = activeRowEl;
    this._activeCountEl = activeCountEl;

    // Callbacks
    this._onSpeedChange = null;
    this._onThemeChange = null;
    this._onBoundaryChange = null;
    this._onAddMolecule = null;
    this._onClear = null;
    this._onResetView = null;
    this._onHelpOpen = null;
    this._onHelpBack = null;
    this._onDragChange = null;
    this._onRotateChange = null;
    this._onDampingChange = null;

    // Wire segmented controls (store disposers for destroy)
    this._disposers = [];
    this._disposers.push(wireSegmented(speedSeg, (label) => {
      if (this._onSpeedChange) this._onSpeedChange(label.dataset.speed);
    }));
    this._disposers.push(wireSegmented(themeSeg, (label) => {
      if (this._onThemeChange) this._onThemeChange(label.dataset.theme);
    }));
    this._disposers.push(wireSegmented(boundarySeg, (label) => {
      if (this._onBoundaryChange) this._onBoundaryChange(label.dataset.boundary);
    }));

    // Wire sliders (store refs for destroy)
    this._listenerPairs = [];
    const bindSlider = (el, handler) => {
      el.addEventListener('input', handler);
      el.addEventListener('change', handler);
      this._listenerPairs.push([el, 'input', handler], [el, 'change', handler]);
    };
    bindSlider(dragSlider, (e) => {
      const v = parseFloat(e.target.value);
      dragVal.textContent = v.toFixed(1);
      if (this._onDragChange) this._onDragChange(v);
    });
    bindSlider(rotateSlider, (e) => {
      const v = parseFloat(e.target.value);
      rotateVal.textContent = v.toFixed(0);
      if (this._onRotateChange) this._onRotateChange(v);
    });
    bindSlider(dampingSlider, (e) => {
      const t = parseFloat(e.target.value) / 100;
      const damping = t === 0 ? 0 : 0.5 * t * t * t;
      if (damping === 0) dampingVal.textContent = 'None';
      else if (damping < 0.001) dampingVal.textContent = damping.toExponential(0);
      else dampingVal.textContent = damping.toFixed(3);
      if (this._onDampingChange) this._onDampingChange(damping);
    });

    // Wire sheet action buttons (store refs for destroy)
    const wireBtn = (el, cb) => {
      const h = () => { const fn = cb(); if (fn) fn(); };
      el.addEventListener('click', h);
      this._listenerPairs.push([el, 'click', h]);
    };
    wireBtn(addMoleculeBtn, () => this._onAddMolecule);
    wireBtn(clearBtn, () => this._onClear);
    wireBtn(resetViewBtn, () => this._onResetView);
    wireBtn(helpLink, () => this._onHelpOpen);
    wireBtn(helpBackBtn, () => this._onHelpBack);
  }

  // Callback registration
  onSpeedChange(cb) { this._onSpeedChange = cb; }
  onThemeChange(cb) { this._onThemeChange = cb; }
  onBoundaryChange(cb) { this._onBoundaryChange = cb; }
  onAddMolecule(cb) { this._onAddMolecule = cb; }
  onClear(cb) { this._onClear = cb; }
  onResetView(cb) { this._onResetView = cb; }
  onHelpOpen(cb) { this._onHelpOpen = cb; }
  onHelpBack(cb) { this._onHelpBack = cb; }
  onDragChange(cb) { this._onDragChange = cb; }
  onRotateChange(cb) { this._onRotateChange = cb; }
  onDampingChange(cb) { this._onDampingChange = cb; }

  /** Update "Placed" count in Scene section. */
  updatePlacedCount(total) {
    if (this._placedCountEl) this._placedCountEl.textContent = total || '0';
  }

  /** Update "Active" row in Scene section. Shows only when atoms have been removed. */
  updateActiveCount(active, removed) {
    if (!this._activeRowEl || !this._activeCountEl) return;
    if (removed > 0) {
      const text = `${active} (${removed} removed)`;
      if (this._activeCountEl.textContent !== text) this._activeCountEl.textContent = text;
      this._activeRowEl.classList.remove('row-hidden');
    } else {
      if (!this._activeRowEl.classList.contains('row-hidden')) {
        this._activeRowEl.classList.add('row-hidden');
        this._activeCountEl.textContent = '';
      }
    }
  }

  destroy() {
    // Remove segmented control listeners
    for (const dispose of this._disposers) dispose();
    this._disposers.length = 0;
    // Remove slider and button listeners
    for (const [el, event, handler] of this._listenerPairs) {
      el.removeEventListener(event, handler);
    }
    this._listenerPairs.length = 0;
    // Null callbacks
    this._onSpeedChange = null;
    this._onThemeChange = null;
    this._onBoundaryChange = null;
    this._onAddMolecule = null;
    this._onClear = null;
    this._onResetView = null;
    this._onHelpOpen = null;
    this._onHelpBack = null;
    this._onDragChange = null;
    this._onRotateChange = null;
    this._onDampingChange = null;
  }

  /** Update speed button enable/disable based on maxSpeed and warm-up state. */
  updateSpeedButtons(maxSpeed, warmUpComplete) {
    if (!this._speedSeg) return;
    this._speedSeg.querySelectorAll('label').forEach(label => {
      const val = label.dataset.speed;
      if (val === 'max') {
        label.classList.remove('seg-disabled');
      } else if (!warmUpComplete) {
        label.classList.add('seg-disabled');
      } else {
        const spd = parseFloat(val);
        label.classList.toggle('seg-disabled', spd > maxSpeed);
      }
    });
  }
}
