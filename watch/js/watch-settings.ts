/**
 * Watch settings domain — persistent appearance preferences.
 *
 * Owns: theme, text-size. Session-only (no localStorage in Round 5).
 * Survives file replacement (appearance, not transport).
 * Does NOT own: speed, repeat (transport — owned by playback model).
 */

import { applyThemeTokens, applyTextSizeTokens } from '../../lab/js/themes';

export interface WatchSettings {
  getTheme(): 'dark' | 'light';
  setTheme(theme: 'dark' | 'light'): void;
  getTextSize(): 'normal' | 'large';
  setTextSize(size: 'normal' | 'large'): void;
}

export function createWatchSettings(initialTheme: 'dark' | 'light'): WatchSettings {
  let _theme: 'dark' | 'light' = initialTheme;
  let _textSize: 'normal' | 'large' = 'normal';

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
  };
}
