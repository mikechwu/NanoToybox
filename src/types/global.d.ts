/** Debug hooks attached to window by main.js */
interface Window {
  _setUiEffectsMode?: (mode: 'reduced' | 'normal' | 'auto') => void
  _getForceSafetyDebugState?: () => {
    transitionalClampHitCount: number
    transitionalKeCapHitCount: number
    keBaseline: number
    transitional: {
      keCapMultiplier: number
      keCapFloorPerAtom: number
      clampThreshold: number
    }
  }
  _resetForceSafetyDebugState?: () => void
}
