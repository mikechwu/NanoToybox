/**
 * Watch app bootstrap — thin composition root.
 *
 * Owns:        theme init, controller creation, React mount.
 * Does NOT own: DOM manipulation, playback logic, renderer lifecycle.
 */

import { applyThemeTokens } from '../../lab/js/themes';
import { DEFAULT_THEME } from '../../lab/js/config';
import { createWatchController } from './watch-controller';
import { mountWatchUI } from './react-root';

// CSS imports
import '../css/watch.css';
import '../../src/ui/review-parity.css';

// Theme
applyThemeTokens(DEFAULT_THEME);

// Controller (owns runtime + playback clock)
const controller = createWatchController();

// Mount React UI
mountWatchUI(controller);

// Global error handler for unhandled rejections
window.addEventListener('unhandledrejection', (e) => {
  console.error('[watch] unhandled rejection:', e.reason);
});
