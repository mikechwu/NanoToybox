/**
 * Fail-fast DOM ref validation. Throws if element is null/undefined.
 * @param {string} name - descriptive name for error message
 * @param {HTMLElement|null} el - DOM element
 * @returns {HTMLElement} the element (guaranteed non-null)
 */
export function requireEl(name, el) {
  if (!el) throw new Error(`[requireEl] Missing required DOM element: ${name}`);
  return el;
}
