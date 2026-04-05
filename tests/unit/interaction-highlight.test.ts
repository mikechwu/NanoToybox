/**
 * Tests for interaction highlight resolver.
 *
 * Verifies mode-aware highlight: Atom → single atom, Move/Rotate → bonded group.
 */
import { describe, it, expect } from 'vitest';
import { resolveInteractionHighlight, type InteractionFeedbackState, type InteractionHighlightPhysicsSurface } from '../../lab/js/runtime/interaction-highlight-runtime';

function mockPhysics(n = 60, componentAtoms = [0, 1, 2, 3, 4]): InteractionHighlightPhysicsSurface {
  const componentId = new Int32Array(n);
  componentAtoms.forEach(i => { componentId[i] = 0; });
  for (let i = componentAtoms.length; i < n; i++) componentId[i] = 1;
  return {
    n,
    componentId,
    components: [
      { atoms: componentAtoms, size: componentAtoms.length },
      { atoms: Array.from({ length: n - componentAtoms.length }, (_, i) => i + componentAtoms.length), size: n - componentAtoms.length },
    ],
  };
}

const noInteraction: InteractionFeedbackState = { hoverAtom: -1, activeAtom: -1, isDragging: false, isMoving: false, isRotating: false };

describe('resolveInteractionHighlight', () => {
  // ── No interaction ──

  it('returns null when no hover or active atom', () => {
    expect(resolveInteractionHighlight(noInteraction, 'atom', mockPhysics())).toBeNull();
  });

  // ── Atom mode ──

  it('Atom mode + hover → single atom highlight', () => {
    const feedback = { ...noInteraction, hoverAtom: 5 };
    const result = resolveInteractionHighlight(feedback, 'atom', mockPhysics());
    expect(result).not.toBeNull();
    expect(result!.atomIndex).toBe(5);
    expect(result!.groupAtomIndices).toBeNull();
    expect(result!.intensity).toBe('hover');
  });

  it('Atom mode + active drag → single atom highlight', () => {
    const feedback = { ...noInteraction, activeAtom: 3, isDragging: true };
    const result = resolveInteractionHighlight(feedback, 'atom', mockPhysics());
    expect(result!.atomIndex).toBe(3);
    expect(result!.groupAtomIndices).toBeNull();
    expect(result!.intensity).toBe('active');
  });

  // ── Move mode ──

  it('Move mode + hover → group highlight', () => {
    const feedback = { ...noInteraction, hoverAtom: 2 };
    const result = resolveInteractionHighlight(feedback, 'move', mockPhysics());
    expect(result!.atomIndex).toBe(2);
    expect(result!.groupAtomIndices).toEqual([0, 1, 2, 3, 4]);
    expect(result!.intensity).toBe('hover');
  });

  it('Move mode + active → group highlight with active intensity', () => {
    const feedback = { ...noInteraction, activeAtom: 2, isMoving: true };
    const result = resolveInteractionHighlight(feedback, 'move', mockPhysics());
    expect(result!.groupAtomIndices).toEqual([0, 1, 2, 3, 4]);
    expect(result!.intensity).toBe('active');
  });

  // ── Rotate mode ──

  it('Rotate mode + hover → group highlight', () => {
    const feedback = { ...noInteraction, hoverAtom: 1 };
    const result = resolveInteractionHighlight(feedback, 'rotate', mockPhysics());
    expect(result!.groupAtomIndices).toEqual([0, 1, 2, 3, 4]);
    expect(result!.intensity).toBe('hover');
  });

  it('Rotate mode + active → group highlight', () => {
    const feedback = { ...noInteraction, activeAtom: 1, isRotating: true };
    const result = resolveInteractionHighlight(feedback, 'rotate', mockPhysics());
    expect(result!.groupAtomIndices).toEqual([0, 1, 2, 3, 4]);
    expect(result!.intensity).toBe('active');
  });

  // ── Active interaction overrides session mode ──

  it('active DRAG always produces atom-only even if session is Move', () => {
    const feedback = { ...noInteraction, activeAtom: 3, isDragging: true };
    const result = resolveInteractionHighlight(feedback, 'move', mockPhysics());
    expect(result!.groupAtomIndices).toBeNull(); // atom-only from drag
  });

  // ── Invalid topology fails safe ──

  it('Move mode with null componentId → no highlight (not atom-only)', () => {
    const physics = { n: 60, componentId: null, components: [] };
    const feedback = { ...noInteraction, hoverAtom: 5 };
    const result = resolveInteractionHighlight(feedback, 'move', physics);
    expect(result).toBeNull();
  });

  it('Move mode with atom out of range → no highlight', () => {
    const feedback = { ...noInteraction, hoverAtom: 100 }; // beyond physics.n
    const result = resolveInteractionHighlight(feedback, 'move', mockPhysics(60));
    expect(result).toBeNull();
  });

  // ── Hover preview reflects session mode ──

  it('Rotate mode with missing topology → no highlight', () => {
    const physics = { n: 60, componentId: null, components: [] };
    const feedback = { ...noInteraction, hoverAtom: 5 };
    expect(resolveInteractionHighlight(feedback, 'rotate', physics)).toBeNull();
  });

  it('switching session mode while hovering changes highlight type', () => {
    const feedback = { ...noInteraction, hoverAtom: 2 };
    const physics = mockPhysics();

    const atomResult = resolveInteractionHighlight(feedback, 'atom', physics);
    expect(atomResult!.groupAtomIndices).toBeNull();

    const moveResult = resolveInteractionHighlight(feedback, 'move', physics);
    expect(moveResult!.groupAtomIndices).not.toBeNull();

    const rotateResult = resolveInteractionHighlight(feedback, 'rotate', physics);
    expect(rotateResult!.groupAtomIndices).not.toBeNull();
  });
});

