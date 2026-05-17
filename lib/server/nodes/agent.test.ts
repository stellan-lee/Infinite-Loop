import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { agentExecutor } from './agent';
import { _resetProviderCache } from '../providers/loader';
import { RunWorktreesImpl } from '../worktree-manager';
import type { NodeExecutorContext } from '../../shared/workflow';

const here = dirname(fileURLToPath(import.meta.url));
const FAKE_BIN = resolve(here, '../../../tests/fixtures/fake-claude.sh');

let providersDir: string;
let prevProvidersDir: string | undefined;

beforeEach(() => {
  providersDir = fs.mkdtempSync(path.join(os.tmpdir(), 'infinite-loop-agent-test-'));
  prevProvidersDir = process.env.INFLOOP_PROVIDERS_DIR;
  process.env.INFLOOP_PROVIDERS_DIR = providersDir;
  fs.writeFileSync(
    path.join(providersDir, 'claude.json'),
    JSON.stringify({
      id: 'claude',
      label: 'Claude',
      description: 'fake',
      bin: 'claude',
      args: ['{prompt}'],
      outputFormat: 'plain',
    }),
  );
  _resetProviderCache();
});

afterEach(async () => {
  if (prevProvidersDir === undefined) {
    delete process.env.INFLOOP_PROVIDERS_DIR;
  } else {
    process.env.INFLOOP_PROVIDERS_DIR = prevProvidersDir;
  }
  await fsp.rm(providersDir, { recursive: true, force: true });
  _resetProviderCache();
});

function ctx(config: unknown): NodeExecutorContext {
  return {
    config,
    scope: {},
    defaultCwd: process.cwd(),
    signal: new AbortController().signal,
  };
}

describe('agentExecutor', () => {
  it('routes invalid configs to the error branch', async () => {
    const out = await agentExecutor.execute(ctx({}));
    expect(out.branch).toBe('error');
    expect(out.outputs).toMatchObject({ errorMessage: expect.any(String) });
  });

  it('errors when the providerId is unknown', async () => {
    const out = await agentExecutor.execute(
      ctx({
        providerId: 'does-not-exist',
        prompt: 'p',
        cwd: '/tmp',
        timeoutMs: 1000,
      }),
    );
    expect(out.branch).toBe('error');
    expect(out.outputs).toMatchObject({
      errorMessage: expect.stringMatching(/unknown provider/),
    });
  });

  it('runs the resolved provider and routes to next on exit 0', async () => {
    process.env.INFLOOP_PROVIDER_BIN_CLAUDE = FAKE_BIN;
    process.env.FAKE_STDOUT_LINES = 'ok';
    try {
      const out = await agentExecutor.execute(
        ctx({
          providerId: 'claude',
          prompt: 'p',
          cwd: process.cwd(),
          timeoutMs: 5000,
        }),
      );
      expect(out.branch).toBe('next');
      expect(out.outputs).toMatchObject({ exitCode: 0 });
    } finally {
      delete process.env.INFLOOP_PROVIDER_BIN_CLAUDE;
      delete process.env.FAKE_STDOUT_LINES;
    }
  });

  describe('useWorktree', () => {
    let repoDir: string;

    beforeEach(() => {
      repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'infinite-loop-agent-wt-'));
      const git = (args: string[]): void => {
        const res = spawnSync('git', args, { cwd: repoDir, encoding: 'utf8' });
        if (res.status !== 0) throw new Error(res.stderr || res.stdout);
      };
      git(['init', '--initial-branch=main']);
      git(['config', 'user.email', 'test@example.com']);
      git(['config', 'user.name', 'Test']);
      fs.writeFileSync(path.join(repoDir, 'README.md'), 'hello\n');
      git(['add', '.']);
      git(['commit', '-m', 'initial']);
    });

    afterEach(async () => {
      await fsp.rm(repoDir, { recursive: true, force: true });
    });

    it('spawns the CLI inside a worktree path and surfaces it in outputs', async () => {
      process.env.INFLOOP_PROVIDER_BIN_CLAUDE = FAKE_BIN;
      process.env.FAKE_STDOUT_LINES = 'ok';
      const runWorktrees = new RunWorktreesImpl('run-aaaaaaaa');
      try {
        const out = await agentExecutor.execute({
          nodeId: 'agent-1',
          config: {
            providerId: 'claude',
            prompt: 'p',
            cwd: repoDir,
            timeoutMs: 5000,
            useWorktree: true,
          },
          scope: {},
          defaultCwd: process.cwd(),
          signal: new AbortController().signal,
          runWorktrees,
        });
        expect(out.branch).toBe('next');
        const outputs = out.outputs as { worktreePath?: string; exitCode?: number };
        expect(outputs.exitCode).toBe(0);
        expect(typeof outputs.worktreePath).toBe('string');
        const expectedBase = fs.realpathSync(
          path.join(repoDir, '.infloop-worktrees'),
        );
        expect(
          fs.realpathSync(outputs.worktreePath!).startsWith(expectedBase),
        ).toBe(true);
      } finally {
        await runWorktrees.cleanupAll();
        delete process.env.INFLOOP_PROVIDER_BIN_CLAUDE;
        delete process.env.FAKE_STDOUT_LINES;
      }
    });

    it('errors out cleanly when cwd is not a git repo', async () => {
      process.env.INFLOOP_PROVIDER_BIN_CLAUDE = FAKE_BIN;
      const notRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'not-a-repo-'));
      const runWorktrees = new RunWorktreesImpl('run-bbbbbbbb');
      try {
        const out = await agentExecutor.execute({
          nodeId: 'agent-1',
          config: {
            providerId: 'claude',
            prompt: 'p',
            cwd: notRepo,
            timeoutMs: 5000,
            useWorktree: true,
          },
          scope: {},
          defaultCwd: process.cwd(),
          signal: new AbortController().signal,
          runWorktrees,
        });
        expect(out.branch).toBe('error');
        expect(out.outputs).toMatchObject({
          errorMessage: expect.stringMatching(/worktree setup failed/),
        });
      } finally {
        await runWorktrees.cleanupAll();
        await fsp.rm(notRepo, { recursive: true, force: true });
        delete process.env.INFLOOP_PROVIDER_BIN_CLAUDE;
      }
    });

    it('errors when useWorktree is set but no runWorktrees is in context', async () => {
      process.env.INFLOOP_PROVIDER_BIN_CLAUDE = FAKE_BIN;
      try {
        const out = await agentExecutor.execute(
          ctx({
            providerId: 'claude',
            prompt: 'p',
            cwd: repoDir,
            timeoutMs: 5000,
            useWorktree: true,
          }),
        );
        expect(out.branch).toBe('error');
        expect(out.outputs).toMatchObject({
          errorMessage: expect.stringMatching(/no run worktree manager/),
        });
      } finally {
        delete process.env.INFLOOP_PROVIDER_BIN_CLAUDE;
      }
    });
  });
});
