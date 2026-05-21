/*
 * Structured logger for server-side application diagnostics.
 *
 * Emits one JSON object per line so logs from a remote box stay greppable
 * and pipe cleanly into a log aggregator. `createLogger(scope)` mirrors the
 * `[scope]` text prefixes this codebase already used with bare `console.*`.
 *
 * Scope boundary — this is for `lib/server/**` diagnostic logging:
 *   - `server.ts` keeps plain `console.*` on purpose. Its output is the
 *     interactive CLI launch experience (ready banner, port-fallback notice,
 *     shutdown messages), not machine-parsed diagnostics.
 *   - `console.*` inside generated user-script strings (nodes/script.ts) is
 *     code handed to a child process, not logging — left untouched.
 *
 * Level threshold comes from `INFLOOP_LOG_LEVEL` (debug|info|warn|error,
 * default `info`) and is read per-call so tests and runtime config changes
 * take effect without a restart — matching how the rest of lib/server reads
 * env vars (see auth.ts, workflow-engine.ts).
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_RANK: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

/** Keys owned by the log record; a caller-supplied field cannot clobber them. */
const RESERVED_KEYS = new Set(['ts', 'level', 'scope', 'msg']);

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  /**
   * Return a logger that merges `boundFields` into every line it emits — the
   * standard structured-logger child pattern. Used to bind a `correlationId`
   * (or `runId`) once per ingress/run instead of threading it through every
   * `log.*` call. Per-call `fields` win over bound fields on a key clash;
   * reserved keys are dropped from both. Children compose: `a.child(x).child(y)`
   * carries `x` then `y`.
   */
  child(boundFields: Record<string, unknown>): Logger;
}

function threshold(): number {
  const raw = (process.env.INFLOOP_LOG_LEVEL ?? '').trim().toLowerCase();
  if (raw && raw in LEVEL_RANK) return LEVEL_RANK[raw as LogLevel];
  return LEVEL_RANK.info;
}

/** Errors JSON-stringify to `{}` — unfold them so the message and stack
 *  actually land in the log line. */
function normalizeField(value: unknown): unknown {
  if (value instanceof Error) {
    return { message: value.message, stack: value.stack };
  }
  return value;
}

function emit(
  level: LogLevel,
  scope: string,
  bound: Record<string, unknown> | undefined,
  msg: string,
  fields?: Record<string, unknown>,
): void {
  if (LEVEL_RANK[level] < threshold()) return;

  const record: Record<string, unknown> = {
    ts: new Date().toISOString(),
    level,
    scope,
    msg,
  };
  // Bound fields first, then per-call fields — so a per-call field wins on a
  // key clash. Reserved keys are dropped from both.
  for (const source of [bound, fields]) {
    if (!source) continue;
    for (const [key, value] of Object.entries(source)) {
      if (RESERVED_KEYS.has(key)) continue;
      record[key] = normalizeField(value);
    }
  }

  let line: string;
  try {
    line = JSON.stringify(record);
  } catch {
    // A circular or otherwise non-serializable field — never let logging
    // throw. Drop the fields and keep the core record.
    line = JSON.stringify({
      ts: record.ts,
      level,
      scope,
      msg,
      _logError: 'fields not serializable',
    });
  }

  // error/warn -> stderr, info/debug -> stdout: preserves the stream split
  // the pre-logger console.error/console.warn/console.log calls had.
  if (level === 'error' || level === 'warn') {
    console.error(line);
  } else {
    console.log(line);
  }
}

/** Create a logger bound to `scope` (e.g. 'trigger-queue'), which is emitted
 *  as the `scope` field on every line. `bound` fields (set via `child()`) are
 *  merged into every line beneath the per-call fields. */
export function createLogger(
  scope: string,
  bound?: Record<string, unknown>,
): Logger {
  return {
    debug: (msg, fields) => emit('debug', scope, bound, msg, fields),
    info: (msg, fields) => emit('info', scope, bound, msg, fields),
    warn: (msg, fields) => emit('warn', scope, bound, msg, fields),
    error: (msg, fields) => emit('error', scope, bound, msg, fields),
    child: (boundFields) => createLogger(scope, { ...bound, ...boundFields }),
  };
}
