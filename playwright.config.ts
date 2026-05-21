/*
 * Playwright config — the production-smoke E2E suite.
 *
 * This suite is the project's end-to-end verification layer: it boots the real
 * production server artifact (`NODE_ENV=production bun server.ts`) against a
 * hermetic temp data dir + a deterministic stub agent, then drives the assembled
 * product through a real browser and over HTTP. Unit tests (`bun test`) prove
 * modules work in isolation; this proves they compose into a working product.
 *
 * Run with `bun run test:e2e`. The `webServer` block builds and starts the
 * server, so `playwright test` is self-sufficient.
 *
 * Spec files are named `*.e2e.ts` (not `*.spec.ts`) so the unit-test runner
 * `bun test` never picks them up.
 */
import { defineConfig } from '@playwright/test';
import { BASE_URL, PORT, serverEnv } from './tests/e2e/lib/env';

const isCI = !!process.env.CI;

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: /.*\.e2e\.ts$/,
  globalSetup: './tests/e2e/global-setup.ts',

  // The smoke suite shares one server + one data dir; run serially so specs
  // never race each other on run history or the audit log.
  fullyParallel: false,
  workers: 1,

  forbidOnly: isCI,
  retries: isCI ? 1 : 0,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: isCI ? [['github'], ['list']] : 'list',

  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },

  webServer: {
    // Build, then start the real production artifact. The build also populates
    // `.next` for the crash-recovery spec, which spawns its own server.
    command: 'next build && bun server.ts',
    url: `http://127.0.0.1:${PORT}/api/health`,
    timeout: 240_000,
    reuseExistingServer: !isCI,
    env: serverEnv(),
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
