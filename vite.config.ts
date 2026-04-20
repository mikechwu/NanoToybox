/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import { resolve } from 'path'
import copy from 'rollup-plugin-copy'
import react from '@vitejs/plugin-react'
import { policyConfigPlugin } from './src/policy/vite-policy-plugin'

// Single source of truth for preview-audit emission control:
// `command === 'serve' || PREVIEW_AUDIT_BUILD === '1'`. `mode === 'development'`
// is never used — it's a loose key that leaves `vite build --mode development`
// free to emit `dist/preview-audit/`, which the audit-page plan explicitly
// rejects (see `.reports/2026-04-19-capsule-preview-audit-page-plan.md`
// §Production-exclusion).
export default defineConfig(({ command }) => {
  const includePreviewAudit =
    command === 'serve' || process.env.PREVIEW_AUDIT_BUILD === '1';

  return {
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
          privacy: resolve(__dirname, 'privacy/index.html'),
          terms: resolve(__dirname, 'terms/index.html'),
          account: resolve(__dirname, 'account/index.html'),
          'privacy-request': resolve(__dirname, 'privacy-request/index.html'),
          'bench-physics': resolve(__dirname, 'lab/bench/bench-physics.html'),
          'bench-render': resolve(__dirname, 'lab/bench/bench-render.html'),
          'bench-distance': resolve(__dirname, 'lab/bench/bench-distance.html'),
          'bench-celllist': resolve(__dirname, 'lab/bench/bench-celllist.html'),
          'bench-wasm': resolve(__dirname, 'lab/bench/bench-wasm.html'),
          'bench-spread': resolve(__dirname, 'lab/bench/bench-spread.html'),
          'bench-preWasm': resolve(__dirname, 'lab/bench/bench-preWasm.html'),
          'bench-kernel-profile': resolve(__dirname, 'lab/bench/bench-kernel-profile.html'),
          'test-worker': resolve(__dirname, 'lab/test-worker.html'),
          ...(includePreviewAudit
            ? { 'preview-audit': resolve(__dirname, 'preview-audit/index.html') }
            : {}),
        },
      },
    },
    plugins: [
      copy({
        targets: [
          { src: 'structures/library', dest: 'dist/structures' },
          { src: '_routes.json', dest: 'dist' },
          // Wasm assets are handled by Vite ?url imports in tersoff-wasm.js
          // (emitted as hashed assets under dist/assets/). No manual copy needed.
        ],
        hook: 'writeBundle',
      }),
      react(),
      policyConfigPlugin(),
    ],
  };
})
