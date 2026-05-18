import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type {
  AgentConfig,
  AgentOutputDecl,
  NodeExecutor,
  NodeExecutorContext,
  NodeExecutorResult,
} from '../../shared/workflow';
import { getProvider } from '../providers/loader';
import { runProvider } from '../providers/runner';
import {
  consumeOutputs,
  mintToken,
  type OutputDecl,
} from '../mcp/output-registry';
import { getBoundPort } from '../runtime';

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

function declaredOutputs(cfg: AgentConfig): AgentOutputDecl[] {
  if (!Array.isArray(cfg.outputs)) return [];
  return cfg.outputs.filter(
    (d): d is AgentOutputDecl =>
      !!d && typeof d === 'object' && isNonEmptyString(d.name),
  );
}

/**
 * Materialize a per-invocation `mcp.json` referencing the in-process
 * SetOutput route. URL host is hard-coded to 127.0.0.1 (NOT process.env.HOST,
 * which defaults to 0.0.0.0); the child process talks back over loopback.
 * Port is read from the runtime module, not env — server.ts may fall through
 * on EADDRINUSE.
 *
 * Returns the absolute path to the temp file plus the temp dir holding it,
 * so the caller can rm -rf the dir in its `finally`.
 */
async function writeMcpConfig(token: string): Promise<{
  configPath: string;
  tempDir: string;
}> {
  const port = getBoundPort();
  const url = `http://127.0.0.1:${port}/api/mcp/output`;
  const tempDir = await fs.mkdtemp(path.join(tmpdir(), 'infloop-mcp-'));
  const configPath = path.join(tempDir, 'mcp.json');
  const payload = {
    mcpServers: {
      infinite_loop_output: {
        type: 'http',
        url,
        headers: { Authorization: `Bearer ${token}` },
      },
    },
  };
  await fs.writeFile(configPath, JSON.stringify(payload, null, 2), 'utf8');
  return { configPath, tempDir };
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

    // Mint a SetOutput MCP token + write a per-invocation mcp.json when the
    // node declares outputs AND the provider is CLI-transport (HTTP
    // providers have no `--mcp-config` analog). Both runId and nodeId are
    // required to scope the token; if either is missing (hand-rolled test
    // ctx) we silently skip the MCP injection — same posture as worktrees.
    const decls = declaredOutputs(cfg);
    if (decls.length > 0 && provider.transport !== 'cli') {
      // The user declared outputs but the provider can't accept an injected
      // MCP server. Warn so a missing `{{node.X}}` downstream isn't silently
      // empty.
      ctx.emitStdoutChunk?.(
        `[mcp-output] outputs declared but provider "${cfg.providerId}" is HTTP transport; declared outputs will not be populated\n`,
      );
    }
    const wantMcp =
      decls.length > 0 &&
      provider.transport === 'cli' &&
      isNonEmptyString(ctx.runId) &&
      isNonEmptyString(ctx.nodeId);

    let token: string | null = null;
    let mcpTempDir: string | null = null;
    let mcpConfigPath: string | undefined;
    if (wantMcp) {
      try {
        const outputDecls: OutputDecl[] = decls.map((d) => ({
          name: d.name,
          description: d.description,
        }));
        token = mintToken({
          runId: ctx.runId!,
          nodeId: ctx.nodeId!,
          outputDecls,
        });
        const { configPath, tempDir } = await writeMcpConfig(token);
        mcpConfigPath = configPath;
        mcpTempDir = tempDir;
      } catch (err) {
        // Best-effort: if we can't mint a token or write the temp file (e.g.
        // server.ts hasn't bound a port yet in some test harness), fall back
        // to running the agent without the MCP server. The node's declared
        // outputs simply won't be populated. Surface a warning chunk so the
        // user sees why. Revoke the token if it was minted before the write
        // failed — leaves no entry for releaseRun to sweep later.
        if (token) consumeOutputs(token);
        const message = err instanceof Error ? err.message : String(err);
        ctx.emitStdoutChunk?.(`[mcp-output] setup failed, continuing without: ${message}\n`);
        token = null;
        mcpTempDir = null;
        mcpConfigPath = undefined;
      }
    }

    try {
      const result = await runProvider(provider, {
        prompt: cfg.prompt,
        cwd: spawnCwd,
        timeoutMs: cfg.timeoutMs,
        signal: ctx.signal,
        onStdoutChunk: ctx.emitStdoutChunk,
        profile: cfg.profile,
        agent: cfg.agent,
        mcpConfigPath,
      });

      // Drain SetOutput state AFTER runProvider has resolved — never in a
      // signal callback. Cancellation preserves whatever the agent recorded
      // before SIGTERM/SIGKILL by merging the drained map into the partial
      // outputs alongside stdout/stderr.
      const consumed = token ? consumeOutputs(token) : {};

      const outputs: Record<string, unknown> = {
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        timedOut: result.timedOut,
        // Declared outputs spread last for grep-ability. Reserved-name
        // validation at workflow save guarantees they cannot collide with
        // the runtime keys above.
        ...consumed,
      };
      if (worktreePath) outputs.worktreePath = worktreePath;

      const success = result.exitCode === 0 && !result.timedOut;
      return { outputs, branch: success ? 'next' : 'error' };
    } finally {
      // Belt-and-braces: if runProvider threw before consumeOutputs ran in
      // the try-block, drain here to revoke the token. Safe to call twice
      // since the registry deletes on first consume.
      if (token) consumeOutputs(token);
      if (mcpTempDir) {
        try {
          await fs.rm(mcpTempDir, { recursive: true, force: true });
        } catch {
          // Tempfile cleanup is best-effort.
        }
      }
    }
  },
};
