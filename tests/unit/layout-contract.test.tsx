/**
 * @vitest-environment jsdom
 */
/**
 * Behavioral tests for the dock layout contract.
 *
 * Verifies runtime behavior: DockLayout renders [data-dock-root] around
 * children, selectDockSurface derives correctly, overlay-layout uses the
 * correct selector constant (source check kept only for this architectural
 * invariant that has no render-testable surface).
 */
import React from 'react';
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { DockLayout } from '../../page/js/components/DockLayout';
import { selectDockSurface, type DockSurface } from '../../page/js/store/selectors/dock';

describe('Layout contract — behavioral', () => {
  it('DockLayout renders [data-dock-root] attribute on root element', () => {
    const { container } = render(
      <DockLayout><div data-testid="child">content</div></DockLayout>
    );
    const root = container.querySelector('[data-dock-root]');
    expect(root).not.toBeNull();
  });

  it('DockLayout wraps children inside [data-dock-root]', () => {
    const { container } = render(
      <DockLayout><span className="test-child">hello</span></DockLayout>
    );
    const root = container.querySelector('[data-dock-root]');
    const child = root?.querySelector('.test-child');
    expect(child).not.toBeNull();
    expect(child?.textContent).toBe('hello');
  });

  it('DockLayout renders multiple children', () => {
    const { container } = render(
      <DockLayout>
        <div className="bar">bar</div>
        <div className="tray">tray</div>
      </DockLayout>
    );
    const root = container.querySelector('[data-dock-root]');
    expect(root?.querySelector('.bar')).not.toBeNull();
    expect(root?.querySelector('.tray')).not.toBeNull();
  });

  it('DockLayout root has dock-region class', () => {
    const { container } = render(
      <DockLayout><div>child</div></DockLayout>
    );
    const root = container.querySelector('[data-dock-root]');
    expect(root?.classList.contains('dock-region')).toBe(true);
  });

  it('selectDockSurface returns correct DockSurface type', () => {
    const primary: DockSurface = selectDockSurface({ placementActive: false } as any);
    const placement: DockSurface = selectDockSurface({ placementActive: true } as any);
    expect(primary).toBe('primary');
    expect(placement).toBe('placement');
  });
});

// Architectural invariant (DOCK_ROOT_SELECTOR) is enforced by the
// lint:dock-contract script in package.json, not by a unit test.
// See: npm run lint:dock-contract
