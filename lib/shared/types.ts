/*
 * Compat shim. The new contract lives in `lib/shared/workflow.ts`. This file
 * re-exports the few legacy types still consumed by reused modules
 * (provider runner, conditions/*) so they don't have to be rewritten.
 */

export type {
  SentinelConfig,
  CommandConfig,
  JudgeConfig,
  AgentMessage,
} from './workflow';

import type { AgentMessage } from './workflow';

export type ConditionType = 'sentinel' | 'command' | 'judge';

export interface IterationRecord {
  n: number;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  conditionMet?: boolean;
  conditionDetail?: string;
}

export interface RunnerOptions {
  prompt: string;
  /** Role-preserving conversation for OpenAI-compatible HTTP providers. */
  messages?: AgentMessage[];
  cwd: string;
  timeoutMs: number;
  signal: AbortSignal;
  onStdoutChunk?: (line: string) => void;
  /** Optional profile name. HTTP providers use it as the `model` field
   * in the request body (falling back to the manifest's `defaultProfile`).
   * CLI providers may substitute it into argv via a `{profile}` placeholder. */
  profile?: string;
  /** Optional model name for CLI providers. CLI providers may substitute it
   * into argv via a `{model}` placeholder; empty/undefined strips the flag pair.
   * HTTP providers ignore. */
  model?: string;
  /** Optional subagent name. CLI providers may substitute it into argv via
   * a `{agent}` placeholder; empty/undefined strips both the placeholder and
   * the immediately preceding arg (the flag name). HTTP providers ignore. */
  agent?: string;
  /** Optional absolute path to an MCP config file the CLI should load.
   * CLI providers may substitute it into argv via a `{mcpConfig}`
   * placeholder; empty/undefined strips both the placeholder and the
   * immediately preceding arg (the flag name) — same shape as `{agent}`.
   * HTTP providers ignore. */
  mcpConfigPath?: string;
  /** When true, the runner injects the provider manifest's `dangerousArgs`
   * (e.g. `--dangerously-skip-permissions` for the Claude CLI) in place of
   * the `{dangerousArgs}` placeholder. Default/false runs the CLI with its
   * normal permission posture. CLI providers only; HTTP providers ignore. */
  dangerouslySkipPermissions?: boolean;
}

export interface RunnerResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  /** Cumulative cost in USD the provider reported for this invocation, when
   * it reports one. CLI providers surface it from their result frame (e.g.
   * the `claude` CLI's `total_cost_usd`); HTTP providers do not report cost
   * and leave this undefined. Feeds the run-level cost budget. */
  costUsd?: number;
}

export interface ConditionStrategy {
  evaluate(
    iter: IterationRecord,
    cfg: unknown,
    cwd: string,
  ): Promise<{ met: boolean; detail: string }>;
}
