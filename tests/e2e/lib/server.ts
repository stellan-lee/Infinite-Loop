/*
 * Server + fixture helpers for the production-smoke E2E suite.
 *
 * Two consumers:
 *  - global-setup.ts seeds the shared server's data/providers dirs.
 *  - crash-recovery.e2e.ts spawns and kills its own server instances.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import {
  FAKE_AGENT,
  REPO_ROOT,
  STUB_PROVIDER_ID,
  WORKFLOWS_FIXTURE_DIR,
} from './env';

/** Wipe `dir` and recreate it empty. */
export function resetDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
}

/**
 * Write the stub provider manifest into `providersDir`.
 *
 * Generated rather than committed because `bin` must be an absolute path: the
 * provider runner spawns the binary with cwd set to the agent node's `cwd`, so
 * a repo-relative path would not resolve. The path is machine-specific.
 */
export function writeStubProvider(providersDir: string): void {
  mkdirSync(providersDir, { recursive: true });
  // git usually preserves the exec bit; restore it defensively (fresh clones,
  // Windows checkouts, archive extracts).
  chmodSync(FAKE_AGENT, 0o755);
  const manifest = {
    transport: 'cli',
    id: STUB_PROVIDER_ID,
    label: 'E2E Echo',
    description:
      'Deterministic stub agent for the E2E smoke suite — spends no API credits.',
    glyph: '✓',
    bin: FAKE_AGENT,
    args: ['{prompt}'],
    outputFormat: 'plain',
    promptVia: 'arg',
  };
  writeFileSync(
    path.join(providersDir, `${STUB_PROVIDER_ID}.json`),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
}

/**
 * Seed a data dir: the subdirs the server and crash recovery expect, plus every
 * fixture workflow under `workflows/` (the workflow-store reads `<id>.json`).
 */
export function seedDataDir(dataDir: string): void {
  for (const sub of ['workflows', 'triggers', 'pids', 'active-runs', 'audit']) {
    mkdirSync(path.join(dataDir, sub), { recursive: true });
  }
  const workflowsDir = path.join(dataDir, 'workflows');
  for (const file of readdirSync(WORKFLOWS_FIXTURE_DIR)) {
    if (file.endsWith('.json')) {
      copyFileSync(
        path.join(WORKFLOWS_FIXTURE_DIR, file),
        path.join(workflowsDir, file),
      );
    }
  }
}

export interface ServerHandle {
  proc: ChildProcess;
  port: number;
  baseUrl: string;
  /** Tail of the server's combined stdout+stderr — for failure diagnostics. */
  output(): string;
}

/** Spawn `bun server.ts` with the given env. Requires `.next` to already exist. */
export function spawnServer(env: Record<string, string>): ServerHandle {
  if (!existsSync(path.join(REPO_ROOT, '.next'))) {
    throw new Error(
      'spawnServer: .next build output is missing — run `next build` first ' +
        "(Playwright's webServer normally does this before any spec runs).",
    );
  }
  const port = Number(env.PORT);
  const proc = spawn('bun', ['server.ts'], {
    cwd: REPO_ROOT,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let buf = '';
  const capture = (chunk: Buffer): void => {
    buf = (buf + chunk.toString()).slice(-4000);
  };
  proc.stdout?.on('data', capture);
  proc.stderr?.on('data', capture);
  return { proc, port, baseUrl: `http://127.0.0.1:${port}`, output: () => buf };
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Poll `/api/health` until the server answers 200, or throw with its output. */
export async function waitForHealth(
  handle: ServerHandle,
  timeoutMs = 90_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (handle.proc.exitCode !== null) {
      throw new Error(
        `server exited early (code ${handle.proc.exitCode}):\n${handle.output()}`,
      );
    }
    try {
      const res = await fetch(`${handle.baseUrl}/api/health`);
      if (res.ok) return;
    } catch {
      // not listening yet
    }
    await delay(250);
  }
  throw new Error(
    `server did not become healthy in ${timeoutMs}ms:\n${handle.output()}`,
  );
}

/** Resolve once the process has exited. */
export async function waitForExit(
  proc: ChildProcess,
  timeoutMs = 10_000,
): Promise<void> {
  if (proc.exitCode !== null || proc.signalCode !== null) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('process did not exit in time')),
      timeoutMs,
    );
    proc.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/** Poll until `filePath` exists. */
export async function waitForFile(
  filePath: string,
  timeoutMs = 20_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(filePath)) return;
    await delay(150);
  }
  throw new Error(`file did not appear within ${timeoutMs}ms: ${filePath}`);
}
