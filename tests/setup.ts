// Order matters: @testing-library/dom captures `document.body` at import time
// (it returns an error-throwing `screen` if the global isn't there yet). So we
// register happy-dom FIRST, then load anything that pulls in RTL.

// Stash the native fetch before happy-dom overrides it with a CORS-enforcing
// shim. Tests that exercise real Node-side HTTP code (e.g. the http-runner's
// fetch against a node:http stub server) should use this to bypass the DOM
// polyfill — in production those code paths run on the Next.js server with
// no CORS layer at all.
(globalThis as { __infloopNativeFetch?: typeof fetch }).__infloopNativeFetch =
  globalThis.fetch;

import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register();

const { afterEach, expect } = await import('bun:test');
const matchers = await import('@testing-library/jest-dom/matchers');
const { cleanup } = await import('@testing-library/react');

// `matchers` is a namespace of named exports — pass it through unchanged so
// expect.extend sees each matcher by name. The cast bridges bun:test's
// stricter MatcherFunction signature to jest-dom's loose one.
expect.extend(matchers as unknown as Record<string, never>);

// @testing-library/react auto-cleans up between tests under jest/vitest, but
// not under bun:test — so unmount + clear DOM between tests ourselves.
afterEach(() => {
  cleanup();
});

// Spawned-child env scrubbing (lib/server/child-env.ts) strips every host
// variable not on its allowlist. The env-driven fake CLIs under
// tests/fixtures/ are configured via FAKE_* variables — allow those through
// for the whole test process so runner / agent / judge integration tests
// still reach their stub binaries with their configuration intact.
process.env.INFLOOP_CHILD_ENV_PASSTHROUGH = 'FAKE_*';

// Isolate every test from the developer's real data directory. Server code
// derives runs/, pids/, active-runs/, triggers/, connections/ from `dataDir()`,
// which honors INFLOOP_DATA_DIR — point it at a throwaway temp dir so a test
// run never reads or writes `~/.infinite-loop`. A test that needs its own
// fixtures can still override INFLOOP_DATA_DIR for itself.
if (!process.env.INFLOOP_DATA_DIR) {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'infloop-test-data-'));
  process.env.INFLOOP_DATA_DIR = dir;
  process.on('exit', () => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best effort — the OS reaps its temp dir anyway
    }
  });
}
