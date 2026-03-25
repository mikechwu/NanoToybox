/**
 * Interaction command dispatch — owns local interaction effects + worker mirroring.
 *
 * Single authority for interaction command side effects:
 * - Local dispatch via interaction.ts (physics, renderer, state machine)
 * - Worker mirror commands (startDrag, updateDrag, endDrag, flick)
 * - Flick ordering guarantee (endDrag before applyImpulse)
 *
 * Does NOT own InputManager construction — that is input-bindings.ts.
 * Does NOT attach global listeners or write to window.
 */

import { handleCommand as dispatchInteraction } from '../interaction';
import type { Command } from '../state-machine';
import type { PhysicsEngine } from '../physics';
import type { Renderer } from '../renderer';
import type { StateMachine } from '../state-machine';
import type { InputManager } from '../input';
import type { WorkerInteractionCommand } from '../worker-bridge';

export interface InteractionDispatchDeps {
  getPhysics: () => PhysicsEngine;
  getRenderer: () => Renderer;
  getStateMachine: () => StateMachine;
  getInputManager: () => InputManager | null;
  getStatusCtrl: () => { fadeHint: () => void } | null;
  isWorkerActive: () => boolean;
  sendWorkerInteraction: (cmd: WorkerInteractionCommand) => void;
  updateStatus: (text: string) => void;
  updateSceneStatus: () => void;
}

export function createInteractionDispatch(deps: InteractionDispatchDeps) {
  return function dispatch(cmd: Command, screenX?: number, screenY?: number): { dragTarget?: number[] } {
    const im = deps.getInputManager();
    if (!im) throw new Error('[interaction-dispatch] InputManager is null — dispatch called before init or after teardown');
    const result = dispatchInteraction(cmd, screenX, screenY, {
      physics: deps.getPhysics(),
      renderer: deps.getRenderer(),
      stateMachine: deps.getStateMachine(),
      inputManager: im,
      fadeHint: () => { const sc = deps.getStatusCtrl(); if (sc) sc.fadeHint(); },
      updateStatus: deps.updateStatus,
      updateSceneStatus: deps.updateSceneStatus,
    });

    // Forward interaction commands to worker to keep worker scene in sync
    if (deps.isWorkerActive()) {
      switch (cmd.action) {
        case 'startDrag':
        case 'startMove':
        case 'startRotate':
          deps.sendWorkerInteraction({
            type: 'startDrag',
            atomIndex: cmd.atom,
            mode: cmd.action === 'startDrag' ? 'atom' : cmd.action === 'startMove' ? 'move' : 'rotate',
          });
          break;
        case 'updateDrag':
        case 'updateMove':
        case 'updateRotate': {
          const dt = result.dragTarget;
          if (dt) {
            deps.sendWorkerInteraction({ type: 'updateDrag', worldX: dt[0], worldY: dt[1], worldZ: dt[2] });
          }
          break;
        }
        case 'endDrag':
        case 'endMove':
        case 'endRotate':
          deps.sendWorkerInteraction({ type: 'endDrag' });
          break;
        case 'flick':
          // Flick ordering guarantee: worker protocol's 'flick' command atomically
          // calls endDrag() then applyImpulse() in the worker (simulation-worker.ts
          // handleFlick). This prevents the ghost-force bug where dragAtom stays set.
          deps.sendWorkerInteraction({ type: 'flick', atomIndex: cmd.atom, vx: cmd.vx, vy: cmd.vy });
          break;
      }
    }

    return result;
  };
}
