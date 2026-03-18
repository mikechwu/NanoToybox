/**
 * Theme definitions — Dark and Light.
 * Camera-relative lighting with MeshStandardMaterial (roughness=0.7, metalness=0).
 */

export const THEMES = {
  'dark': {
    bg: 0x181820,
    atom: 0x444444,
    bond: 0x909090,
    ambientColor: 0x8090b0, ambientIntensity: 1.2,
    keyColor: 0xffffff, keyIntensity: 3.0,
    fillColor: 0x8098c0, fillIntensity: 1.5,
    rimColor: 0x6070a0, rimIntensity: 0.8,
    uiBg: 'rgba(20,20,28,0.92)',
    uiText: '#ccc',
    uiMuted: '#888',
    uiBorder: 'rgba(255,255,255,0.12)',
    uiBtn: 'rgba(255,255,255,0.08)',
  },
  'light': {
    bg: 0xf2f2f0,
    atom: 0x3a3a3a,
    bond: 0x808080,
    ambientColor: 0xc0d0e8, ambientIntensity: 1.5,
    keyColor: 0xfff8f0, keyIntensity: 2.8,
    fillColor: 0xa0b8d0, fillIntensity: 1.2,
    rimColor: 0x909098, rimIntensity: 0.6,
    uiBg: 'rgba(240,240,238,0.92)',
    uiText: '#444',
    uiMuted: '#777',
    uiBorder: 'rgba(0,0,0,0.1)',
    uiBtn: 'rgba(0,0,0,0.06)',
  },
};
