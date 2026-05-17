/**
 * Per-run git worktree manager.
 *
 * Agent nodes that opt in via `useWorktree: true` ask the engine for a fresh
 * git worktree of their `cwd` so parallel agents can edit the same repo
 * without colliding. One instance is constructed per workflow run, hands out
 * worktree paths, and is cleaned up by the engine in the run's `finally`.
 *
 * Design choices:
 *
 * - **Path location**: `<repoRoot>/.infloop-worktrees/<runId>-<nodeId>-<rand>`,
 *   a sibling of `.git`, not inside it. Putting trees inside `.git/` collides
 *   with git's own `worktrees/` metadata namespace and can be wiped by `git
 *   clean -fdx`. The dir is auto-created; users may add `.infloop-worktrees/`
 *   to `.gitignore` if they want it ignored.
 *
 * - **Per-repo serialization**: `git worktree add` writes to `.git/worktrees/`
 *   and takes a lock; two concurrent invocations against the same repo can
 *   race on `index.lock`. The manager queues calls per repoRoot.
 *
 * - **Loop reuse**: a Loop body re-invokes the agent executor per iteration.
 *   If we created a fresh worktree each time, 100 iterations × 2 agents = 200
 *   trees. We cache by `nodeId` within a run and return the same path on
 *   repeat calls. Different `ref` on the same nodeId throws — that's a
 *   contradiction the user probably didn't mean.
 *
 * - **Cleanup**: `git worktree remove --force <path>` plus `git worktree
 *   prune` per repo. Falls back to `fs.rm -rf` if the git command fails so we
 *   don't leak directories on a corrupted repo.
 */

import { spawn } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import type { RunWorktrees } from '../shared/workflow';

interface CreateOpts {
  repoPath: string;
  ref?: string;
  nodeId: string;
}

interface Entry {
  /** Worktree path on disk. */
  path: string;
  /** repoRoot it belongs to — needed for `git worktree remove`. */
  repoRoot: string;
  /** ref it was based on; used to detect contradictory reuse within a run. */
  ref: string;
}

/** Run a command, capturing stdout/stderr. Resolves with exit code + output;
 * never rejects. Mirrors the style used in the provider runner. */
function execCapture(
  cmd: string,
  args: readonly string[],
  cwd: string,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout!.setEncoding('utf8');
    child.stdout!.on('data', (chunk: string) => (stdout += chunk));
    child.stderr!.setEncoding('utf8');
    child.stderr!.on('data', (chunk: string) => (stderr += chunk));
    child.on('error', (err) => {
      resolve({ code: null, stdout, stderr: stderr + err.message });
    });
    child.on('close', (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}

/** Resolve the top-level path of the git repo containing `repoPath`. Throws
 * when `repoPath` is not inside a git repo. */
export async function resolveRepoRoot(repoPath: string): Promise<string> {
  const res = await execCapture(
    'git',
    ['rev-parse', '--show-toplevel'],
    repoPath,
  );
  if (res.code !== 0) {
    const detail = res.stderr.trim() || res.stdout.trim() || `exit ${res.code}`;
    throw new Error(`not a git repository: ${repoPath} (${detail})`);
  }
  return res.stdout.trim();
}

export class RunWorktreesImpl implements RunWorktrees {
  private readonly runId: string;
  /** nodeId → Entry. The agent executor passes its own nodeId so Loop
   * iterations reuse the same worktree. */
  private entries = new Map<string, Entry>();
  /** repoRoot → tail of in-flight create() promises. `git worktree add` is
   * not concurrency-safe within a single repo. */
  private repoLocks = new Map<string, Promise<unknown>>();

  constructor(runId: string) {
    this.runId = runId;
  }

  async create(opts: CreateOpts): Promise<string> {
    const existing = this.entries.get(opts.nodeId);
    if (existing) {
      const want = (opts.ref ?? '').trim();
      if (want.length > 0 && want !== existing.ref) {
        throw new Error(
          `worktree for node "${opts.nodeId}" already exists at ${existing.path} based on "${existing.ref}", cannot rebase to "${want}" mid-run`,
        );
      }
      return existing.path;
    }

    const repoRoot = await resolveRepoRoot(opts.repoPath);
    return this.serialize(repoRoot, async () => {
      // Re-check after acquiring the lock — another node call may have
      // created the entry while we waited.
      const raced = this.entries.get(opts.nodeId);
      if (raced) return raced.path;

      const baseDir = path.join(repoRoot, '.infloop-worktrees');
      await fsp.mkdir(baseDir, { recursive: true });

      // Path is short enough to keep filesystem-happy: 8-char runId + nodeId
      // (already short) + 6-char random suffix.
      const shortRun = this.runId.replace(/-/g, '').slice(0, 8);
      const safeNode = opts.nodeId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40);
      const rand = Math.random().toString(36).slice(2, 8);
      const wtPath = path.join(baseDir, `${shortRun}-${safeNode}-${rand}`);

      const ref = opts.ref?.trim() ? opts.ref.trim() : 'HEAD';
      const res = await execCapture(
        'git',
        ['worktree', 'add', '--detach', wtPath, ref],
        repoRoot,
      );
      if (res.code !== 0) {
        const detail =
          res.stderr.trim() || res.stdout.trim() || `exit ${res.code}`;
        throw new Error(
          `git worktree add failed for ref "${ref}": ${detail}`,
        );
      }

      this.entries.set(opts.nodeId, {
        path: wtPath,
        repoRoot,
        ref,
      });
      return wtPath;
    });
  }

  async cleanupAll(): Promise<void> {
    // Snapshot entries up front — cleanupAll() should be idempotent and not
    // try to remove the same worktree twice if called more than once.
    const all = [...this.entries.values()];
    this.entries.clear();

    // Run cleanups serialized per repoRoot (same lock as create), but parallel
    // across distinct repos.
    const byRepo = new Map<string, Entry[]>();
    for (const e of all) {
      const list = byRepo.get(e.repoRoot) ?? [];
      list.push(e);
      byRepo.set(e.repoRoot, list);
    }

    await Promise.all(
      [...byRepo.entries()].map(([repoRoot, entries]) =>
        this.serialize(repoRoot, async () => {
          for (const e of entries) {
            const remove = await execCapture(
              'git',
              ['worktree', 'remove', '--force', e.path],
              repoRoot,
            );
            if (remove.code !== 0) {
              // Best-effort: nuke the dir so we don't leak. `git worktree
              // prune` below will clean up the dangling metadata.
              await fsp.rm(e.path, { recursive: true, force: true }).catch(() => {});
            }
          }
          await execCapture('git', ['worktree', 'prune'], repoRoot);
        }),
      ),
    );
  }

  /** Serialize `task` against any in-flight task for the same repoRoot.
   * Returns the task's result. Errors propagate to the caller; subsequent
   * tasks still run. */
  private async serialize<T>(repoRoot: string, task: () => Promise<T>): Promise<T> {
    const prev = this.repoLocks.get(repoRoot) ?? Promise.resolve();
    let resolveSlot!: () => void;
    const slot = new Promise<void>((r) => (resolveSlot = r));
    const chain = prev.then(() => slot);
    this.repoLocks.set(repoRoot, chain);
    try {
      await prev;
      return await task();
    } finally {
      resolveSlot();
      // Drop the chain pointer if no one else has appended after us. Keeps
      // the map from accumulating one entry per (repoRoot, run) pair across
      // long-lived instances.
      if (this.repoLocks.get(repoRoot) === chain) {
        this.repoLocks.delete(repoRoot);
      }
    }
  }
}
