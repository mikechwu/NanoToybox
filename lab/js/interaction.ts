/**
 * Interaction handler — dispatches state machine commands to physics + renderer.
 *
 * Pure function module: receives all dependencies as parameters.
 * Does not own DOM elements or persistent state.
 */
import * as THREE from 'three';
import type { Command } from './state-machine';
import type { Renderer } from './renderer';
import type { PhysicsEngine } from './physics';
import type { StateMachine } from './state-machine';
import type { InputManager } from './input';

const _atomRenderPos = new THREE.Vector3();

/**
 * Project screen coordinates to physics-space plane through the given atom.
 * @param {object} renderer
 * @param {object} inputManager
 * @param {number} atomIdx
 * @param {number} sx - screen X
 * @param {number} sy - screen Y
 * @returns {Array} [x, y, z] in physics space
 */
export function screenToPhysics(renderer: Renderer, inputManager: InputManager, atomIdx: number, sx: number, sy: number) {
  const atomRenderPos = renderer.getAtomWorldPosition(atomIdx, _atomRenderPos);
  return inputManager.screenToWorldOnAtomPlane(sx, sy, atomRenderPos);
}

/**
 * Handle a state machine command by dispatching to physics and renderer.
 *
 * @param {object} cmd - command from StateMachine
 * @param {number} screenX
 * @param {number} screenY
 * @param {object} deps - { physics, renderer, stateMachine, inputManager, updateStatus, updateSceneStatus, focusMoleculeForAtom }
 */
/** Result from interaction dispatch — includes resolved world drag target if applicable. */
export interface InteractionResult {
  /** Resolved world-space drag target from the last updateDrag, or null if not a drag update. */
  dragTarget: [number, number, number] | null;
}

export function handleCommand(cmd: Command, screenX: number | undefined, screenY: number | undefined, deps: {
  physics: PhysicsEngine;
  renderer: Renderer;
  stateMachine: StateMachine;
  inputManager: InputManager;
  updateStatus: (text: string) => void;
  updateSceneStatus: () => void;
  /** Focus-aware pivot: update orbit pivot to the molecule containing the given atom. */
  focusMoleculeForAtom: (atomIdx: number) => void;
}): InteractionResult {
  let dragTarget: [number, number, number] | null = null;
  const { physics, renderer, stateMachine, inputManager, updateStatus, updateSceneStatus, focusMoleculeForAtom } = deps;

  switch (cmd.action) {
    case 'highlight':
      renderer.setHighlight(cmd.atom);
      break;

    case 'clearHighlight':
      renderer.setHighlight(-1);
      break;

    case 'startDrag': {
      const ai = cmd.atom;
      physics.startDrag(ai);
      renderer.setHighlight(ai);
      if (screenX !== undefined) {
        const target = screenToPhysics(renderer, inputManager, ai, screenX, screenY);
        renderer.showForceLine(ai, target[0], target[1], target[2]);
      }
      focusMoleculeForAtom(ai);
      break;
    }

    case 'updateDrag': {
      if (stateMachine.getSelectedAtom() < 0) break;
      const atomIdx = stateMachine.getSelectedAtom();
      const target = screenToPhysics(renderer, inputManager, atomIdx, cmd.screenX, cmd.screenY);
      physics.updateDrag(target[0], target[1], target[2]);
      renderer.showForceLine(atomIdx, target[0], target[1], target[2]);
      dragTarget = [target[0], target[1], target[2]];
      break;
    }

    case 'endDrag':
      physics.endDrag();
      renderer.clearFeedback();
      break;

    case 'flick': {
      physics.endDrag();
      const scale = 0.002;
      physics.applyImpulse(cmd.atom, cmd.vx * scale, -cmd.vy * scale);
      renderer.clearFeedback();
      break;
    }

    case 'startMove': {
      const ai = cmd.atom;
      physics.startTranslate(ai);
      renderer.setHighlight(ai);
      updateStatus('Moving molecule');
      if (screenX !== undefined) {
        const target = screenToPhysics(renderer, inputManager, ai, screenX, screenY);
        renderer.showForceLine(ai, target[0], target[1], target[2]);
      }
      focusMoleculeForAtom(ai);
      break;
    }

    case 'updateMove': {
      if (stateMachine.getSelectedAtom() < 0) break;
      const atomIdx = stateMachine.getSelectedAtom();
      const target = screenToPhysics(renderer, inputManager, atomIdx, cmd.screenX, cmd.screenY);
      physics.updateDrag(target[0], target[1], target[2]);
      renderer.showForceLine(atomIdx, target[0], target[1], target[2]);
      dragTarget = [target[0], target[1], target[2]];
      break;
    }

    case 'endMove':
      physics.endDrag();
      renderer.clearFeedback();
      updateSceneStatus();
      break;

    case 'startRotate': {
      const ai = cmd.atom;
      physics.startRotateDrag(ai);
      renderer.setHighlight(ai);
      updateStatus('Rotating molecule');
      if (screenX !== undefined) {
        const target = screenToPhysics(renderer, inputManager, ai, screenX, screenY);
        renderer.showForceLine(ai, target[0], target[1], target[2]);
      }
      focusMoleculeForAtom(ai);
      break;
    }

    case 'updateRotate': {
      if (stateMachine.getSelectedAtom() < 0) break;
      const atomIdx = stateMachine.getSelectedAtom();
      const target = screenToPhysics(renderer, inputManager, atomIdx, cmd.screenX, cmd.screenY);
      physics.updateDrag(target[0], target[1], target[2]);
      renderer.showForceLine(atomIdx, target[0], target[1], target[2]);
      dragTarget = [target[0], target[1], target[2]];
      break;
    }

    case 'endRotate':
      physics.endDrag();
      renderer.clearFeedback();
      updateSceneStatus();
      break;

    case 'cancelInteraction':
      physics.endDrag();
      renderer.clearFeedback();
      break;

    case 'forceIdle':
      physics.endDrag();
      renderer.clearFeedback();
      break;

    default:
      break;
  }
  return { dragTarget };
}
