/*
 * burn-in-driver.ts — automated driver for the production burn-in's
 * cost-budget phase (docs/burn-in.md Phase 3.3).
 *
 * Phase 3.3 verifies the highest-blast-radius control Infinite Loop ships:
 * the process-wide cost ceiling (INFLOOP_MAX_TOTAL_COST_USD) that stops a
 * runaway, unattended loop from spending an unbounded provider bill. It is
 * also the one phase the burn-in has never run end to end — it needs a
 * credentialed `claude` provider and real spend, which Run 1 (local, no
 * provider auth) could not supply. This script makes that verification fast,
 * controlled, and repeatable, so the gap closes the moment a credentialed
 * staging host exists.
 *
 * It drives the running stack over HTTP only and imports no app code: it
 * cannot drift with internal refactors and can run from the host, from inside
 * the container, or from a remote box — against any deployment exposing /api.
 *
 * What it does:
 *   1. PREFLIGHT — /api/health is ok; /api/metrics authenticates; the cost
 *      budget is actually enabled (infloop_cost_budget_limit_usd > 0 — a `0`
 *      ceiling, or a typo in the env var, would make the whole phase pass
 *      vacuously); the probe workflow's provider CLI is on PATH; the costed
 *      probe workflow (deploy/burn-in-cost-workflow.json) is installed.
 *   2. DRIVE (only with --confirm-spend — this phase spends real money) —
 *      fire the probe workflow one run at a time, waiting for each to settle
 *      and scraping infloop_cost_budget_spent_usd between runs, until the
 *      admission gate refuses a run with HTTP 503. Hard-capped by --max-runs.
 *   3. REPORT — a Phase 3.3 checklist an operator can paste into BURN-IN.md:
 *      costed runs ran, spend crossed 80% of the ceiling, spend exceeded the
 *      ceiling, a run aborted mid-flight when the budget tripped, and
 *      POST /api/run was refused with 503 once exhausted.
 *
 * This is a verification tool, not a load generator: runs are sequential and
 * the budget itself is the natural backstop, but --max-runs is a hard cap so
 * a misconfigured ceiling cannot turn this script into the runaway it tests.
 *
 * Note on credentials: /api/providers reports a CLI provider "available" when
 * its binary is on PATH — it does NOT prove the CLI is authenticated. If the
 * `claude` CLI is present but not logged in, preflight passes and the drive
 * surfaces it as runs that fail without recording cost; the script aborts
 * with a clear message rather than looping.
 *
 * Usage:
 *   bun run burn-in -- --confirm-spend [options]
 *   bun deploy/burn-in-driver.ts --help
 *
 * Options:
 *   --base-url <url>      App base URL (default http://localhost:8080).
 *   --token <token>       API bearer token. Falls back to $INFLOOP_API_TOKEN.
 *   --prometheus <url>    Optional Prometheus base URL; when given, preflight
 *                         checks the cost alert rules are loaded and the
 *                         report prints their live alert state.
 *   --max-runs <n>        Hard cap on runs fired (default 200).
 *   --prompt <text>       Override the probe prompt (default: the workflow's).
 *   --workflow <path>     Probe workflow JSON (default: the file beside this
 *                         script, deploy/burn-in-cost-workflow.json).
 *   --poll-timeout <s>    Per-run settle-wait timeout in seconds (default 240).
 *   --confirm-spend       Required to run the costed drive. Without it the
 *                         script stops after preflight.
 *   --preflight-only      Run preflight and stop, even with --confirm-spend.
 *   --help, -h            Print this help.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/* ── constants ─────────────────────────────────────────────────────────── */

const DEFAULT_BASE_URL = 'http://localhost:8080';
const DEFAULT_MAX_RUNS = 200;
const DEFAULT_POLL_TIMEOUT_S = 240;
/** Prometheus alert at 80% of the ceiling; mirrors prometheus-alerts.yml. */
const NEAR_LIMIT_RATIO = 0.8;
const RUN_POLL_INTERVAL_MS = 2000;
/** Abort if no provider cost has registered after this many settled runs. */
const NO_COST_ABORT_AFTER_RUNS = 3;
/** Abort if this many runs fail for a reason unrelated to the cost budget. */
const NON_BUDGET_FAILURE_ABORT = 3;
/** The two cost alerts docs/burn-in.md Phase 3.3 expects to fire. */
const COST_ALERTS = [
  'InfiniteLoopCostBudgetNearLimit',
  'InfiniteLoopCostBudgetExhausted',
] as const;

/* ── options / argument parsing ────────────────────────────────────────── */

export interface DriverOptions {
  baseUrl: string;
  /** Token from --token only; $INFLOOP_API_TOKEN fallback is applied in main. */
  tokenFromArg?: string;
  prometheusUrl?: string;
  maxRuns: number;
  /** Undefined → main resolves it next to this script. */
  workflowPath?: string;
  promptOverride?: string;
  confirmSpend: boolean;
  preflightOnly: boolean;
  pollTimeoutMs: number;
}

/** Thrown for bad CLI input; `--help` throws it with the HELP sentinel. */
export class UsageError extends Error {}
const HELP_SENTINEL = '__help__';

export function parseArgs(argv: string[]): DriverOptions {
  const opts: DriverOptions = {
    baseUrl: DEFAULT_BASE_URL,
    maxRuns: DEFAULT_MAX_RUNS,
    confirmSpend: false,
    preflightOnly: false,
    pollTimeoutMs: DEFAULT_POLL_TIMEOUT_S * 1000,
  };

  const value = (i: number, flag: string): string => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) {
      throw new UsageError(`option ${flag} needs a value`);
    }
    return v;
  };
  const positive = (raw: string, flag: string): number => {
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) {
      throw new UsageError(`option ${flag} needs a positive number, got "${raw}"`);
    }
    return n;
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--base-url':
        opts.baseUrl = value(i, arg).replace(/\/+$/, '');
        i++;
        break;
      case '--token':
        opts.tokenFromArg = value(i, arg);
        i++;
        break;
      case '--prometheus':
        opts.prometheusUrl = value(i, arg).replace(/\/+$/, '');
        i++;
        break;
      case '--max-runs':
        opts.maxRuns = Math.floor(positive(value(i, arg), arg));
        i++;
        break;
      case '--workflow':
        opts.workflowPath = value(i, arg);
        i++;
        break;
      case '--prompt':
        opts.promptOverride = value(i, arg);
        i++;
        break;
      case '--poll-timeout':
        opts.pollTimeoutMs = positive(value(i, arg), arg) * 1000;
        i++;
        break;
      case '--confirm-spend':
        opts.confirmSpend = true;
        break;
      case '--preflight-only':
        opts.preflightOnly = true;
        break;
      case '--help':
      case '-h':
        throw new UsageError(HELP_SENTINEL);
      default:
        throw new UsageError(`unknown option: ${arg}`);
    }
  }
  return opts;
}

/* ── pure helpers (exported for the test) ──────────────────────────────── */

/**
 * Read a single unlabeled metric from a Prometheus text exposition. The
 * cost-budget gauges (infloop_cost_budget_spent_usd / _limit_usd) carry no
 * labels, so a flat `name <value>` line scan is enough; labeled series and
 * `#`-comment lines are skipped. Returns undefined if the metric is absent.
 */
export function readMetric(exposition: string, name: string): number | undefined {
  for (const line of exposition.split('\n')) {
    if (line.startsWith('#') || line.trim() === '') continue;
    const m = line.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s+(-?[0-9.eE+]+)\s*$/);
    if (m && m[1] === name) {
      const v = Number(m[2]);
      return Number.isFinite(v) ? v : undefined;
    }
  }
  return undefined;
}

/**
 * Whether a run's failure message names the cost budget. run-controller.ts's
 * `recordCost` settles a budget-tripped run with a message containing the
 * literal "cost budget" (both the per-run and the process-wide trip). A
 * failure that does not match is unrelated — e.g. a provider error. The match
 * is kept exact so an unrelated message that merely contains "budget" (a
 * future event-buffer message, say) is not misclassified as a cost trip.
 */
export function isBudgetFailure(message: string | undefined): boolean {
  return typeof message === 'string' && /cost budget/i.test(message);
}

export interface Phase33Observations {
  /** Configured ceiling (infloop_cost_budget_limit_usd). */
  limitUsd: number;
  /** Spend before the first run (process may have spent before the drive). */
  baselineSpentUsd: number;
  /** Spend after the last run. */
  finalSpentUsd: number;
  /** Runs accepted (HTTP 202) and settled. */
  runsExecuted: number;
  /** A scrape observed spend at or past 80% of the ceiling. */
  sawNearLimit: boolean;
  /** A scrape observed spend strictly past the ceiling. */
  sawExhausted: boolean;
  /** A run settled `failed` with a cost-budget message (mid-run trip). */
  midRunTrip: boolean;
  /** A POST /api/run was refused with HTTP 503 (admission gate). */
  saw503: boolean;
}

export interface Phase33Check {
  label: string;
  pass: boolean;
  detail: string;
}

function usd(n: number, dp = 4): string {
  return `$${n.toFixed(dp)}`;
}

/**
 * Turn the drive's observations into the docs/burn-in.md Phase 3.3 checklist.
 * Each check maps to one expected behaviour of the cost budget; `allPass` is
 * the phase verdict.
 */
export function evaluatePhase33(o: Phase33Observations): {
  checks: Phase33Check[];
  allPass: boolean;
} {
  const spendRose = o.runsExecuted > 0 && o.finalSpentUsd > o.baselineSpentUsd;
  const checks: Phase33Check[] = [
    {
      label: 'Costed runs executed (provider reported cost)',
      pass: spendRose,
      detail: `${o.runsExecuted} run(s); spend ${usd(o.baselineSpentUsd)} → ${usd(o.finalSpentUsd)}`,
    },
    {
      // Verifies the spend *metric* crossed 80% — not that the
      // InfiniteLoopCostBudgetNearLimit alert fired (that has a 5m `for:`
      // window a fast drive can outrun; check its live state with --prometheus).
      label: `Spend crossed ${Math.round(NEAR_LIMIT_RATIO * 100)}% of the ceiling (near-limit metric threshold)`,
      pass: o.sawNearLimit,
      detail: o.limitUsd > 0
        ? `ceiling ${usd(o.limitUsd, 2)}, ${Math.round(NEAR_LIMIT_RATIO * 100)}% = ${usd(o.limitUsd * NEAR_LIMIT_RATIO)}`
        : 'ceiling not enabled',
    },
    {
      label: 'Spend exceeded the ceiling (exhausted)',
      pass: o.sawExhausted,
      detail: `final ${usd(o.finalSpentUsd)} vs ceiling ${usd(o.limitUsd, 2)}`,
    },
    {
      label: 'A run aborted mid-flight at a costed node when the budget tripped',
      pass: o.midRunTrip,
      detail: o.midRunTrip
        ? 'a run settled failed with a cost-budget message'
        : 'no mid-run cost-budget abort observed',
    },
    {
      label: 'POST /api/run refused with HTTP 503 once the budget was exhausted',
      pass: o.saw503,
      detail: o.saw503
        ? 'admission gate returned 503'
        : 'no 503 observed within --max-runs',
    },
  ];
  return { checks, allPass: checks.every((c) => c.pass) };
}

/* ── probe workflow ────────────────────────────────────────────────────── */

interface ProbeWorkflow {
  id: string;
  name: string;
  nodes: Array<{ id?: string; type?: string; config?: Record<string, unknown> }>;
  edges: unknown[];
  inputs?: Array<{ name?: unknown }>;
}

function loadWorkflow(path: string): ProbeWorkflow {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(`cannot read probe workflow ${path}: ${(err as Error).message}`);
  }
  const w = parsed as Record<string, unknown>;
  if (
    !w ||
    typeof w.id !== 'string' ||
    typeof w.name !== 'string' ||
    !Array.isArray(w.nodes) ||
    !Array.isArray(w.edges)
  ) {
    throw new Error(`probe workflow ${path} is missing id/name/nodes/edges`);
  }
  return w as unknown as ProbeWorkflow;
}

/** Distinct provider ids referenced by the workflow's agent nodes. */
function providerIds(workflow: ProbeWorkflow): string[] {
  const ids = new Set<string>();
  for (const node of workflow.nodes) {
    if (node.type !== 'agent') continue;
    const id = node.config?.providerId;
    if (typeof id === 'string' && id.length > 0) ids.add(id);
  }
  return [...ids];
}

/* ── HTTP ──────────────────────────────────────────────────────────────── */

interface ApiResult {
  status: number;
  body: string;
  /** Parsed JSON, or undefined when the body is empty or not JSON. */
  json: unknown;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

async function apiCall(
  opts: DriverOptions,
  token: string,
  path: string,
  init?: { method?: string; body?: string },
): Promise<ApiResult> {
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  if (init?.body !== undefined) headers['content-type'] = 'application/json';
  let res: Response;
  try {
    res = await fetch(`${opts.baseUrl}${path}`, {
      method: init?.method ?? 'GET',
      headers,
      body: init?.body,
    });
  } catch (err) {
    throw new Error(`request to ${path} failed: ${(err as Error).message}`);
  }
  const body = await res.text();
  let json: unknown;
  try {
    json = body ? JSON.parse(body) : undefined;
  } catch {
    json = undefined; // /api/metrics returns text, not JSON — expected.
  }
  return { status: res.status, body, json };
}

/** GET a Prometheus JSON API path. Returns undefined on any error. */
async function promGet(base: string, path: string): Promise<unknown> {
  try {
    const res = await fetch(`${base}${path}`);
    if (!res.ok) return undefined;
    return await res.json();
  } catch {
    return undefined;
  }
}

/* ── preflight ─────────────────────────────────────────────────────────── */

interface PreflightResult {
  limitUsd: number;
  baselineSpentUsd: number;
}

async function preflight(
  opts: DriverOptions,
  token: string,
  workflow: ProbeWorkflow,
): Promise<PreflightResult> {
  console.log('Preflight');

  // 1. Health.
  const health = await apiCall(opts, token, '/api/health');
  const healthStatus =
    health.json && typeof health.json === 'object'
      ? (health.json as Record<string, unknown>).status
      : undefined;
  if (health.status !== 200 || healthStatus !== 'ok') {
    throw new Error(
      `/api/health is not ok (HTTP ${health.status}, status="${String(healthStatus)}")`,
    );
  }
  console.log('  [ok]   /api/health → ok');

  // 2. Metrics endpoint authenticates, and the cost budget is enabled.
  const metrics = await apiCall(opts, token, '/api/metrics');
  if (metrics.status === 401) {
    throw new Error('/api/metrics returned 401 — the API token is wrong or missing');
  }
  if (metrics.status !== 200) {
    throw new Error(`/api/metrics returned HTTP ${metrics.status}`);
  }
  const limitUsd = readMetric(metrics.body, 'infloop_cost_budget_limit_usd');
  const baselineSpentUsd =
    readMetric(metrics.body, 'infloop_cost_budget_spent_usd') ?? 0;
  if (limitUsd === undefined) {
    throw new Error(
      'infloop_cost_budget_limit_usd is not exposed — cannot verify the cost budget',
    );
  }
  if (limitUsd <= 0) {
    throw new Error(
      'the process-wide cost budget is disabled (infloop_cost_budget_limit_usd = 0). ' +
        'Set INFLOOP_MAX_TOTAL_COST_USD to a low figure (docs/burn-in.md Phase 0) and restart.',
    );
  }
  console.log(
    `  [ok]   /api/metrics → cost ceiling ${usd(limitUsd, 2)}, spent so far ${usd(baselineSpentUsd)}`,
  );

  // 3. The probe workflow's provider CLI is on PATH.
  const wanted = providerIds(workflow);
  if (wanted.length === 0) {
    throw new Error('probe workflow has no agent node — it would incur no cost');
  }
  const providers = await apiCall(opts, token, '/api/providers');
  if (providers.status !== 200 || !providers.json || typeof providers.json !== 'object') {
    throw new Error(`/api/providers returned HTTP ${providers.status}`);
  }
  const list = (providers.json as { providers?: unknown }).providers;
  const byId = new Map<string, Record<string, unknown>>();
  if (Array.isArray(list)) {
    for (const p of list) {
      if (p && typeof p === 'object' && typeof (p as { id?: unknown }).id === 'string') {
        byId.set((p as { id: string }).id, p as Record<string, unknown>);
      }
    }
  }
  for (const id of wanted) {
    const provider = byId.get(id);
    if (!provider) {
      throw new Error(`probe workflow needs provider "${id}" — not found on /api/providers`);
    }
    const available = provider.available === true;
    if (!available) {
      const health2 = provider.health as { message?: unknown } | undefined;
      throw new Error(
        `provider "${id}" is not available: ${String(health2?.message ?? 'unknown')}. ` +
          'docs/burn-in.md Prerequisites: bake the provider CLI into the image.',
      );
    }
  }
  console.log(
    `  [ok]   /api/providers → ${wanted.join(', ')} present ` +
      '(note: a CLI being on PATH does not prove it is authenticated)',
  );

  // 4. Install / update the probe workflow.
  const existing = await apiCall(
    opts,
    token,
    `/api/workflows/${encodeURIComponent(workflow.id)}`,
  );
  const wfBody = JSON.stringify(workflow);
  if (existing.status === 404) {
    const created = await apiCall(opts, token, '/api/workflows', {
      method: 'POST',
      body: wfBody,
    });
    if (created.status !== 201) {
      throw new Error(
        `installing probe workflow failed: HTTP ${created.status} ${created.body}`,
      );
    }
    console.log(`  [ok]   probe workflow "${workflow.id}" installed`);
  } else if (existing.status === 200) {
    const updated = await apiCall(
      opts,
      token,
      `/api/workflows/${encodeURIComponent(workflow.id)}`,
      { method: 'PUT', body: wfBody },
    );
    if (updated.status !== 200) {
      throw new Error(
        `updating probe workflow failed: HTTP ${updated.status} ${updated.body}`,
      );
    }
    console.log(`  [ok]   probe workflow "${workflow.id}" updated to the shipped version`);
  } else {
    throw new Error(
      `probing workflow "${workflow.id}" returned HTTP ${existing.status}`,
    );
  }

  // --prompt is dropped by resolveRunInputs when the workflow declares no
  // matching input — warn rather than let it be silently ignored.
  if (opts.promptOverride !== undefined) {
    const declaresPrompt =
      Array.isArray(workflow.inputs) &&
      workflow.inputs.some((inp) => inp?.name === 'prompt');
    if (!declaresPrompt) {
      console.log(
        '  [warn] --prompt is set but the probe workflow declares no "prompt" ' +
          'input — it will be ignored',
      );
    }
  }

  // 5. Optional: the cost alert rules are loaded in Prometheus.
  if (opts.prometheusUrl) {
    const rules = await promGet(opts.prometheusUrl, '/api/v1/rules');
    const loaded = collectRuleNames(rules);
    const missing = COST_ALERTS.filter((a) => !loaded.has(a));
    if (missing.length > 0) {
      console.log(
        `  [warn] Prometheus is missing cost alert rule(s): ${missing.join(', ')}`,
      );
    } else {
      console.log(`  [ok]   Prometheus has both cost alert rules loaded`);
    }
  }

  console.log('');
  return { limitUsd, baselineSpentUsd };
}

/** Alert-rule names from a Prometheus /api/v1/rules response. */
function collectRuleNames(rules: unknown): Set<string> {
  const names = new Set<string>();
  const groups = (rules as { data?: { groups?: unknown } } | undefined)?.data?.groups;
  if (!Array.isArray(groups)) return names;
  for (const group of groups) {
    const groupRules = (group as { rules?: unknown }).rules;
    if (!Array.isArray(groupRules)) continue;
    for (const rule of groupRules) {
      const name = (rule as { name?: unknown }).name;
      if (typeof name === 'string') names.add(name);
    }
  }
  return names;
}

/* ── run a single probe run to settlement ──────────────────────────────── */

interface SettledRun {
  status: 'succeeded' | 'failed' | 'cancelled' | 'timeout';
  errorMessage?: string;
}

async function pollRunSettle(
  opts: DriverOptions,
  token: string,
  workflowId: string,
  runId: string,
): Promise<SettledRun> {
  const deadline = Date.now() + opts.pollTimeoutMs;
  while (Date.now() < deadline) {
    const res = await apiCall(
      opts,
      token,
      `/api/runs/${encodeURIComponent(workflowId)}/${encodeURIComponent(runId)}`,
    );
    if (res.status === 200 && res.json && typeof res.json === 'object') {
      const run = (res.json as { run?: Record<string, unknown> }).run;
      const status = run?.status;
      if (status === 'succeeded' || status === 'failed' || status === 'cancelled') {
        const errorMessage = run?.errorMessage;
        return {
          status,
          errorMessage: typeof errorMessage === 'string' ? errorMessage : undefined,
        };
      }
    }
    await sleep(RUN_POLL_INTERVAL_MS);
  }
  return { status: 'timeout' };
}

/* ── the costed drive ──────────────────────────────────────────────────── */

async function drive(
  opts: DriverOptions,
  token: string,
  workflow: ProbeWorkflow,
  preflightResult: PreflightResult,
): Promise<Phase33Observations> {
  const { limitUsd, baselineSpentUsd } = preflightResult;
  const obs: Phase33Observations = {
    limitUsd,
    baselineSpentUsd,
    finalSpentUsd: baselineSpentUsd,
    runsExecuted: 0,
    sawNearLimit: false,
    sawExhausted: false,
    midRunTrip: false,
    saw503: false,
  };

  console.log(
    `Driving the cost budget — ceiling ${usd(limitUsd, 2)}, ` +
      `baseline spend ${usd(baselineSpentUsd)}, hard cap ${opts.maxRuns} run(s)`,
  );

  const inputs =
    opts.promptOverride !== undefined ? { prompt: opts.promptOverride } : {};
  const runBody = JSON.stringify({ workflowId: workflow.id, inputs });
  let nonBudgetFailures = 0;

  for (let n = 1; n <= opts.maxRuns; n++) {
    const label = `run ${n}/${opts.maxRuns}`;
    const started = await apiCall(opts, token, '/api/run', {
      method: 'POST',
      body: runBody,
    });

    if (started.status === 503) {
      // The admission gate refused the run — the expected Phase 3.3 endpoint.
      obs.saw503 = true;
      console.log(`  ${label}  refused 503  ← admission gate (cost budget exhausted)`);
      break;
    }
    if (started.status !== 202) {
      throw new Error(
        `${label}: POST /api/run returned HTTP ${started.status} ${started.body}`,
      );
    }

    const runId =
      started.json && typeof started.json === 'object'
        ? (started.json as { runId?: unknown }).runId
        : undefined;
    if (typeof runId !== 'string') {
      throw new Error(`${label}: POST /api/run did not return a runId`);
    }
    obs.runsExecuted = n;

    const settled = await pollRunSettle(opts, token, workflow.id, runId);
    if (settled.status === 'timeout') {
      throw new Error(
        `${label}: run ${runId} did not settle within ${opts.pollTimeoutMs / 1000}s`,
      );
    }

    let note = '';
    if (settled.status === 'failed') {
      if (isBudgetFailure(settled.errorMessage)) {
        obs.midRunTrip = true;
        note = '  ← mid-run cost-budget abort';
      } else {
        nonBudgetFailures++;
        note = `  ← failed (non-budget): ${settled.errorMessage ?? 'no message'}`;
      }
    }

    // Scrape spend after the run settles, so the figure includes its full cost.
    const metrics = await apiCall(opts, token, '/api/metrics');
    if (metrics.status !== 200) {
      throw new Error(`${label}: /api/metrics returned HTTP ${metrics.status}`);
    }
    const spent =
      readMetric(metrics.body, 'infloop_cost_budget_spent_usd') ?? obs.finalSpentUsd;
    obs.finalSpentUsd = spent;
    const ratio = limitUsd > 0 ? spent / limitUsd : 0;
    if (ratio >= NEAR_LIMIT_RATIO) obs.sawNearLimit = true;
    if (spent > limitUsd) obs.sawExhausted = true;

    console.log(
      `  ${label}  ${settled.status.padEnd(9)}  ` +
        `spent ${usd(spent)} / ${usd(limitUsd, 2)}  (${(ratio * 100).toFixed(1)}%)${note}`,
    );

    // Guard: a present-but-unauthenticated CLI produces settled runs that
    // record no cost — fail fast instead of looping to --max-runs.
    if (n >= NO_COST_ABORT_AFTER_RUNS && obs.finalSpentUsd <= baselineSpentUsd) {
      throw new Error(
        `no provider cost recorded after ${n} runs — the provider CLI is likely ` +
          'present but not authenticated. Log the CLI in and re-run.',
      );
    }
    if (nonBudgetFailures >= NON_BUDGET_FAILURE_ABORT) {
      throw new Error(
        `${nonBudgetFailures} runs failed for reasons unrelated to the cost budget ` +
          '— investigate the provider before continuing the burn-in.',
      );
    }
  }

  if (!obs.saw503) {
    console.log(
      `  reached the --max-runs cap (${opts.maxRuns}) without a 503 — ` +
        'raise --max-runs or lower INFLOOP_MAX_TOTAL_COST_USD.',
    );
  }
  console.log('');
  return obs;
}

/* ── report ────────────────────────────────────────────────────────────── */

async function report(
  opts: DriverOptions,
  obs: Phase33Observations,
): Promise<boolean> {
  const { checks, allPass } = evaluatePhase33(obs);
  console.log('Phase 3.3 — cost budget — result');
  for (const check of checks) {
    console.log(`  [${check.pass ? 'PASS' : 'FAIL'}] ${check.label}`);
    console.log(`         ${check.detail}`);
  }
  console.log('');

  if (opts.prometheusUrl) {
    const alerts = await promGet(opts.prometheusUrl, '/api/v1/alerts');
    const states = collectAlertStates(alerts);
    console.log('Prometheus cost alerts (live state)');
    for (const name of COST_ALERTS) {
      console.log(`  ${name}: ${states.get(name) ?? 'inactive'}`);
    }
    console.log(
      '  Note: InfiniteLoopCostBudgetNearLimit has a 5m `for:` window before ' +
        'it fires; InfiniteLoopCostBudgetExhausted fires immediately.',
    );
    console.log('');
  }

  console.log('Manual residual (not automated by this driver):');
  console.log(
    '  - Confirm queued trigger runs (webhook / MCP enqueues) are held intact ' +
      'on disk while the budget is exhausted and resume after a restart.',
  );
  console.log(
    '  - Confirm both cost alerts reach Alertmanager, and walk the matching ' +
      'docs/runbook.md entries end to end.',
  );
  console.log('  Record the outcome under a new Run section in BURN-IN.md.');
  console.log('');
  console.log(
    allPass
      ? 'Phase 3.3 cost-budget checks PASSED.'
      : 'Phase 3.3 cost-budget checks FAILED — see the FAIL lines above.',
  );
  return allPass;
}

/** alertname → state from a Prometheus /api/v1/alerts response. */
function collectAlertStates(alerts: unknown): Map<string, string> {
  const states = new Map<string, string>();
  const list = (alerts as { data?: { alerts?: unknown } } | undefined)?.data?.alerts;
  if (!Array.isArray(list)) return states;
  for (const alert of list) {
    const labels = (alert as { labels?: { alertname?: unknown } }).labels;
    const name = labels?.alertname;
    const state = (alert as { state?: unknown }).state;
    if (typeof name === 'string' && typeof state === 'string') {
      // Keep the most active state if an alert appears more than once.
      if (states.get(name) !== 'firing') states.set(name, state);
    }
  }
  return states;
}

/* ── entry point ───────────────────────────────────────────────────────── */

const USAGE =
  'Usage: bun run burn-in -- --confirm-spend [options]\n' +
  '       bun deploy/burn-in-driver.ts --help\n' +
  'See the header of deploy/burn-in-driver.ts for the full option list.';

async function main(argv: string[]): Promise<number> {
  let opts: DriverOptions;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    if (err instanceof UsageError && err.message === HELP_SENTINEL) {
      console.log(USAGE);
      return 0;
    }
    console.error(`error: ${(err as Error).message}`);
    console.error(USAGE);
    return 2;
  }

  const token = opts.tokenFromArg ?? process.env.INFLOOP_API_TOKEN;
  if (!token) {
    console.error('error: no API token — pass --token or set INFLOOP_API_TOKEN');
    return 2;
  }

  const workflowPath =
    opts.workflowPath ?? join(import.meta.dir, 'burn-in-cost-workflow.json');

  let workflow: ProbeWorkflow;
  try {
    workflow = loadWorkflow(workflowPath);
  } catch (err) {
    console.error(`error: ${(err as Error).message}`);
    return 2;
  }

  console.log('Infinite Loop burn-in driver — Phase 3.3 (process-wide cost budget)');
  console.log(`  target:        ${opts.baseUrl}`);
  console.log(`  probe:         ${workflow.id} (${workflowPath})`);
  if (opts.prometheusUrl) console.log(`  prometheus:    ${opts.prometheusUrl}`);
  console.log('');

  let preflightResult: PreflightResult;
  try {
    preflightResult = await preflight(opts, token, workflow);
  } catch (err) {
    console.error(`Preflight FAILED: ${(err as Error).message}`);
    return 1;
  }

  if (opts.preflightOnly) {
    console.log('Preflight passed. --preflight-only set — stopping before any spend.');
    return 0;
  }
  if (!opts.confirmSpend) {
    console.log(
      'Preflight passed. The cost-budget drive spends real provider money.',
    );
    console.log('Re-run with --confirm-spend to drive it.');
    return 0;
  }

  let obs: Phase33Observations;
  try {
    obs = await drive(opts, token, workflow, preflightResult);
  } catch (err) {
    console.error(`Drive ABORTED: ${(err as Error).message}`);
    return 1;
  }

  const passed = await report(opts, obs);
  return passed ? 0 : 1;
}

if (import.meta.main) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(`unexpected error: ${(err as Error).message}`);
      process.exit(1);
    });
}
