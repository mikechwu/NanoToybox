import { defineConfig } from '@playwright/test'

// Local troubleshooting:
// - If port 4173 is occupied, kill the process: lsof -ti:4173 | xargs kill
// - --strictPort ensures Vite fails rather than silently moving to another port
// - reuseExistingServer is enabled locally (disabled in CI) so a running
//   preview server is reused instead of starting a new one
// - CI is the authoritative automated gate (see .github/workflows/ci.yml)

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 60000,
  use: {
    baseURL: 'http://127.0.0.1:4173',
    headless: true,
  },
  webServer: {
    command: 'npx vite preview --host 127.0.0.1 --port 4173 --strictPort',
    url: 'http://127.0.0.1:4173/lab/',
    reuseExistingServer: !process.env.CI,
    timeout: 15000,
  },
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' } },
  ],
})
