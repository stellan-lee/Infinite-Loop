/*
 * Startup configuration validation — fail fast on a malformed config value.
 *
 * Every numeric `INFLOOP_*` knob is parsed lazily, per-use, by its own module
 * (`run-controller.ts`, `cost-budget.ts`, `rate-limiter.ts`, ...). Each of
 * those parsers is deliberately forgiving: a non-numeric, negative, or
 * otherwise out-of-range value silently falls back to a default so a stray
 * value can never crash a hot path.
 *
 * That forgiveness is a hazard at the one boundary it should not be: a safety
 * ceiling. `INFLOOP_MAX_TOTAL_COST_USD=abc` does not fail — it falls back to
 * `0`, and `0` for a cost ceiling means *disabled*. An operator who fat-fingers
 * their spend cap gets a process that runs unattended with no spend cap and
 * nothing said so. For a tool whose whole purpose is bounding unattended cost
 * and runaway loops, "your safety limit silently isn't on" is exactly the
 * failure mode that must never be silent.
 *
 * This module is the startup gate that closes that hole. It does NOT change
 * any runtime parser — those stay lazy and forgiving so an env change still
 * applies to the next run without a restart. It is a separate, once-per-boot
 * pass, run from `server.ts` alongside the network-posture fail-closed check:
 * if any known config var is *set to a malformed value*, the process refuses
 * to start with a per-variable explanation.
 *
 * Three states, only one of which is an error:
 *   - unset / empty   → fine; the documented default applies.
 *   - a valid value   → fine (including a literal `0` where `0` is legal).
 *   - a malformed value → fatal: refuse to start.
 *
 * The validator is intentionally *at least as strict as* every runtime parser,
 * never looser. It rejects trailing garbage and exotic forms (`100x`, `5e6`,
 * `0x10`) that `parseInt`/`parseFloat` would silently coerce to a surprising
 * number, and it rejects a fractional value for a whole-number knob (a count
 * of runs, files, events or bytes) even though a few runtime parsers — those
 * built on `Number()` + `Math.floor()` — would quietly floor it. Both are the
 * safe direction: the validator never accepts a value a runtime parser would
 * reject, so it can never let a silent fallback through; at worst it asks an
 * operator to rewrite an ambiguous or fractional value in the plain decimal
 * form the docs already use.
 *
 * Each spec below matches its runtime parser on the dimension that decides a
 * silent fallback — whether `0` is a legal value — and is otherwise only
 * tighter. Keep a spec in sync if its runtime parser's `0`/negative rule
 * changes. `PORT`, `HOST` and `INFLOOP_API_TOKEN` are deliberately out of
 * scope: the first two are not safety knobs and the network-posture gate in
 * `server.ts` already covers `HOST`, and `INFLOOP_API_TOKEN` is a free-form
 * secret with no malformed-value failure mode.
 */

/** Accepts a plain decimal integer with an optional sign. Rejects trailing
 *  garbage, exponents and hex — see the strictness note in the module header. */
const INTEGER_RE = /^-?\d+$/;
/** Accepts a plain decimal number with an optional sign and fractional part. */
const FLOAT_RE = /^-?\d+(?:\.\d+)?$/;

/** `0` is a meaningful, legal value (it disables the ceiling); only a
 *  negative or non-numeric value is malformed. */
type NumericRule = 'non-negative' | 'positive';

interface NumericSpec {
  name: string;
  kind: 'integer' | 'float';
  rule: NumericRule;
  /** Unit / semantics, appended to the error so the fix is obvious. */
  note: string;
}

interface EnumSpec {
  name: string;
  kind: 'enum';
  /** Permitted values, compared case-insensitively (matches `logger.ts`). */
  values: readonly string[];
}

interface FlagSpec {
  name: string;
  kind: 'flag';
  /** What enabling the flag does, appended to the error. */
  note: string;
}

type ConfigSpec = NumericSpec | EnumSpec | FlagSpec;

/*
 * The known config surface. Every entry corresponds to a documented variable
 * in `docs/configuration.md`; the comment names the runtime parser whose
 * accept/reject rule this entry mirrors.
 */
const CONFIG_SPECS: readonly ConfigSpec[] = [
  // run-controller.ts · resolveRunBudget — `0` disables the ceiling.
  {
    name: 'INFLOOP_MAX_RUN_NODE_EXECUTIONS',
    kind: 'integer',
    rule: 'non-negative',
    note: 'node-execution steps per run; 0 disables the cap',
  },
  {
    name: 'INFLOOP_MAX_RUN_DURATION_MS',
    kind: 'integer',
    rule: 'non-negative',
    note: 'milliseconds of wall-clock per run; 0 disables the cap',
  },
  {
    name: 'INFLOOP_MAX_RUN_COST_USD',
    kind: 'float',
    rule: 'non-negative',
    note: 'US dollars per run; 0 disables the cap',
  },
  // cost-budget.ts · resolveCostCeiling — `0` disables the ceiling.
  {
    name: 'INFLOOP_MAX_TOTAL_COST_USD',
    kind: 'float',
    rule: 'non-negative',
    note: 'US dollars across all runs since startup; 0 disables the ceiling',
  },
  // workflow-engine.ts / settings-store.ts · readMaxConcurrentFromEnv —
  // `<= 0` falls back, so a positive integer is required.
  {
    name: 'INFLOOP_MAX_CONCURRENT_RUNS',
    kind: 'integer',
    rule: 'positive',
    note: 'concurrently-running workflows',
  },
  // event-memory-budget.ts · resolveTotalEventCap — `<= 0` falls back; an
  // unbounded buffer is the bug this guards, so `0` is not a valid "disable".
  {
    name: 'INFLOOP_MAX_TOTAL_EVENT_BUFFER',
    kind: 'integer',
    rule: 'positive',
    note: 'workflow events buffered in memory across all runs',
  },
  // run-store.ts · historyLimit — `<= 0` falls back.
  {
    name: 'INFLOOP_RUN_HISTORY_LIMIT',
    kind: 'integer',
    rule: 'positive',
    note: 'persisted runs kept per workflow',
  },
  // audit-log.ts · maxBytes — `<= 0` falls back.
  {
    name: 'INFLOOP_AUDIT_MAX_BYTES',
    kind: 'integer',
    rule: 'positive',
    note: 'bytes before the audit log rotates',
  },
  // audit-log.ts · maxFiles — `< 1` falls back.
  {
    name: 'INFLOOP_AUDIT_MAX_FILES',
    kind: 'integer',
    rule: 'positive',
    note: 'rotated audit-log generations to keep',
  },
  // rate-limiter.ts · envLimit — `<= 0` falls back.
  {
    name: 'INFLOOP_WEBHOOK_RATE_LIMIT',
    kind: 'integer',
    rule: 'positive',
    note: 'webhook deliveries accepted per minute, per trigger',
  },
  {
    name: 'INFLOOP_LOGIN_RATE_LIMIT',
    kind: 'integer',
    rule: 'positive',
    note: 'browser-login attempts accepted per minute',
  },
  // logger.ts · threshold — anything outside this set falls back to `info`.
  {
    name: 'INFLOOP_LOG_LEVEL',
    kind: 'enum',
    values: ['debug', 'info', 'warn', 'error'],
  },
  // server.ts · evaluatePosture — compared `=== '1'`, so any other value
  // silently reads as "off". For a flag that relaxes security containment a
  // silent "off" is a footgun worth catching.
  {
    name: 'INFLOOP_EGRESS_ENFORCE',
    kind: 'flag',
    note: 'route CLI-provider egress through the per-run filtering proxy',
  },
  {
    name: 'INFLOOP_ALLOW_INSECURE',
    kind: 'flag',
    note: 'allow a network-reachable bind with no API token',
  },
];

/** Human-readable description of what a numeric spec accepts. */
function describeNumeric(spec: NumericSpec): string {
  const type = spec.kind === 'integer' ? 'integer' : 'number';
  return `a ${spec.rule} ${type} (${spec.note})`;
}

/** Validate one variable. Returns an error string, or `null` when the value
 *  is absent or acceptable. */
function checkSpec(spec: ConfigSpec, rawValue: string | undefined): string | null {
  // Absent or whitespace-only is "unset": the documented default applies.
  const raw = (rawValue ?? '').trim();
  if (raw === '') return null;

  if (spec.kind === 'enum') {
    if (spec.values.includes(raw.toLowerCase())) return null;
    return `${spec.name} is set to "${raw}" — expected one of: ${spec.values.join(', ')}.`;
  }

  if (spec.kind === 'flag') {
    if (raw === '0' || raw === '1') return null;
    return `${spec.name} is set to "${raw}" — expected 0 or 1 (1 = ${spec.note}).`;
  }

  const expected = describeNumeric(spec);
  const re = spec.kind === 'integer' ? INTEGER_RE : FLOAT_RE;
  if (!re.test(raw)) {
    return `${spec.name} is set to "${raw}" — expected ${expected}.`;
  }
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    return `${spec.name} is set to "${raw}" — expected ${expected}.`;
  }
  if (spec.rule === 'non-negative' && n < 0) {
    return `${spec.name} is set to "${raw}" — expected ${expected}.`;
  }
  if (spec.rule === 'positive' && n <= 0) {
    return `${spec.name} is set to "${raw}" — expected ${expected}.`;
  }
  return null;
}

/**
 * Validate every known config variable against `env`. Returns one error
 * string per malformed variable; an empty array means the config is sound.
 *
 * Pure — reads only the passed `env` map and never touches `process.env` or
 * exits the process. `server.ts` owns the fail-fast decision so this stays
 * trivially unit-testable.
 */
export function validateConfig(
  env: Record<string, string | undefined>,
): string[] {
  const errors: string[] = [];
  for (const spec of CONFIG_SPECS) {
    const error = checkSpec(spec, env[spec.name]);
    if (error) errors.push(error);
  }
  return errors;
}
