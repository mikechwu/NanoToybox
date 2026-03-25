/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import { resolve } from 'path'
import copy from 'rollup-plugin-copy'
import react from '@vitejs/plugin-react'

export default defineConfig({
  base: '/NanoToybox/',
  test: {
    include: ['tests/unit/**/*.test.ts'],
  },
  build: {
    outDir: 'dist',
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'page/index.html'),
        test: resolve(__dirname, 'page/test.html'),
        rollback: resolve(__dirname, 'page/test-rollback.html'),
        viewer: resolve(__dirname, 'viewer/index.html'),
        'bench-physics': resolve(__dirname, 'page/bench/bench-physics.html'),
        'bench-render': resolve(__dirname, 'page/bench/bench-render.html'),
        'bench-distance': resolve(__dirname, 'page/bench/bench-distance.html'),
        'bench-celllist': resolve(__dirname, 'page/bench/bench-celllist.html'),
        'bench-wasm': resolve(__dirname, 'page/bench/bench-wasm.html'),
        'bench-spread': resolve(__dirname, 'page/bench/bench-spread.html'),
        'bench-preWasm': resolve(__dirname, 'page/bench/bench-preWasm.html'),
        'bench-kernel-profile': resolve(__dirname, 'page/bench/bench-kernel-profile.html'),
        'test-worker': resolve(__dirname, 'page/test-worker.html'),
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
