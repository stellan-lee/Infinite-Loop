/*
 * Smoke check — crash recovery (the operational test).
 *
 * This is the one piece of the hardening work that unit tests genuinely cannot
 * prove: that a hard crash mid-run is reconciled on the next boot. It manages
 * its own server lifecycle (the shared Playwright `webServer` cannot be killed
 * without breaking every other spec), on a dedicated port, data dir, and
 * providers dir — fully isolated from the rest of the suite.
 *
 * Flow: boot server A → start a run with a hung stub agent → SIGKILL A while the
 * run is in-flight → boot server B on the same data dir → assert B's boot-time
 * `reconcileInterruptedRuns()` turned the orphaned run into a `failed` record.
 *
 * The crash workflow's agent node `timeoutMs` (600s) far outlasts the crash
 * window, so the ONLY thing that can interrupt the run is the SIGKILL — without
 * that, a node-timeout could settle the run normally and the test would pass
 * for the wrong reason.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import {
  API_TOKEN,
  CRASH_DATA_DIR,
  CRASH_PORT,
  CRASH_PROVIDERS_DIR,
  CRASH_WORKFLOW_ID,
  serverEnv,
} from './lib/env';
import {
  delay,
  resetDir,
  seedDataDir,
  spawnServer,
  waitForExit,
  waitForFile,
  waitForHealth,
  writeStubProvider,
} from './lib/server';

test('a run interrupted by a hard crash is reconciled to failed on restart', async () => {
  test.setTimeout(150_000);

  // Self-contained fixtures — no dependency on the shared server's dirs.
  resetDir(CRASH_DATA_DIR);
  seedDataDir(CRASH_DATA_DIR);
  writeStubProvider(CRASH_PROVIDERS_DIR);

  const env = serverEnv({
    PORT: String(CRASH_PORT),
    INFLOOP_DATA_DIR: CRASH_DATA_DIR,
    INFLOOP_PROVIDERS_DIR: CRASH_PROVIDERS_DIR,
    // Make the stub agent hang so the run is still in-flight at SIGKILL time.
    FAKE_AGENT_SLEEP_MS: '60000',
  });

  // ── Boot server A and start a run. ──────────────────────────────────────
  const a = spawnServer(env);
  await waitForHealth(a);

  const runRes = await fetch(`${a.baseUrl}/api/run`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      Authorization: `Bearer ${API_TOKEN}`,
    },
    body: JSON.stringify({ workflowId: CRASH_WORKFLOW_ID }),
  });
  expect(runRes.status).toBe(202);
  const { runId } = (await runRes.json()) as { runId: string };
  expect(runId).toBeTruthy();

  // The controller writes an active-run marker once the run is live; wait for
  // it so we crash mid-run rather than before it has truly started.
  const markerPath = path.join(CRASH_DATA_DIR, 'active-runs', `${runId}.json`);
  await waitForFile(markerPath, 25_000);

  // ── Hard crash. SIGKILL runs no shutdown handlers, leaving the detached
  //    stub-agent process group orphaned — exactly the scenario boot-time
  //    crash recovery exists to clean up. ──────────────────────────────────
  a.proc.kill('SIGKILL');
  await waitForExit(a.proc, 10_000);
  // Brief pause so the OS fully releases the listening socket before reuse.
  await delay(500);

  // ── Boot server B on the same data dir. ─────────────────────────────────
  const b = spawnServer(env);
  try {
    await waitForHealth(b);

    // reconcileInterruptedRuns() ran at boot: the orphaned marker becomes a
    // terminal `failed` history record.
    await expect
      .poll(
        async () => {
          const res = await fetch(`${b.baseUrl}/api/runs`, {
            headers: { Authorization: `Bearer ${API_TOKEN}` },
          });
          if (!res.ok) return null;
          const body = (await res.json()) as {
            runs?: Array<{ runId: string; status: string }>;
          };
          return body.runs?.find((r) => r.runId === runId)?.status ?? null;
        },
        { timeout: 25_000 },
      )
      .toBe('failed');

    // The active-run marker is cleared once the run has been reconciled.
    expect(existsSync(markerPath)).toBe(false);
  } finally {
    b.proc.kill('SIGTERM');
    await waitForExit(b.proc, 10_000).catch(() => b.proc.kill('SIGKILL'));
  }
});
