import type {
  NodeExecutor,
  NodeExecutorContext,
  NodeExecutorResult,
  StructuredOutputConfig,
} from '../../shared/workflow';
import { getProvider } from '../providers/loader';
import { runHttpStructuredOutput } from '../providers/http-runner';

export const DEFAULT_STRUCTURED_OUTPUT_TIMEOUT_MS = 30 * 60 * 1000;

function isSchema(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function resolveTimeout(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : DEFAULT_STRUCTURED_OUTPUT_TIMEOUT_MS;
}

function errorResult(
  message: string,
  result?: { stderr: string; exitCode: number | null; durationMs: number; timedOut: boolean },
): NodeExecutorResult {
  return {
    outputs: {
      errorMessage: message,
      ...(result ? {
        stderr: result.stderr,
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        timedOut: result.timedOut,
      } : {}),
    },
    branch: 'error',
  };
}

/** Executes exactly one strict JSON Schema completion through an HTTP provider. */
export const structuredOutputExecutor: NodeExecutor = {
  async execute(ctx: NodeExecutorContext): Promise<NodeExecutorResult> {
    if (ctx.signal.aborted) return errorResult('aborted');

    const cfg = ctx.config as StructuredOutputConfig;
    if (
      !cfg ||
      typeof cfg.providerId !== 'string' ||
      cfg.providerId.length === 0 ||
      typeof cfg.prompt !== 'string' ||
      cfg.prompt.length === 0 ||
      !isSchema(cfg.schema)
    ) {
      return errorResult('invalid structured-output config');
    }

    const provider = await getProvider(cfg.providerId);
    if (!provider) return errorResult(`unknown provider: ${cfg.providerId}`);
    if (provider.transport !== 'http') {
      return errorResult(`structured-output node requires an HTTP provider: ${cfg.providerId}`);
    }

    const result = await runHttpStructuredOutput(
      provider,
      {
        prompt: cfg.prompt,
        cwd: ctx.defaultCwd,
        timeoutMs: resolveTimeout(cfg.timeoutMs),
        signal: ctx.signal,
        profile: cfg.profile,
      },
      cfg.schema,
    );
    if (result.exitCode !== 0 || result.timedOut) {
      return errorResult(
        result.timedOut
          ? 'structured-output request timed out'
          : result.stderr || 'structured-output request failed',
        result,
      );
    }

    let value: unknown;
    try {
      value = JSON.parse(result.stdout);
    } catch (err) {
      return errorResult(
        `structured-output response was not valid JSON: ${(err as Error).message}`,
        result,
      );
    }
    return {
      outputs: {
        result: value,
        durationMs: result.durationMs,
        timedOut: result.timedOut,
      },
      branch: 'next',
    };
  },
};
