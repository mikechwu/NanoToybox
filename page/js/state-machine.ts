/**
 * Interaction state machine.
 *
 * States: IDLE, HOVER, DRAG, MOVE, FLICK, ROTATE, CAMERA
 *
 * Invariants:
 *   INV-1: Only one active interaction at a time
 *   INV-2: Selection is immutable during interaction
 *   INV-3: Camera and object interaction cannot overlap
 *   INV-4: All states are explicit (no implicit behavior)
 *   INV-5: Forces are zero when not interacting
 */

/** A command emitted by the state machine to be dispatched to interaction handler. */
export type Command =
  | { action: 'highlight'; atom: number }
  | { action: 'clearHighlight'; atom: number }
  | { action: 'startDrag'; atom: number }
  | { action: 'updateDrag'; screenX: number; screenY: number }
  | { action: 'endDrag'; atom: number }
  | { action: 'flick'; atom: number; vx: number; vy: number }
  | { action: 'startMove'; atom: number }
  | { action: 'updateMove'; screenX: number; screenY: number }
  | { action: 'endMove'; atom: number }
  | { action: 'startRotate'; atom: number }
  | { action: 'updateRotate'; screenX: number; screenY: number }
  | { action: 'endRotate'; atom: number; vx: number; vy: number }
  | { action: 'startCamera' }
  | { action: 'endCamera' }
  | { action: 'cancelInteraction'; atom: number }
  | { action: 'forceIdle'; atom: number };

export const State = {
  IDLE: 'idle',
  HOVER: 'hover',
  DRAG: 'drag',
  MOVE: 'move',
  FLICK: 'flick',
  ROTATE: 'rotate',
  CAMERA: 'camera',
};

export class StateMachine {
  state: string;
  selectedAtom: number;
  dragStartTime: number;
  dragStartPos: number[];
  lastPositions: number[][];
  rotationStartAngle: number;
  lastAngles: number[];

  constructor() {
    this.state = State.IDLE;
    this.selectedAtom = -1;
    this.dragStartTime = 0;
    this.dragStartPos = [0, 0];
    this.lastPositions = [];
    this.rotationStartAngle = 0;
    this.lastAngles = [];
  }

  getState() { return this.state; }
  getSelectedAtom() { return this.selectedAtom; }
  /** Candidate atom for hover (may differ from locked selection) */
  getHoverAtom() { return this.state === State.HOVER ? this.selectedAtom : -1; }

  isInteracting() {
    return this.state === State.DRAG || this.state === State.FLICK ||
           this.state === State.MOVE || this.state === State.ROTATE;
  }

  isCameraActive() {
    return this.state === State.CAMERA;
  }

  /**
   * State-driven feedback query — renderer reads this every frame.
   * Returns atom indices and active interaction type.
   * No event-based flicker — purely a function of current state.
   */
  getFeedbackState() {
    return {
      hoverAtom: this.state === State.HOVER ? this.selectedAtom : -1,
      activeAtom: this.isInteracting() ? this.selectedAtom : -1,
      isDragging: this.state === State.DRAG,
      isMoving: this.state === State.MOVE,
      isRotating: this.state === State.ROTATE,
    };
  }

  // --- Transition handlers ---

  onPointerOverAtom(atomIndex: number): Command | null {
    if (this.state === State.IDLE) {
      this.state = State.HOVER;
      this.selectedAtom = atomIndex;
      return { action: 'highlight', atom: atomIndex };
    }
    if (this.state === State.HOVER && atomIndex !== this.selectedAtom) {
      this.selectedAtom = atomIndex;
      return { action: 'highlight', atom: atomIndex };
    }
    return null;
  }

  onPointerOutAtom(): Command | null {
    if (this.state === State.HOVER) {
      this.state = State.IDLE;
      const prev = this.selectedAtom;
      this.selectedAtom = -1;
      return { action: 'clearHighlight', atom: prev };
    }
    return null;
  }

  /**
   * Handle pointer down on an atom or empty space.
   *
   * @param {number} atomIndex - atom index or -1 if missed
   * @param {number} screenX
   * @param {number} screenY
   * @param {string} interactionMode - 'atom' | 'move' | 'rotate'
   *   'atom' maps to State.DRAG, 'move' to State.MOVE, 'rotate' to State.ROTATE.
   *   Main.js resolves the mode from session state + Ctrl/Cmd override before calling.
   */
  onPointerDown(atomIndex: number, screenX: number, screenY: number, interactionMode: string): Command | null {
    // INV-1: reject if already interacting
    if (this.isInteracting()) return null;

    if (atomIndex >= 0) {
      // Hit an atom
      this.selectedAtom = atomIndex;
      this.dragStartTime = performance.now();
      this.dragStartPos = [screenX, screenY];
      this.lastPositions = [[screenX, screenY, performance.now()]];

      if (interactionMode === 'rotate') {
        this.state = State.ROTATE;
        this.lastAngles = [];
        return { action: 'startRotate', atom: atomIndex };
      }
      if (interactionMode === 'move') {
        this.state = State.MOVE;
        return { action: 'startMove', atom: atomIndex };
      }
      // 'atom' mode → DRAG state
      this.state = State.DRAG;
      return { action: 'startDrag', atom: atomIndex };
    }

    // Missed all atoms → camera
    this.state = State.CAMERA;
    return { action: 'startCamera' };
  }

  onPointerMove(screenX: number, screenY: number): Command | null {
    if (this.state === State.DRAG || this.state === State.FLICK) {
      this.lastPositions.push([screenX, screenY, performance.now()]);
      if (this.lastPositions.length > 5) this.lastPositions.shift();
      return { action: 'updateDrag', screenX, screenY };
    }
    if (this.state === State.MOVE) {
      this.lastPositions.push([screenX, screenY, performance.now()]);
      if (this.lastPositions.length > 5) this.lastPositions.shift();
      return { action: 'updateMove', screenX, screenY };
    }
    if (this.state === State.ROTATE) {
      this.lastPositions.push([screenX, screenY, performance.now()]);
      if (this.lastPositions.length > 5) this.lastPositions.shift();
      return { action: 'updateRotate', screenX, screenY };
    }
    return null;
  }

  onPointerUp(): Command | null {
    if (this.state === State.DRAG) {
      // Determine if this was a flick (fast release)
      const velocity = this._estimateVelocity();
      const speed = Math.sqrt(velocity[0] ** 2 + velocity[1] ** 2);

      const prev = this.selectedAtom;
      this.selectedAtom = -1;
      this.state = State.IDLE;

      if (speed > 2.0) {
        // Flick — apply velocity impulse
        return { action: 'flick', atom: prev, vx: velocity[0], vy: velocity[1] };
      }
      // Normal release
      return { action: 'endDrag', atom: prev };
    }

    if (this.state === State.MOVE) {
      const prev = this.selectedAtom;
      this.selectedAtom = -1;
      this.state = State.IDLE;
      return { action: 'endMove', atom: prev };
    }

    if (this.state === State.ROTATE) {
      const velocity = this._estimateVelocity();
      const prev = this.selectedAtom;
      this.selectedAtom = -1;
      this.state = State.IDLE;
      return { action: 'endRotate', atom: prev, vx: velocity[0], vy: velocity[1] };
    }

    if (this.state === State.CAMERA) {
      this.state = State.IDLE;
      return { action: 'endCamera' };
    }

    return null;
  }

  onCameraStart(): Command {
    // For 2-finger touch on mobile
    if (this.isInteracting()) {
      // INV-3 escape hatch: cancel interaction, switch to camera
      const prev = this.selectedAtom;
      this.selectedAtom = -1;
      this.state = State.CAMERA;
      return { action: 'cancelInteraction', atom: prev };
    }
    this.state = State.CAMERA;
    return { action: 'startCamera' };
  }

  onCameraEnd(): Command | null {
    if (this.state === State.CAMERA) {
      this.state = State.IDLE;
      return { action: 'endCamera' };
    }
    return null;
  }

  forceIdle(): Command {
    const prev = this.selectedAtom;
    this.selectedAtom = -1;
    this.state = State.IDLE;
    return { action: 'forceIdle', atom: prev };
  }

  _estimateVelocity() {
    const pts = this.lastPositions;
    if (pts.length < 2) return [0, 0];
    const last = pts[pts.length - 1];
    const prev = pts[Math.max(0, pts.length - 3)];
    const dt = (last[2] - prev[2]) / 1000; // seconds
    if (dt < 0.001) return [0, 0];
    return [(last[0] - prev[0]) / dt, (last[1] - prev[1]) / dt];
  }
}
