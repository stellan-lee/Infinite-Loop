import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  NodeExecutor,
  NodeExecutorContext,
  NodeExecutorResult,
  ScriptConfig,
  ScriptLanguage,
} from '../../shared/workflow';
import { registerChild, unregisterChild } from '../child-registry';
import { buildChildEnv } from '../child-env';

const DEFAULT_TIMEOUT_MS = 60_000;
const SIGKILL_GRACE_MS = 2000;

/** Sentinel emitted by the harness on its own stdout line. The line is
 * stripped from the user-visible stdout before storage so a trailing
 * "__INFLOOP_RESULT__:…" doesn't leak into the run console. */
const RESULT_SENTINEL = '__INFLOOP_RESULT__:';

/** Resolve the interpreter binary. Env vars take precedence so users can
 * point Bun at a specific install (matches `INFLOOP_CLAUDE_BIN` precedent). */
export function resolveInterpreter(language: ScriptLanguage): string {
  if (language === 'ts') return process.env.INFLOOP_BUN_BIN || 'bun';
  return process.env.INFLOOP_PYTHON_BIN || 'python3';
}

function isScriptConfig(cfg: unknown): cfg is ScriptConfig {
  if (typeof cfg !== 'object' || cfg === null) return false;
  const c = cfg as { language?: unknown; code?: unknown };
  return (
    (c.language === 'ts' || c.language === 'py') && typeof c.code === 'string'
  );
}

function extFor(language: ScriptLanguage): string {
  return language === 'ts' ? 'ts' : 'py';
}

/** Compose the wrapper script: user code first (defining `run`), then a
 * tiny harness that reads JSON args from stdin, invokes `run(...)`, and
 * emits the result on a single stdout line prefixed with RESULT_SENTINEL.
 * Exported for tests. */
export function buildWrapperSource(
  language: ScriptLanguage,
  userCode: string,
  argNames: readonly string[],
): string {
  const argsJson = JSON.stringify(argNames);
  if (language === 'ts') {
    // Bun executes .ts files as ES modules, so `function run` is module-
    // scoped — NOT on globalThis. The harness references it by name; the
    // declaration is hoisted so order with the user code doesn't matter.
    // `typeof` on an undeclared identifier returns "undefined" without
    // throwing a ReferenceError, which gives us a clean "missing run"
    // diagnostic instead of a stack trace.
    return (
      userCode +
      '\n// @ts-nocheck\ntry {\n' +
      '  const __raw = await Bun.stdin.text();\n' +
      '  const __payload = __raw.length > 0 ? JSON.parse(__raw) : {};\n' +
      `  const __names = ${argsJson};\n` +
      '  const __args = __names.map((n) => __payload[n] ?? "");\n' +
      '  if (typeof run !== "function") {\n' +
      '    throw new Error("script must define a top-level `run` function");\n' +
      '  }\n' +
      '  const __result = await Promise.resolve(run.apply(null, __args));\n' +
      `  process.stdout.write("${RESULT_SENTINEL}" + JSON.stringify(__result ?? {}) + "\\n");\n` +
      '} catch (err) {\n' +
      '  console.error((err && err.stack) ? err.stack : String(err));\n' +
      '  process.exit(1);\n' +
      '}\n'
    );
  }
  // Python — need the user's top-level `def run` to be in scope, then call
  // it. `globals()` lookup keeps the harness oblivious to the user's
  // function arity beyond positional arg expansion.
  return (
    userCode +
    '\n\nif __name__ == "__main__" or True:\n' +
    '    import sys as _sys, json as _json\n' +
    '    _raw = _sys.stdin.read()\n' +
    '    _payload = _json.loads(_raw) if _raw else {}\n' +
    `    _names = ${argsJson}\n` +
    '    _args = [_payload.get(n, "") for n in _names]\n' +
    '    _fn = globals().get("run")\n' +
    '    if not callable(_fn):\n' +
    '        raise RuntimeError("script must define a top-level `run` function")\n' +
    '    _result = _fn(*_args)\n' +
    `    _sys.stdout.write("${RESULT_SENTINEL}" + _json.dumps(_result if _result is not None else {}) + "\\n")\n`
  );
}

/** Pull the result JSON off the harness's sentinel line. Returns the
 * sanitized stdout (with the sentinel line removed) and the parsed result
 * object, or `undefined` if no sentinel was found / it didn't parse. */
export function extractResult(stdout: string): {
  sanitizedStdout: string;
  result?: Record<string, unknown>;
} {
  const lines = stdout.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed.startsWith(RESULT_SENTINEL)) continue;
    const json = trimmed.slice(RESULT_SENTINEL.length);
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch {
      // Sentinel was emitted but its payload didn't parse — leave the line
      // in the visible stdout for debugging.
      return { sanitizedStdout: stdout };
    }
    lines.splice(i, 1);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return {
        sanitizedStdout: lines.join('\n'),
        result: parsed as Record<string, unknown>,
      };
    }
    return { sanitizedStdout: lines.join('\n') };
  }
  return { sanitizedStdout: stdout };
}

interface SpawnResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  durationMs: number;
  timedOut: boolean;
  spawnError?: string;
}

function runInterpreter(
  bin: string,
  args: readonly string[],
  cwd: string,
  stdinPayload: string,
  timeoutMs: number,
  signal: AbortSignal,
  onStdoutChunk?: (line: string) => void,
): Promise<SpawnResult> {
  const startedAt = Date.now();

  return new Promise<SpawnResult>((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      // env: a scrubbed allowlist, NOT the inherited process.env — inline
      // scripts run untrusted, user-authored code and must not see the
      // orchestrator's secrets. A script with a legitimate need for a host
      // var (a venv, an API key) gets it via INFLOOP_CHILD_ENV_PASSTHROUGH.
      // See lib/server/child-env.ts.
      child = spawn(bin, args, {
        cwd,
        env: buildChildEnv(),
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: true,
      });
      if (child.pid != null) registerChild(child.pid, { bin });
    } catch (err) {
      resolve({
        stdout: '',
        stderr: '',
        exitCode: null,
        durationMs: Date.now() - startedAt,
        timedOut: false,
        spawnError: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    let stdout = '';
    let stderr = '';
    let lineBuf = '';
    let timedOut = false;
    let killTimer: NodeJS.Timeout | null = null;
    let timeoutTimer: NodeJS.Timeout | null = null;
    let settled = false;
    let spawnError: string | undefined;

    const cleanup = (): void => {
      if (killTimer) {
        clearTimeout(killTimer);
        killTimer = null;
      }
      if (timeoutTimer) {
        clearTimeout(timeoutTimer);
        timeoutTimer = null;
      }
      signal.removeEventListener('abort', onAbort);
    };

    const killGroup = (sig: NodeJS.Signals): void => {
      if (child.pid == null) return;
      try {
        process.kill(-child.pid, sig);
      } catch {
        try {
          child.kill(sig);
        } catch {
          // already gone
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

    if (signal.aborted) {
      onAbort();
    } else {
      signal.addEventListener('abort', onAbort, { once: true });
    }

    if (timeoutMs > 0) {
      timeoutTimer = setTimeout(onTimeout, timeoutMs);
    }

    if (child.stdin) {
      child.stdin.setDefaultEncoding('utf8');
      child.stdin.on('error', () => {});
      if (stdinPayload.length > 0) {
        child.stdin.write(stdinPayload);
      }
      child.stdin.end();
    }

    child.stdout!.setEncoding('utf8');
    child.stdout!.on('data', (chunk: string) => {
      lineBuf += chunk;
      let nl: number;
      while ((nl = lineBuf.indexOf('\n')) !== -1) {
        const lineWithNl = lineBuf.slice(0, nl + 1);
        lineBuf = lineBuf.slice(nl + 1);
        stdout += lineWithNl;
        // Suppress the harness's result sentinel from the live console so
        // the user-visible log stays clean (the parsed result lands on
        // scope under the declared output names anyway).
        if (!lineWithNl.startsWith(RESULT_SENTINEL)) {
          onStdoutChunk?.(lineWithNl);
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
      if (lineBuf.length > 0) {
        stdout += lineBuf;
        if (!lineBuf.startsWith(RESULT_SENTINEL)) {
          onStdoutChunk?.(lineBuf);
        }
        lineBuf = '';
      }
      resolve({
        stdout,
        stderr,
        exitCode,
        durationMs: Date.now() - startedAt,
        timedOut,
        spawnError,
      });
    };

    child.on('error', (err) => {
      spawnError = err.message;
      stderr += (stderr.length > 0 ? '\n' : '') + `spawn error: ${err.message}`;
      finish(null);
    });

    child.on('close', (code) => {
      finish(code);
    });
  });
}

export const scriptExecutor: NodeExecutor = {
  async execute(ctx: NodeExecutorContext): Promise<NodeExecutorResult> {
    const cfg = ctx.config;
    if (!isScriptConfig(cfg)) {
      return {
        outputs: { errorMessage: 'invalid script config' },
        branch: 'error',
      };
    }

    if (ctx.signal.aborted) {
      return {
        outputs: { errorMessage: 'aborted' },
        branch: 'error',
      };
    }

    const language = cfg.language;
    const code = cfg.code ?? '';
    const inputs: Record<string, string> = cfg.inputs && typeof cfg.inputs === 'object' ? cfg.inputs : {};
    const declaredOutputs: string[] = Array.isArray(cfg.outputs) ? cfg.outputs : [];
    const argNames = Object.keys(inputs);
    const stdinPayload = JSON.stringify(inputs);

    const cwd = typeof cfg.cwd === 'string' && cfg.cwd.length > 0
      ? cfg.cwd
      : ctx.defaultCwd;
    const timeoutMs =
      typeof cfg.timeoutMs === 'number' && cfg.timeoutMs >= 0
        ? cfg.timeoutMs
        : DEFAULT_TIMEOUT_MS;

    let tmpDir: string | undefined;
    try {
      tmpDir = await mkdtemp(join(tmpdir(), 'infinite-loop-script-'));
      const file = join(tmpDir, `script.${extFor(language)}`);
      const source = buildWrapperSource(language, code, argNames);
      await writeFile(file, source, 'utf8');

      const bin = resolveInterpreter(language);
      const args = [file];

      const r = await runInterpreter(
        bin,
        args,
        cwd,
        stdinPayload,
        timeoutMs,
        ctx.signal,
        ctx.emitStdoutChunk,
      );

      const { sanitizedStdout, result } = extractResult(r.stdout);

      const outputs: Record<string, unknown> = {
        stdout: sanitizedStdout,
        stderr: r.stderr,
        exitCode: r.exitCode,
        durationMs: r.durationMs,
        timedOut: r.timedOut,
        language,
      };
      if (result) {
        // Copy declared outputs in declaration order so a workflow author
        // can reason about the scope shape from the config alone. Missing
        // declared outputs become empty strings — the "string" return
        // type contract is best-effort, not enforced.
        for (const name of declaredOutputs) {
          const v = result[name];
          outputs[name] = typeof v === 'string' ? v : v == null ? '' : JSON.stringify(v);
        }
      }
      if (r.spawnError) {
        outputs.errorMessage = r.spawnError;
      }

      const success = r.exitCode === 0 && !r.timedOut && !r.spawnError;
      return { outputs, branch: success ? 'next' : 'error' };
    } catch (err) {
      return {
        outputs: {
          errorMessage:
            err instanceof Error ? err.message : 'unknown script error',
        },
        branch: 'error',
      };
    } finally {
      if (tmpDir) {
        rm(tmpDir, { recursive: true, force: true }).catch(() => {});
      }
    }
  },
};
