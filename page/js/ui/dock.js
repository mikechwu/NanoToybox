/**
 * Dock controller — manages the primary navigation dock.
 *
 * Owns: dock element, add/pause/settings/cancel buttons, mode segmented control.
 * Placement mode: swaps dock slots via .placement CSS class.
 * All action callbacks are set via on* methods.
 *
 * DOM ownership: #dock, #dock-add, #dock-add-label, #dock-pause,
 *   #dock-settings, #dock-cancel, #mode-seg.
 * Lifecycle: destroy() removes all attached listeners.
 */
import { wireSegmented } from '../shared/segmented.js';
import { requireEl } from '../shared/require-el.js';

export class DockController {
  /**
   * @param {object} opts - DOM element refs
   */
  constructor({ dockEl, addBtn, addIcon, addLabel, modeSeg, pauseBtn, settingsBtn, cancelBtn }) {
    this._dockEl = requireEl('dock', dockEl);
    this._addBtn = requireEl('dock-add', addBtn);
    this._addIcon = requireEl('dock-add .dock-icon', addIcon);
    this._addLabel = requireEl('dock-add-label', addLabel);
    this._pauseBtn = requireEl('dock-pause', pauseBtn);
    this._settingsBtn = requireEl('dock-settings', settingsBtn);
    this._cancelBtn = requireEl('dock-cancel', cancelBtn);
    requireEl('mode-seg', modeSeg);

    // Callbacks (set by main.js via on* methods)
    this._onAdd = null;
    this._onPause = null;
    this._onSettings = null;
    this._onCancel = null;
    this._onModeChange = null;

    // Wire button clicks
    this._handlers = {
      add: () => { if (this._onAdd) this._onAdd(); },
      pause: () => { if (this._onPause) this._onPause(); },
      settings: () => { if (this._onSettings) this._onSettings(); },
      cancel: () => { if (this._onCancel) this._onCancel(); },
    };
    addBtn.addEventListener('click', this._handlers.add);
    pauseBtn.addEventListener('click', this._handlers.pause);
    settingsBtn.addEventListener('click', this._handlers.settings);
    cancelBtn.addEventListener('click', this._handlers.cancel);

    // Wire mode segmented (store disposer for destroy)
    this._disposeModeSeg = wireSegmented(modeSeg, (label) => {
      if (this._onModeChange) this._onModeChange(label.dataset.mode);
    });
  }

  /** Register callback for Add button click. */
  onAdd(cb) { this._onAdd = cb; }
  /** Register callback for Pause button click. */
  onPause(cb) { this._onPause = cb; }
  /** Register callback for Settings button click. */
  onSettings(cb) { this._onSettings = cb; }
  /** Register callback for Cancel button click (during placement). */
  onCancel(cb) { this._onCancel = cb; }
  /** Register callback for mode change (receives mode string). */
  onModeChange(cb) { this._onModeChange = cb; }

  /**
   * Switch dock to placement mode (Place/Cancel) or back to normal.
   * CSS .dock.placement handles slot visibility swap.
   */
  setPlacementMode(active) {
    if (active) {
      this._addIcon.textContent = '✓';
      this._addLabel.textContent = 'Place';
      this._dockEl.classList.add('placement');
      this._pauseBtn.disabled = true;
      this._settingsBtn.disabled = true;
    } else {
      this._addIcon.textContent = '+';
      this._dockEl.classList.remove('placement');
      this._pauseBtn.disabled = false;
      this._settingsBtn.disabled = false;
      this.updateAddLabel();
    }
  }

  /** Update Add button label. Always shows "Add" — repeat-add is via chooser Recent row. */
  updateAddLabel() {
    this._addLabel.textContent = 'Add';
  }

  /**
   * Update Pause button label.
   * @param {boolean} paused
   */
  setPauseLabel(paused) {
    const label = this._pauseBtn.querySelector('.dock-label');
    if (label) label.textContent = paused ? 'Resume' : 'Pause';
  }

  /** Get dock element height (for renderer overlay insets). */
  getHeight() {
    return this._dockEl ? this._dockEl.offsetHeight : 60;
  }

  destroy() {
    this._addBtn.removeEventListener('click', this._handlers.add);
    this._pauseBtn.removeEventListener('click', this._handlers.pause);
    this._settingsBtn.removeEventListener('click', this._handlers.settings);
    this._cancelBtn.removeEventListener('click', this._handlers.cancel);
    if (this._disposeModeSeg) this._disposeModeSeg();
  }

  /**
   * Whether glass UI surfaces are active. The dock is always visible with
   * backdrop-filter glass — returns true by design when the dock is constructed.
   * If the dock ever becomes hideable (e.g., fullscreen mode), evolve this into
   * real state-backed visibility tracking.
   */
  isGlassActive() { return true; }
}
