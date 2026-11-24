import { defineConfig } from '@playwright/test';
import { devEnv } from './e2e/env';

// End-to-end tests run against a production build (`npm run build`) talking to the mock upstreams (WP7).
// Locally: `npm run build && npm run e2e`. In Docker: `docker compose -f compose.test.yaml up --build ...`.
// Set E2E_BASE_URL (and E2E_MOCK_URL) to test an already running stack instead of starting one.
const PORT = 3100;
const base = process.env.E2E_BASE_URL ?? `http://localhost:${PORT}`;
const external = process.env.E2E_BASE_URL !== undefined;
const chromium = process.env.PW_CHROMIUM ? { launchOptions: { executablePath: process.env.PW_CHROMIUM } } : {};

export default defineConfig({
  testDir: './e2e',
  // The scenarios share one app and one mock: specs run in file order, one at a time.
  workers: 1,
  fullyParallel: false,
  timeout: 180_000,
  expect: { timeout: 15_000 },
  reporter: [['list']],
  use: { baseURL: base, trace: 'retain-on-failure', ...chromium },
  projects: [{ name: 'desktop', use: { viewport: { width: 1440, height: 900 } } }],
  webServer: external
    ? undefined
    : [
        {
          command: 'node test/mock-upstreams/server.mjs',
          url: 'http://localhost:9999/__scenario',
          reuseExistingServer: true,
          timeout: 30_000,
        },
        {
          command: `npx next start -p ${PORT}`,
          url: `${base}/api/health`,
          reuseExistingServer: true,
          timeout: 60_000,
          env: {
            ...devEnv(),
            POLLER_ENABLED: 'true',
            DATA_DIR: process.env.E2E_DATA_DIR ?? '.e2e-data',
            PORT: String(PORT),
          },
        },
      ],
});
