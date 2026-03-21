/**
 * Wasm Tersoff kernel bridge — loader, buffer management, CSR marshaling.
 *
 * Non-blocking and opportunistic: app starts in JS, switches to Wasm
 * after successful init. Falls back to JS on any failure.
 */

let wasmModule = null;
let wasmTersoff = null;
let _initPromise = null; // singleton guard — only one load attempt

// Wasm-side buffer pointers
let wasmPos = 0, wasmForce = 0, wasmNlOffsets = 0, wasmNlData = 0;
let allocatedN = 0, allocatedNlTotal = 0;

// CSR generation tracking — compared against engine's _csrGeneration
let _marshaledCsrGeneration = -1;

/**
 * Load and initialize the Wasm module. Idempotent — multiple calls
 * return the same promise. No duplicate script loads.
 */
export function initWasm() {
  if (_initPromise) return _initPromise;
  _initPromise = _doInitWasm();
  return _initPromise;
}

async function _doInitWasm() {
  try {
    // Load Emscripten glue via script tag (it's not an ES module — it defines a global factory)
    await new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = new URL('../wasm/tersoff.js', import.meta.url).href;
      script.onload = resolve;
      script.onerror = () => reject(new Error('Failed to load tersoff.js'));
      document.head.appendChild(script);
    });
    const factory = globalThis.createTersoffModule;
    if (!factory) throw new Error('createTersoffModule not found after script load');
    wasmModule = await factory();
    wasmTersoff = wasmModule.cwrap('computeTersoffForces', null,
      ['number', 'number', 'number', 'number', 'number']);
    return true;
  } catch (e) {
    console.warn('[wasm] Failed to load Tersoff kernel, using JS fallback:', e.message);
    wasmModule = null;
    wasmTersoff = null;
    return false;
  }
}

/** Check if Wasm kernel is ready for use. */
export function isReady() { return wasmTersoff !== null; }

/** Ensure Wasm-side buffers are large enough for n atoms and nlTotal neighbors. */
function ensureBuffers(n, nlTotal) {
  if (n > allocatedN) {
    if (wasmPos) wasmModule._free(wasmPos);
    if (wasmForce) wasmModule._free(wasmForce);
    if (wasmNlOffsets) wasmModule._free(wasmNlOffsets);
    wasmPos = wasmModule._malloc(n * 3 * 8);        // Float64
    wasmForce = wasmModule._malloc(n * 3 * 8);      // Float64
    wasmNlOffsets = wasmModule._malloc((n + 1) * 4); // Int32
    allocatedN = n;
  }
  if (nlTotal > allocatedNlTotal) {
    if (wasmNlData) wasmModule._free(wasmNlData);
    wasmNlData = wasmModule._malloc(nlTotal * 4);    // Int32
    allocatedNlTotal = nlTotal;
  }
}

/**
 * Marshal cached CSR arrays into Wasm memory.
 * Called only when CSR generation has changed (every 10 steps on neighbor rebuild).
 * @param {Int32Array} csrOffsets - [n+1] cumulative neighbor counts
 * @param {Int32Array} csrData - flat neighbor indices
 * @param {number} n - atom count
 * @param {number} generation - engine's _csrGeneration
 * @returns {boolean} true if marshal succeeded
 */
/**
 * @returns {{ ok: boolean, csrMarshalMs: number }}
 */
export function marshalCSR(csrOffsets, csrData, n, generation, totalNl) {
  const t0 = performance.now();
  try {
    ensureBuffers(n, totalNl);
    const offView = new Int32Array(wasmModule.HEAP32.buffer, wasmNlOffsets, n + 1);
    offView.set(csrOffsets);
    const dataView = new Int32Array(wasmModule.HEAP32.buffer, wasmNlData, totalNl);
    dataView.set(csrData.subarray(0, totalNl));
    _marshaledCsrGeneration = generation;
    return { ok: true, csrMarshalMs: performance.now() - t0 };
  } catch (e) {
    console.warn('[wasm] CSR marshal failed:', e.message);
    return { ok: false, csrMarshalMs: performance.now() - t0 };
  }
}

/** Check if CSR in Wasm memory matches the engine's current generation. */
export function csrIsCurrent(generation) {
  return _marshaledCsrGeneration === generation;
}

/**
 * Call the Wasm Tersoff kernel. CSR must already be marshaled.
 * @param {Float64Array} pos - JS position array
 * @param {Float64Array} force - JS force array (output)
 * @param {number} n - atom count
 * @returns {{ marshalMs: number, kernelMs: number, pathMs: number }} timing breakdown
 */
/**
 * @returns {{ ok: boolean, marshalMs: number, kernelMs: number, pathMs: number }}
 */
export function callTersoff(pos, force, n) {
  const t0 = performance.now();
  try {
    // Marshal pos into Wasm memory, zero force
    ensureBuffers(n, 0);
    const wasmPosView = new Float64Array(wasmModule.HEAPF64.buffer, wasmPos, n * 3);
    wasmPosView.set(pos);
    const wasmForceView = new Float64Array(wasmModule.HEAPF64.buffer, wasmForce, n * 3);
    wasmForceView.fill(0);

    const t1 = performance.now();

    // Call kernel
    wasmTersoff(wasmPos, wasmForce, wasmNlOffsets, wasmNlData, n);

    const t2 = performance.now();

    // Copy force back to JS
    force.set(wasmForceView);

    const t3 = performance.now();

    return {
      ok: true,
      marshalMs: (t1 - t0) + (t3 - t2),
      kernelMs: t2 - t1,
      pathMs: t3 - t0,
    };
  } catch (e) {
    console.warn('[wasm] Kernel call failed, falling back to JS:', e.message);
    return { ok: false, marshalMs: 0, kernelMs: 0, pathMs: performance.now() - t0 };
  }
}
