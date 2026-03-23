/**
 * Status controller — manages transient status text, hint fade, and contextual coachmarks.
 *
 * DOM ownership: #status, #hint.
 * #hint is a shared surface: generic onboarding hint OR contextual coachmark (one at a time).
 * Lifecycle: destroy() clears pending timers, coachmark state, and restores hint DOM baseline.
 */
/** Time (ms) to wait after fade before setting display:none. Matches CSS transition. */
const HINT_FADE_MS = 2000;

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
    this._hintTimer = null;
    this._activeCoachmark = null; // { id, originalText }
    this._defaultHintText = hintEl ? hintEl.textContent : '';
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

  // ── Internal hint-surface helpers ──

  /** @private Cancel any pending hint display:none timer. */
  _cancelHintTimer() {
    if (this._hintTimer) { clearTimeout(this._hintTimer); this._hintTimer = null; }
  }

  /** @private Start a fade-out: add fade class, schedule display:none after transition. */
  _fadeOutHint() {
    if (!this._hintEl) return;
    this._hintEl.classList.add('fade');
    this._hintTimer = setTimeout(() => { this._hintEl.style.display = 'none'; }, HINT_FADE_MS);
  }

  /** @private Show the hint surface with given text (un-fade, make visible). */
  _showHintText(text) {
    if (!this._hintEl) return;
    this._hintEl.textContent = text;
    this._hintEl.style.display = '';
    this._hintEl.classList.remove('fade');
  }

  /** @private Immediately hide the hint surface (no transition). */
  _hideHintImmediate() {
    if (!this._hintEl) return;
    this._hintEl.style.display = 'none';
    this._hintEl.classList.remove('fade');
  }

  // ── Public hint/coachmark API ──

  /**
   * Fade out the onboarding hint (one-shot). Rule 5 aware:
   * if a coachmark is active, marks the generic hint as consumed
   * but does not touch the visible coachmark.
   */
  fadeHint() {
    if (this._hintFaded) return;
    this._hintFaded = true;
    if (this._activeCoachmark) return;
    this._fadeOutHint();
  }

  /**
   * Show a contextual coachmark, reusing the hint surface.
   * v1: one surface (#hint), one message at a time.
   * @param {object} opts
   * @param {string} opts.id - unique identifier (for targeted hide)
   * @param {string} opts.text - message to display
   */
  showCoachmark({ id, text }) {
    if (!this._hintEl) return;
    if (this._activeCoachmark && this._activeCoachmark.id !== id) return;
    this._cancelHintTimer();
    if (!this._activeCoachmark) {
      this._activeCoachmark = { id, originalText: this._hintEl.textContent };
    }
    this._showHintText(text);
  }

  /**
   * Hide a contextual coachmark and restore the hint surface.
   * Used when placement ends normally — may restore the generic hint.
   * @param {string} id - must match the active coachmark's id
   */
  hideCoachmark(id) {
    if (!this._hintEl || !this._activeCoachmark) return;
    if (this._activeCoachmark.id !== id) return;
    this._cancelHintTimer();
    if (this._hintFaded) {
      this._fadeOutHint();
    } else {
      this._hintEl.textContent = this._activeCoachmark.originalText;
    }
    this._activeCoachmark = null;
  }

  /**
   * Dismiss a coachmark without restoring the generic hint.
   * Used when an overlay opens — immediate hide, no transition.
   * @param {string} id - must match the active coachmark's id
   */
  dismissCoachmark(id) {
    if (!this._hintEl || !this._activeCoachmark) return;
    if (this._activeCoachmark.id !== id) return;
    this._cancelHintTimer();
    this._hideHintImmediate();
    this._activeCoachmark = null;
  }

  /**
   * Clean up timers, coachmark state, and restore hint DOM to neutral baseline.
   */
  destroy() {
    this._cancelHintTimer();
    this._activeCoachmark = null;
    if (this._hintEl) {
      this._hintEl.textContent = this._defaultHintText;
      this._hintEl.classList.remove('fade');
      this._hintEl.style.display = '';
    }
  }
}
