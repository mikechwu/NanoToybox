/**
 * Watch app bootstrap — thin composition root.
 *
 * Owns:        theme init, controller creation, React mount.
 * Does NOT own: DOM manipulation, playback logic, renderer lifecycle.
 */

import { applyThemeTokens } from '../../lab/js/themes';
import { VIEWER_DEFAULTS } from '../../src/config/viewer-defaults';
import { createWatchController } from './watch-controller';
import { mountWatchUI } from './react-root';

// CSS imports
import '../css/watch.css';
import '../../src/ui/review-parity.css';
import '../../src/ui/bonded-groups-parity.css';

// Theme
applyThemeTokens(VIEWER_DEFAULTS.defaultTheme);

// Controller (owns runtime + playback clock)
const controller = createWatchController();

// Mount React UI
mountWatchUI(controller);

// Global error handler for unhandled rejections
window.addEventListener('unhandledrejection', (e) => {
  console.error('[watch] unhandled rejection:', e.reason);
});
