/**
 * Shared segmented control wiring utility.
 * Used by dock (mode), settings-sheet (speed, theme, boundary).
 *
 * @param {HTMLElement} segEl - .segmented container with <label> children
 * @param {function} callback - called with the clicked label element
 * @returns {function} disposer — call to remove all attached listeners
 */
export function wireSegmented(segEl, callback) {
  const labels = segEl.querySelectorAll('label');
  const handlers = [];
  labels.forEach((label, i) => {
    const handler = () => {
      labels.forEach(l => l.classList.remove('active'));
      label.classList.add('active');
      segEl.style.setProperty('--seg-active', i);
      callback(label);
    };
    label.addEventListener('click', handler);
    handlers.push([label, handler]);
  });
  // Return disposer
  return () => {
    for (const [el, h] of handlers) {
      el.removeEventListener('click', h);
    }
    handlers.length = 0;
  };
}
