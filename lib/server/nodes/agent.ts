import type {
  AgentConfig,
  NodeExecutor,
  NodeExecutorContext,
  NodeExecutorResult,
} from '../../shared/workflow';
import { getProvider } from '../providers/loader';
import { runProvider } from '../providers/runner';

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

export const agentExecutor: NodeExecutor = {
  async execute(ctx: NodeExecutorContext): Promise<NodeExecutorResult> {
    const cfg = ctx.config as AgentConfig;

    if (!isNonEmptyString(cfg?.providerId) || !isNonEmptyString(cfg?.prompt)) {
      return {
        outputs: { errorMessage: 'invalid agent config' },
        branch: 'error',
      };
    }

    const provider = await getProvider(cfg.providerId);
    if (!provider) {
      return {
        outputs: {
          errorMessage: `unknown provider: ${cfg.providerId}`,
        },
        branch: 'error',
      };
    }

    // cwd is only meaningful for CLI providers — they spawn a process there.
    // HTTP providers (Hermes etc.) just POST to a remote API, so we don't
    // require it; fall back to the engine's defaultCwd to satisfy the
    // RunnerOptions contract.
    if (provider.transport === 'cli' && !isNonEmptyString(cfg.cwd)) {
      return {
        outputs: { errorMessage: 'invalid agent config' },
        branch: 'error',
      };
    }

    const baseCwd = isNonEmptyString(cfg.cwd) ? cfg.cwd : ctx.defaultCwd;
    let spawnCwd = baseCwd;
    let worktreePath: string | undefined;

    // Worktree is CLI-only. HTTP providers don't have a process cwd, so the
    // option is silently a no-op for them — matches how `cwd` itself works.
    // We require `ctx.runWorktrees`: a unit-test context that hand-builds the
    // ctx without an engine and asks for a worktree gets a clear error rather
    // than a silent skip.
    if (cfg.useWorktree === true && provider.transport === 'cli') {
      if (!ctx.runWorktrees) {
        return {
          outputs: { errorMessage: 'useWorktree set but no run worktree manager available' },
          branch: 'error',
        };
      }
      if (!isNonEmptyString(ctx.nodeId)) {
        return {
          outputs: { errorMessage: 'useWorktree set but node id is unknown' },
          branch: 'error',
        };
      }
      try {
        worktreePath = await ctx.runWorktrees.create({
          repoPath: baseCwd,
          ref: cfg.worktreeRef,
          nodeId: ctx.nodeId,
        });
        spawnCwd = worktreePath;
        // Surface the path in the live console so the user knows which dir
        // the agent is editing. Useful when triaging "where did my changes
        // go?" after an isolated run.
        ctx.emitStdoutChunk?.(`[worktree] ${worktreePath}\n`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          outputs: { errorMessage: `worktree setup failed: ${message}` },
          branch: 'error',
        };
      }
    }

    const result = await runProvider(provider, {
      prompt: cfg.prompt,
      cwd: spawnCwd,
      timeoutMs: cfg.timeoutMs,
      signal: ctx.signal,
      onStdoutChunk: ctx.emitStdoutChunk,
      profile: cfg.profile,
      agent: cfg.agent,
    });

    const outputs: Record<string, unknown> = {
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      timedOut: result.timedOut,
    };
    if (worktreePath) outputs.worktreePath = worktreePath;

    const success = result.exitCode === 0 && !result.timedOut;
    return { outputs, branch: success ? 'next' : 'error' };
  },
};
