import { spawn } from 'node:child_process';
import type { RunnerOptions, RunnerResult } from '../../shared/types';
import { parserFactories } from './parsers/index';
import { resolveBin } from './loader';
import { runHttpProvider } from './http-runner';
import type { CliProviderManifest, ProviderManifest } from './types';
import { registerChild, unregisterChild } from '../child-registry';
import { buildChildEnv } from '../child-env';
import { startEgressProxy, type EgressProxy } from '../egress-proxy';

const SIGKILL_GRACE_MS = 2000;

/**
 * Resolve a CLI provider's argv from its manifest template + RunnerOptions.
 *
 * - `{prompt}` is substituted with `opts.prompt` (always present when
 *   `promptVia: 'arg'`). When `promptVia: 'stdin'`, args are passed through
 *   unchanged — the prompt is written to stdin instead.
 * - `{agent}` is an OPTIONAL flag-value placeholder: when `opts.agent` is a
 *   non-empty string, it's substituted in place; when missing, BOTH the
 *   `{agent}` token AND the immediately preceding arg (the flag name) are
 *   dropped. This lets a manifest declare `["--agent", "{agent}"]` and have
 *   the whole pair vanish when the user didn't pick one.
 * - `{mcpConfig}` follows the same drop-preceding-flag pattern as
 *   `{agent}`, fed by `opts.mcpConfigPath`. The expected manifest shape is
 *   the flag-pair form (`["--mcp-config", "{mcpConfig}"]`), NOT the
 *   embedded form (`--mcp-config={mcpConfig}`) — the drop-on-empty path is
 *   only well-defined for the pair form.
 * - `{profile}` follows the same optional flag-value placeholder pattern as
 *   `{agent}` and `{mcpConfig}`. This lets a manifest declare
 *   `["--profile", "{profile}"]` and have the whole pair vanish when the
 *   user didn't pick one.
 * - `{model}` follows the same optional flag-value placeholder pattern as
 *   `{profile}`. This lets a manifest declare `["--model", "{model}"]`
 *   and have the whole pair vanish when the user didn't pick a model.
 * - `{dangerousArgs}` is a standalone token that expands to ALL of
 *   `opts.dangerousArgs` (zero or more args) at its position. The runner
 *   supplies the manifest's `dangerousArgs` only when the node opted into
 *   the dangerous posture; otherwise `opts.dangerousArgs` is empty and the
 *   token expands to nothing. Putting it in the manifest (rather than a
 *   blind prepend) lets the manifest author place it correctly relative to
 *   any leading subcommand. Only the standalone token is supported.
 *
 * Pure; exported for tests.
 */
export function resolveCliArgs(
  args: readonly string[],
  opts: Pick<RunnerOptions, 'prompt' | 'agent' | 'profile' | 'model' | 'mcpConfigPath'> & {
    promptVia: 'arg' | 'stdin';
    /** Args to expand `{dangerousArgs}` into. Empty/undefined → token drops. */
    dangerousArgs?: readonly string[];
  },
): string[] {
  const out: string[] = [];
  const agent = typeof opts.agent === 'string' ? opts.agent.trim() : '';
  const mcpConfig =
    typeof opts.mcpConfigPath === 'string' ? opts.mcpConfigPath.trim() : '';
  const profile = typeof opts.profile === 'string' ? opts.profile.trim() : '';
  const model = typeof opts.model === 'string' ? opts.model.trim() : '';
  const dropPrecedingFlag = () => {
    const prev = out[out.length - 1];
    if (typeof prev === 'string' && prev.startsWith('-')) {
      out.pop();
    }
  };
  for (const raw of args) {
    if (raw === '{dangerousArgs}') {
      if (opts.dangerousArgs) out.push(...opts.dangerousArgs);
      continue;
    }
    if (raw === '{agent}') {
      if (agent.length === 0) {
        dropPrecedingFlag();
        continue;
      }
      out.push(agent);
      continue;
    }
    if (raw.includes('{agent}')) {
      // Embedded form (e.g. "--agent={agent}") — substitute in place when
      // set; when empty, drop just this token so an adjacent prompt stays put.
      if (agent.length === 0) continue;
      out.push(raw.replace(/\{agent\}/g, agent));
      continue;
    }
    if (raw === '{mcpConfig}') {
      if (mcpConfig.length === 0) {
        dropPrecedingFlag();
        continue;
      }
      out.push(mcpConfig);
      continue;
    }
    if (raw.includes('{mcpConfig}')) {
      // Embedded form is intentionally NOT supported with the drop-on-empty
      // rule (see docstring). Substitute when set so a manifest can still
      // opt into it; when empty, drop just this token to mirror {agent}.
      if (mcpConfig.length === 0) continue;
      out.push(raw.replace(/\{mcpConfig\}/g, mcpConfig));
      continue;
    }
    if (raw === '{profile}') {
      if (profile.length === 0) {
        dropPrecedingFlag();
        continue;
      }
      out.push(profile);
      continue;
    }
    if (raw.includes('{profile}')) {
      if (profile.length === 0) continue;
      out.push(raw.replace(/\{profile\}/g, profile));
      continue;
    }
    if (raw === '{model}') {
      if (model.length === 0) {
        dropPrecedingFlag();
        continue;
      }
      out.push(model);
      continue;
    }
    if (raw.includes('{model}')) {
      if (model.length === 0) continue;
      out.push(raw.replace(/\{model\}/g, model));
      continue;
    }
    if (opts.promptVia === 'arg' && raw.includes('{prompt}')) {
      out.push(raw.replace(/\{prompt\}/g, opts.prompt));
      continue;
    }
    out.push(raw);
  }
  return out;
}

/**
 * Decide whether a CLI provider's spawned child should run behind a per-run
 * egress filtering proxy. Returns the host allowlist to enforce when BOTH the
 * operator opted in (`INFLOOP_EGRESS_ENFORCE=1`) AND the manifest declares an
 * `egressAllowlist`; otherwise `null` — no proxy, unrestricted egress, the
 * default behaviour. A declared-but-empty allowlist (`[]`) is returned as-is:
 * it is a deliberate "no network" posture and the proxy will deny every host.
 *
 * Pure; exported for tests.
 */
export function resolveEgressEnforcement(
  manifest: CliProviderManifest,
  env: Record<string, string | undefined> = process.env,
): readonly string[] | null {
  if (env.INFLOOP_EGRESS_ENFORCE !== '1') return null;
  return manifest.egressAllowlist ?? null;
}

/**
 * Dispatch entry point. CLI manifests go through `runCliProvider` (spawn +
 * stdout line parser); HTTP manifests go through `runHttpProvider` (fetch +
 * SSE delta stream). Both produce the same `RunnerResult` shape.
 */
export async function runProvider(
  manifest: ProviderManifest,
  opts: RunnerOptions,
): Promise<RunnerResult> {
  if (manifest.transport === 'http') {
    return runHttpProvider(manifest, opts);
  }
  return runCliProvider(manifest, opts);
}

/**
 * Spawn a provider's CLI binary, stream stdout line-by-line through the
 * provider's parser, accumulate stdout/stderr, and enforce a per-iteration
 * timeout + external AbortSignal. Always resolves; never rejects.
 *
 * The spawn/process-group/timeout/abort scaffolding is provider-agnostic.
 * What changes per provider:
 *   - the binary (manifest.bin, env-overridable via INFLOOP_PROVIDER_BIN_<ID>)
 *   - argv (manifest.args with `{prompt}` substituted, or stdin delivery)
 *   - line parsing (manifest.outputFormat → parserFactories[key]())
 *
 * The parser is built fresh per invocation so any per-run state (e.g.
 * claude-stream-json's in-flight tool_use_id map) is isolated from other
 * concurrent CLI spawns in the same process — notably the `parallel` node.
 */
async function runCliProvider(
  manifest: CliProviderManifest,
  opts: RunnerOptions,
): Promise<RunnerResult> {
  const bin = resolveBin(manifest);
  // Loader normalizes a missing `promptVia` to 'arg', so we can trust it here.
  const promptVia = manifest.promptVia;
  // The dangerous arg set is injected only when the Agent node explicitly
  // opted in; otherwise `{dangerousArgs}` expands to nothing, so the CLI runs
  // with its normal permission posture. See AgentConfig.dangerouslySkipPermissions.
  const dangerousArgs =
    opts.dangerouslySkipPermissions === true
      ? manifest.dangerousArgs ?? []
      : [];
  const args = resolveCliArgs(manifest.args, {
    prompt: opts.prompt,
    agent: opts.agent,
    profile: opts.profile,
    model: opts.model,
    mcpConfigPath: opts.mcpConfigPath,
    dangerousArgs,
    promptVia,
  });
  const parserFactory = parserFactories[manifest.outputFormat];
  if (!parserFactory) {
    // Loader validates this, but guard runtime injection too.
    return {
      exitCode: null,
      stdout: '',
      stderr: `runProvider: unknown outputFormat "${manifest.outputFormat}"`,
      durationMs: 0,
      timedOut: false,
    };
  }
  const parser = parserFactory();

  // Egress enforcement (opt-in): when on, route the child's HTTP(S) traffic
  // through a per-run filtering proxy that permits only the manifest's
  // declared hosts. Started before the spawn; torn down in `finish()`.
  const egressAllowlist = resolveEgressEnforcement(manifest);
  let egressProxy: EgressProxy | null = null;
  if (egressAllowlist !== null) {
    try {
      egressProxy = await startEgressProxy(egressAllowlist);
    } catch (err) {
      // Fail closed: enforcement was requested but the filter could not start,
      // so refuse to run rather than spawn with unrestricted egress.
      return {
        exitCode: null,
        stdout: '',
        stderr: `runProvider(${manifest.id}): egress proxy failed to start: ${(err as Error).message}`,
        durationMs: 0,
        timedOut: false,
      };
    }
  }

  const startedAt = Date.now();

  return new Promise<RunnerResult>((resolve) => {
    // detached:true puts the child in its own process group so we can kill
    // the whole group (including grandchildren like `sleep`) on timeout/abort.
    // env: a scrubbed allowlist, NOT the inherited process.env — the CLI runs
    // untrusted, prompt-shaped code and must not see the orchestrator's
    // secrets (INFLOOP_API_TOKEN et al.). See lib/server/child-env.ts.
    // Explicit return-type annotation: the `stdio` tuple's first element is
    // a conditional and the options literal also carries `env`, which
    // together leave `spawn`'s overloads ambiguous and infer `never`.
    // Pinning the type keeps overload resolution stable.
    const child: ReturnType<typeof spawn> = spawn(bin, args, {
      cwd: opts.cwd,
      env: buildChildEnv({
        passthrough: manifest.envPassthrough,
        overrides: egressProxy?.childEnvOverrides(),
      }),
      stdio: [promptVia === 'stdin' ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      detached: true,
    });
    if (child.pid != null) registerChild(child.pid, { bin });

    if (promptVia === 'stdin' && child.stdin) {
      child.stdin.setDefaultEncoding('utf8');
      child.stdin.write(opts.prompt);
      child.stdin.end();
    }

    let stdout = '';
    let stderr = '';
    let lineBuf = '';
    let timedOut = false;
    // Last cost a parsed line reported. Provider result frames carry the
    // *cumulative* invocation cost (e.g. `total_cost_usd`), so the final
    // value seen — not a sum — is this invocation's total. Cross-invocation
    // accumulation is the run controller's job. Stays undefined for providers
    // that report no cost.
    let costUsd: number | undefined;
    let killTimer: NodeJS.Timeout | null = null;
    let timeoutTimer: NodeJS.Timeout | null = null;
    let settled = false;

    const cleanup = (): void => {
      if (killTimer) {
        clearTimeout(killTimer);
        killTimer = null;
      }
      if (timeoutTimer) {
        clearTimeout(timeoutTimer);
        timeoutTimer = null;
      }
      opts.signal.removeEventListener('abort', onAbort);
    };

    const killGroup = (signal: NodeJS.Signals): void => {
      if (child.pid == null) return;
      try {
        process.kill(-child.pid, signal);
      } catch {
        try {
          child.kill(signal);
        } catch {
          // ignore — already gone
        }
      }
    };

    const scheduleSigkill = (): void => {
      if (killTimer) return;
      killTimer = setTimeout(() => {
        killGroup('SIGKILL');
      }, SIGKILL_GRACE_MS);
    };

    const onTimeout = (): void => {
      timedOut = true;
      killGroup('SIGTERM');
      scheduleSigkill();
    };

    const onAbort = (): void => {
      killGroup('SIGTERM');
      scheduleSigkill();
    };

    if (opts.signal.aborted) {
      onAbort();
    } else {
      opts.signal.addEventListener('abort', onAbort, { once: true });
    }

    if (opts.timeoutMs > 0) {
      timeoutTimer = setTimeout(onTimeout, opts.timeoutMs);
    }

    child.stdout!.setEncoding('utf8');
    child.stdout!.on('data', (chunk: string) => {
      lineBuf += chunk;
      let nl: number;
      while ((nl = lineBuf.indexOf('\n')) !== -1) {
        const lineWithNl = lineBuf.slice(0, nl + 1);
        const lineTrimmed = lineBuf.slice(0, nl).trim();
        lineBuf = lineBuf.slice(nl + 1);
        if (lineTrimmed.length === 0) continue;

        const classified = parser(lineTrimmed);
        let emit = '';
        if (classified.kind === 'json') {
          emit = classified.text;
          if (typeof classified.costUsd === 'number') {
            costUsd = classified.costUsd;
          }
        } else {
          emit = lineWithNl;
        }
        if (emit.length > 0) {
          stdout += emit;
          opts.onStdoutChunk?.(emit);
        }
      }
    });

    child.stderr!.setEncoding('utf8');
    child.stderr!.on('data', (chunk: string) => {
      stderr += chunk;
    });

    const finish = (exitCode: number | null): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if (child.pid != null) unregisterChild(child.pid);
      // Single settle path — close the per-run proxy here (not in onAbort/
      // onTimeout) so it outlives the child until the process has exited.
      egressProxy?.close();
      resolve({
        exitCode,
        stdout,
        stderr,
        durationMs: Date.now() - startedAt,
        timedOut,
        costUsd,
      });
    };

    child.on('error', (err) => {
      stderr +=
        (stderr.length > 0 ? '\n' : '') +
        `runProvider(${manifest.id}) spawn error: ${err.message}`;
      finish(null);
    });

    child.on('close', (code) => {
      // Flush any trailing partial line so providers that don't end with a
      // newline (e.g. a one-line `codex exec` reply, or stdin-mode echo
      // tests) still surface their output.
      if (lineBuf.length > 0) {
        const tail = lineBuf;
        const trimmed = tail.trim();
        lineBuf = '';
        if (trimmed.length > 0) {
          const classified = parser(trimmed);
          const emit = classified.kind === 'json' ? classified.text : tail;
          if (classified.kind === 'json' && typeof classified.costUsd === 'number') {
            costUsd = classified.costUsd;
          }
          if (emit.length > 0) {
            stdout += emit;
            opts.onStdoutChunk?.(emit);
          }
        }
      }
      finish(code);
    });
  });
}
