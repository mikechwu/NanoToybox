/**
 * Watch app bootstrap — thin composition root.
 *
 * Owns:        theme init, controller creation, React mount.
 * Does NOT own: DOM manipulation, playback logic, renderer lifecycle.
 */

import { applyThemeTokens, applyTextSizeTokens } from '../../lab/js/themes';
import { VIEWER_DEFAULTS } from '../../src/config/viewer-defaults';
import { createWatchController } from './watch-controller';
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

// Global error handler for unhandled rejections
window.addEventListener('unhandledrejection', (e) => {
  console.error('[watch] unhandled rejection:', e.reason);
});
