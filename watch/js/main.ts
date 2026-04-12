/**
 * Watch app bootstrap — thin composition root.
 *
 * Owns:        theme init, controller creation, React mount.
 * Does NOT own: DOM manipulation, playback logic, renderer lifecycle.
 */

import { applyThemeTokens, applyTextSizeTokens } from '../../lab/js/themes';
import { VIEWER_DEFAULTS } from '../../src/config/viewer-defaults';
import { createWatchController } from './watch-controller';
import { isWatchInterpolationMode } from './watch-settings';
import { mountWatchUI } from './react-root';

// CSS imports (core tokens first, then component CSS)
import '../../src/ui/core-tokens.css';
import '../css/watch.css';
import '../../src/ui/review-parity.css';
import '../../src/ui/bonded-groups-parity.css';
import '../../src/ui/text-size-tokens.css';
import '../../src/ui/dock-tokens.css';
import '../../src/ui/dock-shell.css';
import '../../src/ui/sheet-shell.css';
import '../../src/ui/segmented.css';
import '../../src/ui/timeline-track.css';
import '../../src/ui/bottom-region.css';
import '../css/watch-dock.css';

// Theme + text-size
applyThemeTokens(VIEWER_DEFAULTS.defaultTheme);
applyTextSizeTokens('normal');

// Controller (owns runtime + playback clock)
const controller = createWatchController();

// Mount React UI
mountWatchUI(controller);

// Test hooks — only wired when the page is loaded with ?e2e=1 (same
// convention as /lab/). Exposes a narrow surface for Playwright.
const qp = new URLSearchParams(window.location.search);
if (qp.get('e2e') === '1') {
  const w = window as unknown as Record<string, unknown>;
  w._getWatchState = () => {
    const snap = controller.getSnapshot();
    return {
      loaded: snap.loaded,
      atomCount: snap.atomCount,
      frameCount: snap.frameCount,
      fileKind: snap.fileKind,
      fileName: snap.fileName,
      error: snap.error,
      smoothPlayback: snap.smoothPlayback,
      interpolationMode: snap.interpolationMode,
      activeInterpolationMethod: snap.activeInterpolationMethod,
      lastFallbackReason: snap.lastFallbackReason,
      importDiagnosticCodes: snap.importDiagnostics.map(d => d.code),
    };
  };
  w._watchOpenFile = async (text: string, name: string) => {
    const file = new File([text], name, { type: 'application/json' });
    await controller.openFile(file);
  };
  w._watchToggleSmooth = () => {
    controller.setSmoothPlayback(!controller.getSnapshot().smoothPlayback);
  };
  w._watchSetInterpolationMode = (mode: string) => {
    if (!isWatchInterpolationMode(mode)) {
      console.warn(`[watch e2e] invalid mode "${mode}" — not a productized interpolation mode`);
      return;
    }
    controller.setInterpolationMode(mode);
  };
  w._watchScrub = (timePs: number) => {
    if (!Number.isFinite(timePs)) {
      console.warn(`[watch e2e] invalid scrub time: ${timePs}`);
      return;
    }
    controller.scrub(timePs);
  };
}

// Global error handler for unhandled rejections
window.addEventListener('unhandledrejection', (e) => {
  console.error('[watch] unhandled rejection:', e.reason);
});
