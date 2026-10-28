/*
 * Shared constants for the production-smoke E2E suite.
 *
 * Imported by playwright.config.ts, global-setup.ts, the server helpers, and
 * every spec — so it must depend only on `node:*` builtins (no `@/` aliases),
 * keeping the suite a hermetic black-box harness against the running server.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url)); // tests/e2e/lib
export const E2E_DIR = path.resolve(HERE, '..'); // tests/e2e
export const REPO_ROOT = path.resolve(E2E_DIR, '..', '..');

/** Scratch workspace the suite writes to — recreated by global-setup, gitignored. */
export const TMP_DIR = path.join(E2E_DIR, '.tmp');
/** INFLOOP_DATA_DIR for the shared Playwright-managed server. */
export const DATA_DIR = path.join(TMP_DIR, 'data');
/** INFLOOP_PROVIDERS_DIR — holds only the generated stub provider manifest. */
export const PROVIDERS_DIR = path.join(TMP_DIR, 'providers');

/** Committed fixtures. */
export const FIXTURES_DIR = path.join(E2E_DIR, 'fixtures');
export const FAKE_AGENT = path.join(FIXTURES_DIR, 'fake-agent.sh');
/** Every `*.json` here is copied into a seeded data dir's `workflows/`. */
export const WORKFLOWS_FIXTURE_DIR = path.join(FIXTURES_DIR, 'workflows');

/** The seeded flow used by canvas, run, and routing smoke tests. */
export const DEFAULT_WORKFLOW_ID = 'loop-claude-until-condition';
/** Workflow the crash-recovery spec runs — its agent timeout far outlasts the
 *  crash window, so only the SIGKILL can interrupt the run. */
export const CRASH_WORKFLOW_ID = 'crash-recovery-workflow';

/** Provider id of the deterministic stub agent referenced by the seeded workflows. */
export const STUB_PROVIDER_ID = 'e2e-echo';

/** Token the suite's server runs with — gates the API and the browser login. */
export const API_TOKEN = 'e2e-smoke-token-not-a-real-secret';

/** Shared production server, owned by Playwright's `webServer`. */
export const PORT = 3460;
export const BASE_URL = `http://127.0.0.1:${PORT}`;

/** Dedicated port + dirs for the crash-recovery spec's own server lifecycle,
 *  fully isolated from the shared server so the specs cannot interfere. */
export const CRASH_PORT = 3461;
export const CRASH_DATA_DIR = path.join(TMP_DIR, 'crash-data');
export const CRASH_PROVIDERS_DIR = path.join(TMP_DIR, 'crash-providers');

/**
 * Build the env a server process needs to run against the suite's fixtures.
 * Production mode + loopback host, so the network-posture gate is satisfied.
 */
export function serverEnv(
  overrides: Record<string, string> = {},
): Record<string, string> {
  return {
    NODE_ENV: 'production',
    HOST: '127.0.0.1',
    PORT: String(PORT),
    INFLOOP_API_TOKEN: API_TOKEN,
    INFLOOP_DATA_DIR: DATA_DIR,
    INFLOOP_PROVIDERS_DIR: PROVIDERS_DIR,
    INFLOOP_LOG_LEVEL: 'warn',
    ...overrides,
  };
}
