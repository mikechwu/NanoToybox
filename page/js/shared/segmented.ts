/**
 * Programmatically select a segmented control value by predicate.
 * Updates the active class and --seg-active indicator position.
 * @param {HTMLElement} segEl - .segmented container
 * @param {function} predicate - receives a label, returns true for the match
 */
export function setSegmentedValue(segEl, predicate) {
  const labels = [...segEl.querySelectorAll('label')];
  labels.forEach((label, i) => {
    const match = predicate(label);
    label.classList.toggle('active', match);
    if (match) segEl.style.setProperty('--seg-active', String(i));
  });
}

/**
 * Programmatically select a segmented control by data attribute value.
 * Thin wrapper over setSegmentedValue for the common data-* pattern.
 * @param {HTMLElement} segEl - .segmented container
 * @param {string} attr - dataset key (e.g., 'textSize' for data-text-size)
 * @param {string} value - the value to match
 */
export function setSegmentedByData(segEl, attr, value) {
  setSegmentedValue(segEl, label => label.dataset[attr] === value);
}

/**
 * Shared segmented control wiring utility.
 * Used by dock (mode), settings-sheet (speed, theme, boundary, text-size).
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
      segEl.style.setProperty('--seg-active', String(i));
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
