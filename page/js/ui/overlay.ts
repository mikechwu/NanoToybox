/**
 * Overlay controller — manages settings/chooser sheet open/close state,
 * backdrop behavior, and help drill-in page switching.
 *
 * One overlay at a time: 'none' | 'settings' | 'chooser'.
 * Opening one closes the previous. Help is a drill-in page inside settings,
 * not a separate overlay.
 *
 * DOM ownership: settings-sheet, chooser-sheet, sheet-backdrop, sheet-main, sheet-help.
 * Lifecycle: destroy() removes all attached listeners.
 */
import { requireEl } from '../shared/require-el';

export class OverlayController {
  _settingsSheet: HTMLElement;
  _chooserSheet: HTMLElement;
  _backdrop: HTMLElement;
  _sheetMain: HTMLElement;
  _sheetHelp: HTMLElement;
  _current: 'none' | 'settings' | 'chooser';
  _onBackdropClick: () => void;

  /**
   * @param {object} opts
   * @param {HTMLElement} opts.settingsSheet
   * @param {HTMLElement} opts.chooserSheet
   * @param {HTMLElement} opts.backdrop
   * @param {HTMLElement} opts.sheetMain - settings top-level page
   * @param {HTMLElement} opts.sheetHelp - help drill-in page
   */
  constructor({ settingsSheet, chooserSheet, backdrop, sheetMain, sheetHelp }: {
    settingsSheet: HTMLElement; chooserSheet: HTMLElement; backdrop: HTMLElement;
    sheetMain: HTMLElement; sheetHelp: HTMLElement;
  }) {
    this._settingsSheet = requireEl('settings-sheet', settingsSheet);
    this._chooserSheet = requireEl('chooser-sheet', chooserSheet);
    this._backdrop = requireEl('sheet-backdrop', backdrop);
    this._sheetMain = requireEl('sheet-main', sheetMain);
    this._sheetHelp = requireEl('sheet-help', sheetHelp);
    this._current = 'none';

    // Backdrop click closes overlay
    this._onBackdropClick = () => this.close();
    this._backdrop.addEventListener('click', this._onBackdropClick);
  }

  /** @returns {'none'|'settings'|'chooser'} */
  get current() { return this._current; }

  /** Open an overlay. If same overlay is open, close it (toggle). */
  open(name) {
    if (this._current === name) { this.close(); return; }
    if (this._current !== 'none') this._hide(this._current);
    this._current = name;
    this._show(name);
  }

  /** Close the current overlay. */
  close() {
    if (this._current === 'none') return;
    this._hide(this._current);
    this._current = 'none';
  }

  /** Show help drill-in page inside settings sheet. */
  showHelpPage() {
    this._sheetMain.classList.add('sheet-page-hidden');
    this._sheetHelp.classList.remove('sheet-page-hidden');
  }

  /** Return to settings main page from help. */
  showMainPage() {
    this._sheetHelp.classList.add('sheet-page-hidden');
    this._sheetMain.classList.remove('sheet-page-hidden');
  }

  /** @private */
  _show(name) {
    const sheet = name === 'settings' ? this._settingsSheet : this._chooserSheet;
    sheet.classList.add('sheet-visible');
    sheet.removeAttribute('inert');
    sheet.setAttribute('aria-hidden', 'false');
    this._backdrop.classList.add('sheet-visible');
    // Trigger reflow for transition
    sheet.offsetHeight; // eslint-disable-line no-unused-expressions
    sheet.classList.add('open');
    this._backdrop.classList.add('visible');
  }

  /** @private */
  _hide(name) {
    const sheet = name === 'settings' ? this._settingsSheet : this._chooserSheet;
    sheet.classList.remove('open');
    sheet.setAttribute('aria-hidden', 'true');
    sheet.setAttribute('inert', '');
    this._backdrop.classList.remove('visible');

    // Remove sheet-visible after transition ends (fully unmount from layout).
    // Fallback: if transition duration is 0 (prefers-reduced-motion), remove immediately.
    const backdrop = this._backdrop;
    const sheetDuration = parseFloat(getComputedStyle(sheet).transitionDuration);
    if (sheetDuration === 0) {
      sheet.classList.remove('sheet-visible');
      backdrop.classList.remove('sheet-visible');
    } else {
      sheet.addEventListener('transitionend', function onEnd() {
        sheet.removeEventListener('transitionend', onEnd);
        if (!sheet.classList.contains('open')) {
          sheet.classList.remove('sheet-visible');
        }
      });
      backdrop.addEventListener('transitionend', function onEnd() {
        backdrop.removeEventListener('transitionend', onEnd);
        if (!backdrop.classList.contains('visible')) {
          backdrop.classList.remove('sheet-visible');
        }
      });
    }

    // Reset help drill-in when closing settings
    if (name === 'settings') {
      this.showMainPage();
    }
  }

  destroy() {
    if (this._backdrop && this._onBackdropClick) {
      this._backdrop.removeEventListener('click', this._onBackdropClick);
    }
  }
}
