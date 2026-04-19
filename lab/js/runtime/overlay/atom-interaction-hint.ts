/**
 * Atom-interaction hint — floating bubble that teaches users to drag
 * any atom to begin.
 *
 * Positioning contract
 * --------------------
 *   · Target atom: chosen once via `pickHintTargetAtom` — the boundary
 *     atom nearest the 2D viewport center (see `hint-target.ts`).
 *   · Outward direction: unit vector from the on-screen cluster
 *     centroid to the target atom. Because the target sits on the
 *     convex hull, this vector always points AWAY from the hull
 *     interior, so pushing the bubble along it places the bubble
 *     outside the hull.
 *   · Offset magnitude:
 *       d = atomScreenRadius + gap + boxExtent + hullPad
 *     where
 *       · atomScreenRadius — per-atom display radius in CSS pixels,
 *         asked of the renderer every frame so the bubble never
 *         overlaps the atom even when the atom's scale changes
 *         (future per-element sizing / zoom).
 *       · gap            — user-configurable breathing room.
 *       · boxExtent      — distance from bubble CENTER to its EDGE
 *         along the outward direction (ray-box intersection). Ensures
 *         the bubble's nearest edge sits at least `gap + atomRadius`
 *         from the atom, not just its center.
 *       · hullPad        — small safety margin against hull concavity
 *         / floating-point noise; keeps the bubble comfortably off the
 *         cluster even at the worst-case viewing angle.
 *
 * Historical note: a prior iteration rendered a triangular tail
 * attached to the bubble with the tip continuously tracking the
 * target atom (speech-bubble silhouette). The tail was removed for
 * visual simplicity — the bubble's proximity to its target already
 * makes the referent obvious without a pointer. The helper
 * `computeTailGeometry` and its CSS were removed alongside; if a
 * future design wants the tail back, restore from git history rather
 * than re-derive.
 *
 * Lifecycle: show() / dismiss() / reset() / destroy().
 */

import { useAppStore } from '../../store/app-store';
import {
  pickHintTargetAtom,
  projectAtomsToNDC,
  computeOnScreenCentroid,
  rayBoxExit,
} from './hint-target';

// ── Constants (tuned for feel, not per-device) ────────────────────────

/**
 * Canonical hint copy. Chosen from:
 *   · "Click or tap an atom to interact"  — verbose, mentions UI input
 *   · "Tap or drag an atom"                — two verbs, feels hedged
 *   · "Grab an atom"                       — too brief, unclear outcome
 *   · "Drag any atom to start"             — imperative, inclusive
 *                                           ("any" invites), "start"
 *                                           implies agency and outcome.
 *                                           Works on touch + mouse.
 *   · "Drag me to play"                    — cute but reads as a label
 *                                           for one atom, not all.
 *
 * Winner: **"Drag any atom to start"** — the caret already localizes
 * the action to a specific atom visually, so the copy can speak in the
 * general case ("any") and focus on the verb ("drag") and outcome
 * ("start"). 4 words, single line on phone, legible.
 */
export const ATOM_HINT_COPY = 'Drag any atom to start';

/** Smoothing factor for the frame-to-frame hint position.
 *  0 = no smoothing (jitters with atom), 1 = frozen.
 *  ~0.35 is crisp-following without visible jitter. */
const FOLLOW_SMOOTHING = 0.35;

/** Extra breathing room between the atom edge and the bubble edge.
 *  Separate from the per-atom radius so tuning "how close is too close"
 *  is one number. */
const ATOM_GAP_PX = 10;

/** Safety margin beyond the ray-box-exit distance, to keep the bubble
 *  fully outside the hull even when viewing angle pushes hull edges
 *  slightly toward the bubble. */
const HULL_PAD_PX = 6;

/**
 * Dependencies the runtime needs. Passed as getters so main.ts can
 * wire live references that are not yet available at runtime-construction
 * time (the canvas / physics refs only exist after boot).
 */
export interface AtomInteractionHintDeps {
  /** Host element. The runtime appends its bubble under this node.
   *  Typically `document.getElementById('atom-hint')`. Null in tests
   *  without a mounted DOM — runtime no-ops gracefully. */
  getHostEl: () => HTMLElement | null;
  /** Three.js/camera-aware projector. World [x,y,z] → NDC [x,y,z]. */
  projectToNDC: (world: [number, number, number]) => [number, number, number];
  /** Canvas bounding rect in CSS pixels. Used to translate NDC → canvas pixels. */
  getCanvasRect: () => DOMRect | null;
  /** Live physics positions buffer + atom count. */
  getPhysics: () => { n: number; pos: Float64Array } | null;
  /** Per-atom display radius projected to CSS pixels. Renderer-owned so
   *  future per-element sizing doesn't require a hint-runtime rewrite. */
  getAtomScreenRadius: (atomIdx: number) => number;
  /** Debug hook: pure test seam to inject a fixed target atom index
   *  (bypasses the target-picker). Optional — production callers omit. */
  pickOverride?: () => number | null;
}

export interface AtomInteractionHintRuntime {
  /** Attempt to show the hint. Idempotent — safe to call multiple
   *  times across readiness ticks; only the first call that succeeds
   *  paints the bubble. */
  show(): void;
  /** Dismiss: fade out, stop rAF loop, clear DOM. The runtime cannot
   *  be re-shown after dismiss without an explicit `reset()`. */
  dismiss(): void;
  /** Reset so the next `show()` can re-engage (e.g., after a full
   *  scene replacement). Idempotent. */
  reset(): void;
  /** Full teardown for HMR / page unload. */
  destroy(): void;
}

export function createAtomInteractionHint(
  deps: AtomInteractionHintDeps,
): AtomInteractionHintRuntime {
  let _targetIdx: number | null = null;
  let _rafId: number | null = null;
  let _bubble: HTMLDivElement | null = null;
  let _dismissed = false;
  /** Smoothed screen-space (CSS pixel) position — read each frame,
   *  updated via EMA toward the current projected target. `null` until
   *  the first valid projection to avoid a visible "fly-in" from
   *  (0,0) on the first frame. */
  let _smoothed: { x: number; y: number } | null = null;

  /** Project the target atom to canvas pixels + also fetch the
   *  on-screen projections of EVERY atom so we can compute the
   *  cluster centroid for outward-direction math. Returns null if the
   *  target is unreachable this frame (off-screen, physics not ready,
   *  etc.). */
  function computeFrameGeometry(): {
    targetPx: { x: number; y: number };
    atomRadiusPx: number;
    outward: { x: number; y: number };
  } | null {
    if (_targetIdx == null) return null;
    const phys = deps.getPhysics();
    const rect = deps.getCanvasRect();
    if (!phys || phys.n === 0 || !rect || rect.width === 0 || rect.height === 0) return null;
    if (_targetIdx >= phys.n) return null;

    // Project every atom — cheap (single pass, ~hundreds of atoms in
    // typical scenes). We need both the target's NDC position AND the
    // cluster centroid for the outward direction.
    const projected = projectAtomsToNDC(phys.pos, phys.n, deps.projectToNDC);
    const targetProj = projected[_targetIdx];
    if (!targetProj || !targetProj.onScreen) return null;

    // Centroid of all on-screen atoms — the "cluster center" in NDC.
    const centroid = computeOnScreenCentroid(projected);

    // Convert target NDC → canvas pixels.
    const targetPx = {
      x: rect.left + ((targetProj.ndcX + 1) / 2) * rect.width,
      y: rect.top + ((1 - targetProj.ndcY) / 2) * rect.height,
    };

    // Outward direction. NDC → pixel space flips Y, so convert the
    // centroid to pixels too before subtracting, else diagonal
    // outward vectors would be slightly rotated.
    let outward = { x: 0, y: -1 }; // default: straight up
    if (centroid) {
      const centroidPx = {
        x: rect.left + ((centroid.x + 1) / 2) * rect.width,
        y: rect.top + ((1 - centroid.y) / 2) * rect.height,
      };
      const dx = targetPx.x - centroidPx.x;
      const dy = targetPx.y - centroidPx.y;
      const len = Math.hypot(dx, dy);
      if (len > 0.5) {
        // > 0.5 px guards against coincident target + centroid, which
        // can happen for single-atom scenes or perfectly symmetric
        // clusters with the target at the center. In that case, the
        // default "up" direction is a reasonable fallback.
        outward = { x: dx / len, y: dy / len };
      }
    }

    const atomRadiusPx = deps.getAtomScreenRadius(_targetIdx);
    return { targetPx, atomRadiusPx, outward };
  }

  /** Per-frame positioning. Computes outward offset + tail geometry,
   *  writes CSS custom properties on the host. */
  function paintFrame(host: HTMLElement): void {
    const geom = computeFrameGeometry();
    if (!geom || !_bubble) {
      host.dataset.visible = 'false';
      return;
    }

    // Bubble size is layout-dependent — read it live so CSS / text
    // changes propagate without JS updates. Zero-dim fallback when
    // the bubble hasn't laid out yet (first paint).
    const brect = _bubble.getBoundingClientRect();
    const halfW = brect.width / 2;
    const halfH = brect.height / 2;
    if (halfW === 0 || halfH === 0) {
      host.dataset.visible = 'false';
      return;
    }

    // Distance from bubble CENTER to bubble EDGE along outward.
    const boxExtent = rayBoxExit(halfW, halfH, geom.outward.x, geom.outward.y);

    // Total outward offset so the bubble's nearest edge sits gap+radius
    // from the atom's visible surface.
    const d = geom.atomRadiusPx + ATOM_GAP_PX + boxExtent + HULL_PAD_PX;

    // Target bubble CENTER position in page coords.
    const targetX = geom.targetPx.x + geom.outward.x * d;
    const targetY = geom.targetPx.y + geom.outward.y * d;

    // Smoothed follow — damp thermal jitter on the atom without lagging
    // the hint behind deliberate camera motion.
    if (!_smoothed) {
      _smoothed = { x: targetX, y: targetY };
    } else {
      _smoothed.x += (targetX - _smoothed.x) * FOLLOW_SMOOTHING;
      _smoothed.y += (targetY - _smoothed.y) * FOLLOW_SMOOTHING;
    }

    host.style.setProperty('--atom-hint-x', `${_smoothed.x}px`);
    host.style.setProperty('--atom-hint-y', `${_smoothed.y}px`);

    host.dataset.visible = 'true';
  }

  /** Start the rAF loop that positions the bubble each frame. */
  function startFollowing(host: HTMLElement): void {
    if (_rafId != null) return;
    const tick = (): void => {
      if (_dismissed) return;
      paintFrame(host);
      _rafId = requestAnimationFrame(tick);
    };
    _rafId = requestAnimationFrame(tick);
  }

  function stopFollowing(): void {
    if (_rafId != null) {
      cancelAnimationFrame(_rafId);
      _rafId = null;
    }
  }

  /** Gating rules: no active sheet / placement / review mode. */
  function eligibleToShow(): boolean {
    if (_dismissed) return false;
    const s = useAppStore.getState();
    if (s.activeSheet !== null) return false;
    if (s.placementActive) return false;
    if (s.timelineMode === 'review') return false;
    if (s.atomCount === 0) return false;
    return true;
  }

  return {
    show(): void {
      if (_dismissed || _bubble) return;
      if (!eligibleToShow()) return;

      const host = deps.getHostEl();
      if (!host) return;

      const phys = deps.getPhysics();
      if (!phys || phys.n === 0) return;

      const override = deps.pickOverride?.() ?? null;
      _targetIdx = override != null
        ? override
        : pickHintTargetAtom(phys.pos, phys.n, deps.projectToNDC);
      if (_targetIdx == null) return;

      // Paint the bubble. Text goes in a dedicated span so future
      // overlays (e.g., a chevron / illustration) can attach as
      // siblings without disturbing text metrics.
      _bubble = document.createElement('div');
      _bubble.className = 'atom-hint__bubble';
      const textEl = document.createElement('span');
      textEl.className = 'atom-hint__text';
      textEl.textContent = ATOM_HINT_COPY;
      _bubble.appendChild(textEl);
      host.appendChild(_bubble);
      host.dataset.visible = 'false'; // becomes 'true' on first valid paint

      startFollowing(host);
    },

    dismiss(): void {
      if (_dismissed) return;
      _dismissed = true;
      stopFollowing();
      const host = deps.getHostEl();
      if (host) {
        host.dataset.visible = 'false';
        // CSS fade-out on opacity; wait the transition duration then
        // remove DOM so the animation completes visually.
        const transitionMs = 260;
        setTimeout(() => {
          if (_bubble && _bubble.parentNode) _bubble.parentNode.removeChild(_bubble);
          _bubble = null;
          if (host.dataset.visible === 'false') delete host.dataset.visible;
        }, transitionMs);
      } else {
        _bubble = null;
      }
    },

    reset(): void {
      _dismissed = false;
      _targetIdx = null;
      _smoothed = null;
      stopFollowing();
      const host = deps.getHostEl();
      if (host) {
        if (_bubble && _bubble.parentNode) _bubble.parentNode.removeChild(_bubble);
        _bubble = null;
        delete host.dataset.visible;
      }
    },

    destroy(): void {
      stopFollowing();
      _dismissed = true;
      _targetIdx = null;
      _smoothed = null;
      const host = deps.getHostEl();
      if (host) {
        if (_bubble && _bubble.parentNode) _bubble.parentNode.removeChild(_bubble);
        _bubble = null;
        delete host.dataset.visible;
      }
    },
  };
}
