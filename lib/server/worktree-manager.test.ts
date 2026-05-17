import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { RunWorktreesImpl, resolveRepoRoot } from './worktree-manager';

function git(args: string[], cwd: string): void {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (res.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${res.stderr || res.stdout}`);
  }
}

let repoDir: string;

beforeEach(() => {
  repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'infinite-loop-wt-test-'));
  git(['init', '--initial-branch=main'], repoDir);
  // Need a config so commit works in CI sandboxes.
  git(['config', 'user.email', 'test@example.com'], repoDir);
  git(['config', 'user.name', 'Test'], repoDir);
  fs.writeFileSync(path.join(repoDir, 'README.md'), 'hello\n');
  git(['add', '.'], repoDir);
  git(['commit', '-m', 'initial'], repoDir);
});

afterEach(async () => {
  await fsp.rm(repoDir, { recursive: true, force: true });
});

describe('resolveRepoRoot', () => {
  it('returns the top-level path for a repo subdir', async () => {
    const sub = path.join(repoDir, 'sub');
    fs.mkdirSync(sub);
    const root = await resolveRepoRoot(sub);
    // macOS may prefix /private to tmp paths in git's output; compare realpath.
    expect(fs.realpathSync(root)).toBe(fs.realpathSync(repoDir));
  });

  it('throws when the path is not a git repo', async () => {
    const notRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'not-a-repo-'));
    try {
      await expect(resolveRepoRoot(notRepo)).rejects.toThrow(/not a git repository/);
    } finally {
      await fsp.rm(notRepo, { recursive: true, force: true });
    }
  });
});

describe('RunWorktreesImpl', () => {
  it('creates a worktree under .infloop-worktrees and cleans it up', async () => {
    const wt = new RunWorktreesImpl('run-aaaaaaaa');
    const wtPath = await wt.create({ repoPath: repoDir, nodeId: 'agent-1' });

    const expectedBase = fs.realpathSync(path.join(repoDir, '.infloop-worktrees'));
    expect(fs.realpathSync(wtPath).startsWith(expectedBase)).toBe(true);
    expect(fs.existsSync(wtPath)).toBe(true);
    expect(fs.existsSync(path.join(wtPath, 'README.md'))).toBe(true);

    await wt.cleanupAll();
    expect(fs.existsSync(wtPath)).toBe(false);
  });

  it('reuses the same worktree for repeated calls with the same nodeId', async () => {
    const wt = new RunWorktreesImpl('run-bbbbbbbb');
    const first = await wt.create({ repoPath: repoDir, nodeId: 'agent-1' });
    const second = await wt.create({ repoPath: repoDir, nodeId: 'agent-1' });
    expect(second).toBe(first);
    await wt.cleanupAll();
  });

  it('throws when a repeated call asks for a different ref', async () => {
    const wt = new RunWorktreesImpl('run-cccccccc');
    await wt.create({ repoPath: repoDir, nodeId: 'agent-1', ref: 'HEAD' });
    git(['checkout', '-b', 'feature'], repoDir);
    await expect(
      wt.create({ repoPath: repoDir, nodeId: 'agent-1', ref: 'feature' }),
    ).rejects.toThrow(/already exists/);
    await wt.cleanupAll();
  });

  it('serializes concurrent creates on the same repo without errors', async () => {
    const wt = new RunWorktreesImpl('run-dddddddd');
    const paths = await Promise.all([
      wt.create({ repoPath: repoDir, nodeId: 'agent-a' }),
      wt.create({ repoPath: repoDir, nodeId: 'agent-b' }),
      wt.create({ repoPath: repoDir, nodeId: 'agent-c' }),
    ]);
    expect(new Set(paths).size).toBe(3);
    for (const p of paths) expect(fs.existsSync(p)).toBe(true);
    await wt.cleanupAll();
    for (const p of paths) expect(fs.existsSync(p)).toBe(false);
  });

  it('uses the requested ref as the worktree base', async () => {
    git(['checkout', '-b', 'feature'], repoDir);
    fs.writeFileSync(path.join(repoDir, 'feature.txt'), 'on feature\n');
    git(['add', '.'], repoDir);
    git(['commit', '-m', 'feature commit'], repoDir);
    git(['checkout', 'main'], repoDir);

    const wt = new RunWorktreesImpl('run-eeeeeeee');
    const wtPath = await wt.create({
      repoPath: repoDir,
      nodeId: 'agent-1',
      ref: 'feature',
    });
    expect(fs.existsSync(path.join(wtPath, 'feature.txt'))).toBe(true);
    await wt.cleanupAll();
  });

  it('cleanupAll is idempotent', async () => {
    const wt = new RunWorktreesImpl('run-ffffffff');
    await wt.create({ repoPath: repoDir, nodeId: 'agent-1' });
    await wt.cleanupAll();
    // Second call should not throw even though there's nothing to remove.
    await wt.cleanupAll();
  });
});
