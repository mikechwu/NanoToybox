/** Debug hooks attached to window by main.js */
interface Window {
  _setUiEffectsMode?: (mode: 'reduced' | 'normal' | 'auto') => void
}
