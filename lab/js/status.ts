/**
 * Status controller — manages contextual coachmarks on the shared
 * `#hint` surface.
 *
 * DOM ownership: `#hint` only. The element is an empty-by-default
 * coachmark surface (see `#hint:empty { display: none }` in
 * `lab/index.html`) — it paints iff a coachmark has injected text,
 * hides iff text is cleared. No `.fade` class, no display-timer
 * choreography: clearing `textContent` is the single hide primitive.
 *
 * Historical note: a generic "Click or tap an atom to interact"
 * onboarding hint used to inhabit this surface with a `fadeHint()`
 * fade-out on first interaction. That lifecycle was removed; a new
 * hint (different style, different location) will replace it via a
 * separate surface and its own controller.
 *
 * Status text display is handled by the Zustand store
 * (`statusText` / `statusError`) and the React StatusBar component —
 * not this controller.
 */

export class StatusController {
  _hintEl: HTMLElement | null;
  _activeCoachmark: { id: string; previousText: string } | null;

  constructor({ hintEl }: { hintEl: HTMLElement | null }) {
    this._hintEl = hintEl;
    this._activeCoachmark = null;
  }

  // ── Public coachmark API ──────────────────────────────────────────

  /**
   * Show a contextual coachmark on the shared surface.
   *
   * v1: one surface, one message at a time. A second `showCoachmark`
   * with a different `id` while another is active is a no-op (caller's
   * responsibility to hide first — matches prior contract).
   */
  showCoachmark({ id, text }: { id: string; text: string }): void {
    if (!this._hintEl) return;
    if (this._activeCoachmark && this._activeCoachmark.id !== id) return;
    if (!this._activeCoachmark) {
      this._activeCoachmark = { id, previousText: this._hintEl.textContent ?? '' };
    }
    this._hintEl.textContent = text;
  }

  /**
   * Hide a contextual coachmark, restoring whatever text (if any)
   * occupied the surface before it showed. In practice that's the
   * empty string — the surface defaults to `:empty` and nothing else
   * writes to it — so the post-hide state is "invisible again."
   */
  hideCoachmark(id: string): void {
    if (!this._hintEl || !this._activeCoachmark) return;
    if (this._activeCoachmark.id !== id) return;
    this._hintEl.textContent = this._activeCoachmark.previousText;
    this._activeCoachmark = null;
  }

  /**
   * Dismiss a coachmark without any restoration — used when an
   * overlay opens and the surface must clear immediately. Identical
   * to `hideCoachmark` today (no transition to cut through); kept as
   * a distinct API so callers encode their intent and future
   * animation work can diverge the two paths without a rewrite.
   */
  dismissCoachmark(id: string): void {
    if (!this._hintEl || !this._activeCoachmark) return;
    if (this._activeCoachmark.id !== id) return;
    this._hintEl.textContent = '';
    this._activeCoachmark = null;
  }

  /**
   * Clean up coachmark state and return the surface to its empty
   * baseline. Called at teardown / HMR / test cleanup.
   */
  destroy(): void {
    this._activeCoachmark = null;
    if (this._hintEl) this._hintEl.textContent = '';
  }
}
