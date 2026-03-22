/**
 * Status controller — manages transient status text and hint fade.
 *
 * DOM ownership: #status, #hint.
 * Lifecycle: destroy() clears pending timers.
 */
export class StatusController {
  /**
   * @param {object} opts
   * @param {HTMLElement} opts.statusEl - #status element
   * @param {HTMLElement} opts.hintEl - #hint element
   */
  constructor({ statusEl, hintEl }) {
    this._statusEl = statusEl;
    this._hintEl = hintEl;
    this._hintFaded = false;
  }

  /** Update the status text. */
  update(text) {
    if (this._statusEl) this._statusEl.textContent = text;
  }

  /**
   * Update status text based on scene state.
   * @param {number} moleculeCount
   * @param {number} totalAtoms
   */
  updateSceneStatus(moleculeCount, totalAtoms) {
    if (moleculeCount === 0) {
      this.update('Empty playground — add a molecule');
    } else {
      this.update(`${moleculeCount} molecule${moleculeCount > 1 ? 's' : ''} · ${totalAtoms} atoms`);
    }
  }

  /** Fade out the onboarding hint (one-shot). */
  fadeHint() {
    if (this._hintFaded) return;
    this._hintFaded = true;
    if (this._hintEl) {
      this._hintEl.classList.add('fade');
      this._hintTimer = setTimeout(() => { this._hintEl.style.display = 'none'; }, 2000);
    }
  }

  /** Clean up any pending timers. */
  destroy() {
    if (this._hintTimer) {
      clearTimeout(this._hintTimer);
      this._hintTimer = null;
    }
  }
}
