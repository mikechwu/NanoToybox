/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import { resolve } from 'path'
import copy from 'rollup-plugin-copy'
import react from '@vitejs/plugin-react'

export default defineConfig({
  base: '/',
  test: {
    include: ['tests/unit/**/*.test.{ts,tsx}'],
  },
  build: {
    outDir: 'dist',
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'lab/index.html'),
        test: resolve(__dirname, 'lab/test.html'),
        rollback: resolve(__dirname, 'lab/test-rollback.html'),
        viewer: resolve(__dirname, 'viewer/index.html'),
        watch: resolve(__dirname, 'watch/index.html'),
        'bench-physics': resolve(__dirname, 'lab/bench/bench-physics.html'),
        'bench-render': resolve(__dirname, 'lab/bench/bench-render.html'),
        'bench-distance': resolve(__dirname, 'lab/bench/bench-distance.html'),
        'bench-celllist': resolve(__dirname, 'lab/bench/bench-celllist.html'),
        'bench-wasm': resolve(__dirname, 'lab/bench/bench-wasm.html'),
        'bench-spread': resolve(__dirname, 'lab/bench/bench-spread.html'),
        'bench-preWasm': resolve(__dirname, 'lab/bench/bench-preWasm.html'),
        'bench-kernel-profile': resolve(__dirname, 'lab/bench/bench-kernel-profile.html'),
        'test-worker': resolve(__dirname, 'lab/test-worker.html'),
      },
    },
  },
  plugins: [
    copy({
      targets: [
        { src: 'structures/library', dest: 'dist/structures' },
        // Wasm assets are handled by Vite ?url imports in tersoff-wasm.js
        // (emitted as hashed assets under dist/assets/). No manual copy needed.
      ],
      hook: 'writeBundle',
    }),
    react(),
  ],
})
