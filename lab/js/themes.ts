/**
 * Theme definitions — Dark and Light.
 * Camera-mounted lighting rig. Material params (roughness, metalness) in CONFIG.
 * Rig geometry (offsets, angles) in CONFIG.cameraLighting — themes own colors/intensities only.
 * ui* keys are the single source of truth for DOM CSS custom properties.
 */

// Visual direction:
//   Atoms: darker, softer — solid structural masses (higher roughness in CONFIG.atomMaterial)
//   Bonds: brighter, smoother — clean structural guides (lower roughness in CONFIG.bondMaterial)
//   Bond albedo should remain distinctly brighter than atom albedo in both themes.
export const THEMES = {
  'dark': {
    // Three.js renderer
    bg: 0x181820,
    atom: 0x444444,
    bond: 0xb0a8a0,      // warm muted gray — readable without glare, closer to light mode tone
    bondRoughness: 0.22,  // tighter specular for more 3D depth against dark background
    bondMetalness: 0.08,  // slight metallic sheen for cylindrical definition
    ambientColor: 0x8090b0, ambientIntensity: 0.7,
    headLightColor: 0xffffff, headLightIntensity: 3.5,
    fillLightColor: 0x8098c0, fillLightIntensity: 0.8,
    // DOM UI tokens (written to CSS custom properties by applyThemeTokens)
    uiBg: 'rgba(20,20,28,0.92)',
    uiPageBg: '#181820',
    uiPanelBg: 'rgba(20,20,28,0.92)',
    uiText: '#ccc',
    uiMuted: '#888',
    uiBorder: 'rgba(255,255,255,0.12)',
    uiBtn: 'rgba(255,255,255,0.08)',
    uiSurface: 'rgba(20,20,28,0.85)',
    uiSurfaceHover: 'rgba(255,255,255,0.08)',
    uiSurfaceActive: 'rgba(255,255,255,0.12)',
    uiAccent: '#6ab89a',
    uiAccentText: '#8fd8b0',
    uiAccentSoft: 'rgba(100,180,140,0.2)',
    uiDanger: '#e05050',
    uiFpsText: '#aab0c0',
    uiHintBg: 'rgba(100,180,140,0.15)',
    // Trim-dialog status pill colors (dark mode): brighter so 11 px
    // bold text meets WCAG AA 4.5:1 against the translucent pill fill.
    uiTrimOk: '#7cd4a6',
    uiTrimWarn: '#e3b36a',
    uiTrimOver: '#ef8a7a',
  },
  'light': {
    // Three.js renderer
    bg: 0xf2f2f0,
    atom: 0x3a3a3a,
    bond: 0xc8c0b8,      // warm off-white — readable against light background
    bondRoughness: 0.35,  // matches CONFIG.bondMaterial default
    bondMetalness: 0.0,
    ambientColor: 0xc0d0e8, ambientIntensity: 0.9,
    headLightColor: 0xfff8f0, headLightIntensity: 3.2,
    fillLightColor: 0xa0b8d0, fillLightIntensity: 0.7,
    // DOM UI tokens
    uiBg: 'rgba(240,240,238,0.92)',
    uiPageBg: '#f2f2f0',
    uiPanelBg: 'rgba(240,240,238,0.92)',
    uiText: '#444',
    uiMuted: '#777',
    uiBorder: 'rgba(0,0,0,0.1)',
    uiBtn: 'rgba(0,0,0,0.06)',
    uiSurface: 'rgba(255,255,255,0.72)',
    uiSurfaceHover: 'rgba(0,0,0,0.04)',
    uiSurfaceActive: 'rgba(0,0,0,0.08)',
    uiAccent: '#4a9a7a',
    uiAccentText: '#2a7a5a',
    uiAccentSoft: 'rgba(60,140,100,0.15)',
    uiDanger: '#d04040',
    uiFpsText: '#666',
    uiHintBg: 'rgba(60,140,100,0.12)',
    // Trim-dialog status pill colors (light mode): deeper saturation
    // so text stays legible on the light translucent pill fill.
    uiTrimOk: '#1f7a53',
    uiTrimWarn: '#a3670f',
    uiTrimOver: '#b34a3b',
  },
};

/**
 * Write CSS custom properties from a theme definition.
 * This is the single function that bridges THEMES → DOM styling.
 * All UI elements reference var(--color-*) in CSS.
 */
export function applyThemeTokens(name) {
  const t = THEMES[name];
  const s = document.documentElement.style;
  s.setProperty('--page-bg', t.uiPageBg);
  s.setProperty('--panel-bg', t.uiPanelBg);
  s.setProperty('--color-text', t.uiText);
  s.setProperty('--color-text-secondary', t.uiMuted);
  s.setProperty('--color-border', t.uiBorder);
  s.setProperty('--color-btn', t.uiBtn);
  s.setProperty('--color-surface', t.uiSurface);
  s.setProperty('--color-surface-hover', t.uiSurfaceHover);
  s.setProperty('--color-surface-active', t.uiSurfaceActive);
  s.setProperty('--color-accent', t.uiAccent);
  s.setProperty('--color-accent-text', t.uiAccentText);
  s.setProperty('--color-accent-soft', t.uiAccentSoft);
  s.setProperty('--color-danger', t.uiDanger);
  s.setProperty('--color-fps-text', t.uiFpsText);
  s.setProperty('--color-hint-bg', t.uiHintBg);
  s.setProperty('--color-trim-ok', t.uiTrimOk);
  s.setProperty('--color-trim-warn', t.uiTrimWarn);
  s.setProperty('--color-trim-over', t.uiTrimOver);
  // --atom-base-color mirrors THEMES[name].atom — the same source the renderer uses
  // for InstancedMesh default color (renderer.ts _createAtomMaterial, _applyAtomColorOverrides).
  s.setProperty('--atom-base-color', '#' + t.atom.toString(16).padStart(6, '0'));
}

/**
 * Apply text-size mode. CSS owns the token values via [data-text-size] selector
 * in index.html — JS only sets the attribute. Session-only — resets on reload.
 */
export function applyTextSizeTokens(size) {
  document.documentElement.dataset.textSize = size || 'normal';
}
