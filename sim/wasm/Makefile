# Tersoff Wasm kernel build
# Requires Emscripten (emcc). Install: https://emscripten.org/docs/getting_started/
#
# Usage: make -C sim/wasm
# Output: page/wasm/tersoff.js + page/wasm/tersoff.wasm

CC = emcc
OUT_DIR = ../../page/wasm
CFLAGS = -O3 \
         -s WASM=1 \
         -s EXPORTED_FUNCTIONS='["_computeTersoffForces", "_malloc", "_free"]' \
         -s EXPORTED_RUNTIME_METHODS='["cwrap","HEAP32","HEAPF64"]' \
         -s ALLOW_MEMORY_GROWTH=1 \
         -s INITIAL_MEMORY=16777216 \
         -s MODULARIZE=1 \
         -s EXPORT_NAME='createTersoffModule' \
         --no-entry

all: $(OUT_DIR)/tersoff.js

$(OUT_DIR)/tersoff.js: tersoff.c
	@mkdir -p $(OUT_DIR)
	$(CC) $(CFLAGS) -o $@ $<
	@echo "// Built: $$(date -u +%Y-%m-%dT%H:%M:%SZ) | emcc $$(emcc --version 2>&1 | head -1) | src: $$(md5 -q tersoff.c 2>/dev/null || md5sum tersoff.c 2>/dev/null | cut -d' ' -f1 || echo unknown)" >> $@

clean:
	rm -f $(OUT_DIR)/tersoff.js $(OUT_DIR)/tersoff.wasm

.PHONY: all clean
