/**
 * Integration test for the SetOutput MCP injection path in agentExecutor.
 *
 * Strategy: mock `runProvider` to read the per-invocation mcp.json the
 * executor wrote, parse out the bearer token, and POST to the REAL
 * `/api/mcp/output` route handler. This exercises auth + tools/call +
 * registry merge, matching the design review's R13.4 directive ("fetch the
 * real route, not the registry directly").
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock } from 'bun:test';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { NodeExecutorContext } from '@/lib/shared/workflow';
import type { RunnerOptions, RunnerResult } from '@/lib/shared/types';

// Snapshot the real runner module BEFORE mocking so we can restore it in
// afterAll. `mock.module` is process-global within a bun-test worker; without
// the restore other test files (notably lib/server/providers/runner.test.ts)
// would see the stubbed runProvider and fail.
const realRunner = { ...(await import('@/lib/server/providers/runner')) };

let lastRunnerOpts: RunnerOptions | null = null;
let runnerImpl: (opts: RunnerOptions) => Promise<RunnerResult> = async (opts) => {
  lastRunnerOpts = opts;
  return {
    exitCode: 0,
    stdout: '',
    stderr: '',
    durationMs: 1,
    timedOut: false,
  };
};

mock.module('@/lib/server/providers/runner', () => ({
  ...realRunner,
  runProvider: (_manifest: unknown, opts: RunnerOptions) => runnerImpl(opts),
}));

const { agentExecutor, DEFAULT_AGENT_TIMEOUT_MS } = await import(
  '@/lib/server/nodes/agent'
);
const { _resetProviderCache } = await import('@/lib/server/providers/loader');
const { setBoundPort, __resetBoundPortForTests } = await import('@/lib/server/runtime');
const { __resetRegistryForTests } = await import('@/lib/server/mcp/output-registry');
const { POST: outputRoutePOST } = await import('@/app/api/mcp/output/route');

afterAll(() => {
  // Restore the real module so sibling test files see the original runProvider.
  mock.module('@/lib/server/providers/runner', () => realRunner);
});

let providersDir: string;
let prevProvidersDir: string | undefined;

beforeAll(() => {
  // Pretend the HTTP server is bound on an arbitrary high port. The runner
  // is mocked, so no real socket gets used — but setBoundPort rejects <= 0,
  // so a non-zero placeholder is required.
  setBoundPort(54321);
});

afterAll(() => {
  __resetBoundPortForTests();
});

beforeEach(async () => {
  providersDir = await fs.mkdtemp(path.join(os.tmpdir(), 'infinite-loop-agent-mcp-'));
  prevProvidersDir = process.env.INFLOOP_PROVIDERS_DIR;
  process.env.INFLOOP_PROVIDERS_DIR = providersDir;
  await fs.writeFile(
    path.join(providersDir, 'claude.json'),
    JSON.stringify({
      id: 'claude',
      label: 'Claude',
      description: 'fake',
      bin: 'claude',
      args: ['--mcp-config', '{mcpConfig}', '{prompt}'],
      outputFormat: 'plain',
    }),
  );
  _resetProviderCache();
  __resetRegistryForTests();
  lastRunnerOpts = null;
  // Default runner: just records opts and returns success.
  runnerImpl = async (opts) => {
    lastRunnerOpts = opts;
    return { exitCode: 0, stdout: '', stderr: '', durationMs: 1, timedOut: false };
  };
});

afterEach(async () => {
  if (prevProvidersDir === undefined) {
    delete process.env.INFLOOP_PROVIDERS_DIR;
  } else {
    process.env.INFLOOP_PROVIDERS_DIR = prevProvidersDir;
  }
  await fs.rm(providersDir, { recursive: true, force: true });
  _resetProviderCache();
  __resetRegistryForTests();
});

function ctx(config: unknown, extras: Partial<NodeExecutorContext> = {}): NodeExecutorContext {
  return {
    runId: 'run-test',
    nodeId: 'agent-1',
    config,
    scope: {},
    defaultCwd: process.cwd(),
    signal: new AbortController().signal,
    ...extras,
  };
}

async function readMcpConfig(configPath: string): Promise<{
  url: string;
  token: string;
}> {
  const raw = await fs.readFile(configPath, 'utf8');
  const parsed = JSON.parse(raw) as {
    mcpServers: {
      infinite_loop_output: { url: string; headers: { Authorization: string } };
    };
  };
  const entry = parsed.mcpServers.infinite_loop_output;
  return {
    url: entry.url,
    token: entry.headers.Authorization.replace(/^Bearer /, ''),
  };
}

describe('agentExecutor SetOutput MCP injection', () => {
  it('writes a per-invocation mcp.json with bearer token and 127.0.0.1 URL', async () => {
    let captured: { url: string; token: string } | null = null;
    runnerImpl = async (opts) => {
      lastRunnerOpts = opts;
      if (opts.mcpConfigPath) {
        captured = await readMcpConfig(opts.mcpConfigPath);
      }
      return { exitCode: 0, stdout: '', stderr: '', durationMs: 1, timedOut: false };
    };
    await agentExecutor.execute(
      ctx({
        providerId: 'claude',
        prompt: 'p',
        cwd: process.cwd(),
        timeoutMs: 5000,
        outputs: [{ name: 'PR_LINK', description: 'pr url' }],
      }),
    );
    expect(captured).not.toBeNull();
    expect(captured!.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/api\/mcp\/output$/);
    expect(captured!.token).toMatch(/^[0-9a-f]{64}$/);
  });

  it('merges declared outputs into the node output map when the route is called', async () => {
    runnerImpl = async (opts) => {
      lastRunnerOpts = opts;
      const { token } = await readMcpConfig(opts.mcpConfigPath!);
      // Simulate the agent calling set_output via the real route handler.
      const res = await outputRoutePOST(
        new Request('http://localhost/api/mcp/output', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: {
              name: 'set_output',
              arguments: { key: 'PR_LINK', value: 'https://x/pr/1' },
            },
          }),
        }),
      );
      const body = (await res.json()) as { result: { isError?: boolean } };
      if (body.result.isError) throw new Error('set_output rejected');
      return { exitCode: 0, stdout: '', stderr: '', durationMs: 1, timedOut: false };
    };

    const out = await agentExecutor.execute(
      ctx({
        providerId: 'claude',
        prompt: 'p',
        cwd: process.cwd(),
        timeoutMs: 5000,
        outputs: [{ name: 'PR_LINK' }],
      }),
    );
    expect(out.branch).toBe('next');
    expect(out.outputs).toMatchObject({
      exitCode: 0,
      stdout: '',
      PR_LINK: 'https://x/pr/1',
    });
  });

  it('cleans up the temp mcp-config dir after execution', async () => {
    let capturedPath: string | undefined;
    runnerImpl = async (opts) => {
      lastRunnerOpts = opts;
      capturedPath = opts.mcpConfigPath;
      return { exitCode: 0, stdout: '', stderr: '', durationMs: 1, timedOut: false };
    };
    await agentExecutor.execute(
      ctx({
        providerId: 'claude',
        prompt: 'p',
        cwd: process.cwd(),
        timeoutMs: 5000,
        outputs: [{ name: 'PR_LINK' }],
      }),
    );
    expect(capturedPath).toBeDefined();
    // Parent temp dir should be gone.
    const tempDir = path.dirname(capturedPath!);
    let exists = true;
    try {
      await fs.access(tempDir);
    } catch {
      exists = false;
    }
    expect(exists).toBe(false);
  });

  it('preserves partial outputs on agent failure (exit != 0)', async () => {
    runnerImpl = async (opts) => {
      lastRunnerOpts = opts;
      const { token } = await readMcpConfig(opts.mcpConfigPath!);
      await outputRoutePOST(
        new Request('http://localhost/api/mcp/output', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: {
              name: 'set_output',
              arguments: { key: 'PR_LINK', value: 'partial' },
            },
          }),
        }),
      );
      return { exitCode: 1, stdout: '', stderr: 'boom', durationMs: 1, timedOut: false };
    };
    const out = await agentExecutor.execute(
      ctx({
        providerId: 'claude',
        prompt: 'p',
        cwd: process.cwd(),
        timeoutMs: 5000,
        outputs: [{ name: 'PR_LINK' }],
      }),
    );
    expect(out.branch).toBe('error');
    expect(out.outputs).toMatchObject({ PR_LINK: 'partial', exitCode: 1 });
  });

  it('skips MCP injection when no outputs are declared', async () => {
    runnerImpl = async (opts) => {
      lastRunnerOpts = opts;
      return { exitCode: 0, stdout: '', stderr: '', durationMs: 1, timedOut: false };
    };
    await agentExecutor.execute(
      ctx({
        providerId: 'claude',
        prompt: 'p',
        cwd: process.cwd(),
        timeoutMs: 5000,
      }),
    );
    expect(lastRunnerOpts!.mcpConfigPath).toBeUndefined();
  });

  it('skips MCP injection when runId is missing (test ctx without engine)', async () => {
    runnerImpl = async (opts) => {
      lastRunnerOpts = opts;
      return { exitCode: 0, stdout: '', stderr: '', durationMs: 1, timedOut: false };
    };
    await agentExecutor.execute(
      ctx(
        {
          providerId: 'claude',
          prompt: 'p',
          cwd: process.cwd(),
          timeoutMs: 5000,
          outputs: [{ name: 'PR_LINK' }],
        },
        { runId: undefined },
      ),
    );
    expect(lastRunnerOpts!.mcpConfigPath).toBeUndefined();
  });

  it('warns when outputs are declared but provider is HTTP transport', async () => {
    // Swap claude provider's transport to http for this test by writing a
    // fresh manifest that the loader will pick up. The runner mock returns
    // success regardless, so we only assert the warning emission and that
    // no mcp.json was passed through.
    await fs.writeFile(
      path.join(providersDir, 'claude.json'),
      JSON.stringify({
        id: 'claude',
        label: 'Claude',
        description: 'fake',
        transport: 'http',
        baseUrl: 'http://127.0.0.1:1',
        endpoint: '/no-such',
        outputFormat: 'plain',
      }),
    );
    _resetProviderCache();
    const warnings: string[] = [];
    await agentExecutor.execute(
      ctx(
        {
          providerId: 'claude',
          prompt: 'p',
          cwd: process.cwd(),
          timeoutMs: 5000,
          outputs: [{ name: 'PR_LINK' }],
        },
        {
          emitStdoutChunk: (line: string) => {
            warnings.push(line);
          },
        },
      ),
    );
    expect(warnings.some((w) => w.includes('[mcp-output]') && w.includes('HTTP transport'))).toBe(true);
    expect(lastRunnerOpts?.mcpConfigPath).toBeUndefined();
  });
});

describe('agentExecutor timeout wiring', () => {
  // Guards the actual bug fix: agent.ts must route cfg.timeoutMs through
  // resolveAgentTimeout before handing it to runProvider. A revert to the
  // raw `cfg.timeoutMs` would let a missing/zero value reach the runner's
  // `if (opts.timeoutMs > 0)` gate and arm no timeout at all.
  it('forwards a config-provided positive timeout to runProvider unchanged', async () => {
    await agentExecutor.execute(
      ctx({
        providerId: 'claude',
        prompt: 'p',
        cwd: process.cwd(),
        timeoutMs: 5000,
      }),
    );
    expect(lastRunnerOpts!.timeoutMs).toBe(5000);
  });

  it('substitutes the default timeout when config timeoutMs is 0', async () => {
    await agentExecutor.execute(
      ctx({
        providerId: 'claude',
        prompt: 'p',
        cwd: process.cwd(),
        timeoutMs: 0,
      }),
    );
    expect(lastRunnerOpts!.timeoutMs).toBe(DEFAULT_AGENT_TIMEOUT_MS);
  });

  it('substitutes the default timeout when config has no timeoutMs', async () => {
    await agentExecutor.execute(
      ctx({
        providerId: 'claude',
        prompt: 'p',
        cwd: process.cwd(),
      }),
    );
    expect(lastRunnerOpts!.timeoutMs).toBe(DEFAULT_AGENT_TIMEOUT_MS);
  });
});
