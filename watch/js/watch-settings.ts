/**
 * Watch settings domain — viewer preferences (appearance + interpolation).
 *
 * Owns: theme, text-size, smoothPlayback, interpolationMode. Session-only
 * (no localStorage in Round 5/6).
 * Survives file replacement (viewer preferences, not transport).
 * Does NOT own: speed, repeat, playDirection (transport — owned by playback model).
 */

import { applyThemeTokens, applyTextSizeTokens } from '../../lab/js/themes';

/** Frozen tuple of productized interpolation mode IDs. Single source of truth —
 *  the type, the guard, and all entry points derive from this one array.
 *  Structurally immutable (as const + Object.freeze). */
export const PRODUCT_INTERPOLATION_MODE_IDS = Object.freeze(
  ['linear', 'hermite', 'catmull-rom'] as const,
);

/** Productized interpolation modes exposed in the settings UI. Derived from
 *  the canonical tuple above so the type and the runtime array never drift. */
export type WatchInterpolationMode = (typeof PRODUCT_INTERPOLATION_MODE_IDS)[number];

/** Type guard: returns true if `value` is one of the productized modes.
 *  Narrows `string` to `WatchInterpolationMode` at the call site. */
export function isWatchInterpolationMode(value: string): value is WatchInterpolationMode {
  return (PRODUCT_INTERPOLATION_MODE_IDS as readonly string[]).includes(value);
}

export interface WatchSettings {
  getTheme(): 'dark' | 'light';
  setTheme(theme: 'dark' | 'light'): void;
  getTextSize(): 'normal' | 'large';
  setTextSize(size: 'normal' | 'large'): void;
  // ── Round 6: interpolation preferences ──
  getSmoothPlayback(): boolean;
  setSmoothPlayback(enabled: boolean): void;
  getInterpolationMode(): WatchInterpolationMode;
  setInterpolationMode(mode: WatchInterpolationMode): void;
}

export function createWatchSettings(initialTheme: 'dark' | 'light'): WatchSettings {
  let _theme: 'dark' | 'light' = initialTheme;
  let _textSize: 'normal' | 'large' = 'normal';
  let _smoothPlayback = true;
  let _interpolationMode: WatchInterpolationMode = 'linear';

  return {
    getTheme: () => _theme,
    setTheme(theme) {
      _theme = theme;
      applyThemeTokens(theme);
    },
    getTextSize: () => _textSize,
    setTextSize(size) {
      _textSize = size;
      applyTextSizeTokens(size);
    },
    getSmoothPlayback: () => _smoothPlayback,
    setSmoothPlayback(enabled) {
      _smoothPlayback = enabled;
    },
    getInterpolationMode: () => _interpolationMode,
    setInterpolationMode(mode) {
      _interpolationMode = mode;
    },
  };
}
