/**
 * Inline SVG icons — shared across DockBar and CameraControls.
 *
 * All icons use a 20x20 viewBox, currentColor stroke, designed for
 * small UI surfaces (28-36px buttons). Stroke-based for clarity
 * at small sizes.
 *
 * Each icon accepts optional className and size for responsive scaling.
 * aria-hidden and focusable are set by default for accessibility.
 */

import React from 'react';

interface IconProps {
  className?: string;
  size?: number;
  strokeWidth?: number;
  title?: string;
}

function iconBase(size: number, strokeWidth: number, title?: string) {
  return {
    width: size,
    height: size,
    viewBox: '0 0 20 20',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': !title as boolean,
    focusable: false as const,
    role: title ? 'img' as const : undefined,
  };
}

export function IconAdd({ className, size = 16, strokeWidth, title }: IconProps = {}) {
  return <svg {...iconBase(size, strokeWidth ?? 1.8, title)} className={className}><line x1="10" y1="4" x2="10" y2="16"/><line x1="4" y1="10" x2="16" y2="10"/></svg>;
}

export function IconCheck({ className, size = 16, strokeWidth, title }: IconProps = {}) {
  return <svg {...iconBase(size, strokeWidth ?? 1.8, title)} className={className}><polyline points="4,10 8,14 16,6"/></svg>;
}

export function IconCancel({ className, size = 16, strokeWidth, title }: IconProps = {}) {
  return <svg {...iconBase(size, strokeWidth ?? 1.8, title)} className={className}><line x1="5" y1="5" x2="15" y2="15"/><line x1="15" y1="5" x2="5" y2="15"/></svg>;
}

export function IconCenter({ className, size = 16, strokeWidth, title }: IconProps = {}) {
  return <svg {...iconBase(size, strokeWidth ?? 1.8, title)} className={className}><circle cx="10" cy="10" r="3"/><line x1="10" y1="2" x2="10" y2="6"/><line x1="10" y1="14" x2="10" y2="18"/><line x1="2" y1="10" x2="6" y2="10"/><line x1="14" y1="10" x2="18" y2="10"/></svg>;
}

export function IconFollow({ className, size = 16, strokeWidth, title }: IconProps = {}) {
  return <svg {...iconBase(size, strokeWidth ?? 1.8, title)} className={className}><circle cx="10" cy="10" r="3"/><circle cx="10" cy="10" r="7"/></svg>;
}

export function IconPause({ className, size = 16, strokeWidth, title }: IconProps = {}) {
  return <svg {...iconBase(size, strokeWidth ?? 1.8, title)} className={className}><line x1="7" y1="5" x2="7" y2="15"/><line x1="13" y1="5" x2="13" y2="15"/></svg>;
}

export function IconResume({ className, size = 16, strokeWidth, title }: IconProps = {}) {
  return <svg {...iconBase(size, strokeWidth ?? 1.8, title)} className={className} fill="currentColor" stroke="none"><polygon points="6,4 16,10 6,16"/></svg>;
}

export function IconSettings({ className, size = 16, strokeWidth, title }: IconProps = {}) {
  return <svg {...iconBase(size, strokeWidth ?? 1.8, title)} className={className}><circle cx="10" cy="10" r="3"/><path d="M10 2v2M10 16v2M2 10h2M16 10h2M4.2 4.2l1.4 1.4M14.4 14.4l1.4 1.4M4.2 15.8l1.4-1.4M14.4 5.6l1.4-1.4"/></svg>;
}

export function IconReturn({ className, size = 16, strokeWidth, title }: IconProps = {}) {
  return <svg {...iconBase(size, strokeWidth ?? 1.8, title)} className={className}><polyline points="4,8 10,4 10,12"/><path d="M10 8 Q16 8 16 14"/></svg>;
}

export function IconFreeze({ className, size = 16, strokeWidth, title }: IconProps = {}) {
  return <svg {...iconBase(size, strokeWidth ?? 1.8, title)} className={className}><line x1="5" y1="5" x2="15" y2="15"/><line x1="15" y1="5" x2="5" y2="15"/></svg>;
}
