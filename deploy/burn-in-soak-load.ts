/*
 * burn-in-soak-load.ts — automated load generator for the production burn-in's
 * soak phase (docs/burn-in.md Phase 5).
 *
 * Phase 5 has two halves. The *observer* — deploy/burn-in-soak-watch.ts
 * (`bun run soak-watch`) — samples the soak gauges and prints a drift verdict.
 * It explicitly does NOT generate load: run it against an idle stack and it
 * passes vacuously. This script is the missing *generator* half: it fires a
 * webhook trigger on a steady interval for the soak window, so the watcher has
 * a real run pipeline to observe. Run the two side by side for a 24-72h soak.
 *
 * It also unblocks the one Phase 3 alert Run 1 could not reproduce:
 * InfiniteLoopTriggerQueueBacklog (queue_depth > 50 for 10m). Reproducing a
 * backlog needs deliveries arriving faster than the queue drains — more than a
 * shell loop can manage. Lower --interval and raise --concurrency to flood the
 * trigger queue; the report prints the peak queue depth observed so the
 * operator can confirm the alert fired in Prometheus. A single trigger is
 * rate-limited at INFLOOP_WEBHOOK_RATE_LIMIT (default 120/min) — raise it for
 * the burn-in if the report shows deliveries being rejected with 429.
 *
 * Transport: HTTP only. It imports no app code, so it cannot drift with
 * internal refactors and runs from the host, the container, or a remote box.
 * The webhook route deliberately bypasses INFLOOP_API_TOKEN — the unguessable
 * triggerId is the credential — so firing load needs no token; the token is
 * still required for the preflight /api/health, /api/metrics, /api/workflows
 * and /api/triggers calls.
 *
 * What it does:
 *   1. PREFLIGHT — /api/health is ok; /api/metrics authenticates and exposes
 *      infloop_queue_depth; the trigger to fire is resolved (an operator can
 *      supply one with --trigger-id, otherwise the script idempotently
 *      installs a cheap provider-free probe workflow and a generic webhook
 *      trigger for it); one test delivery confirms the whole path returns 202.
 *   2. GENERATE — every --interval seconds, fire --concurrency webhook
 *      deliveries, then scrape infloop_queue_depth. Print a status line; track
 *      accept / back-pressure / transport tallies and the peak queue depth.
 *   3. REPORT — on --duration elapsing or Ctrl-C, print a load summary: how
 *      much load landed, transport reliability, and the peak trigger-queue
 *      depth (with a note on whether it reached the backlog threshold).
 *
 * This script generates load and observes the queue; it does NOT decide
 * whether the soak passed — that is burn-in-soak-watch.ts's drift verdict.
 * Run both, and record the combined outcome in BURN-IN.md.
 *
 * Usage:
 *   bun run soak-load -- [options]
 *   bun deploy/burn-in-soak-load.ts --help
 *
 * Options:
 *   --base-url <url>       App base URL (default http://localhost:8080).
 *   --token <token>       API bearer token. Falls back to $INFLOOP_API_TOKEN.
 *   --interval <s>        Seconds between firing waves (default 180). Fractional
 *                         ok — lower it to flood for the backlog alert.
 *   --duration <h>        Hours to run, then stop and report. Fractional ok.
 *                         Default 0 = run until Ctrl-C.
 *   --concurrency <n>     Webhook deliveries fired per wave (default 1). Raise
 *                         it to flood for the backlog alert.
 *   --trigger-id <id>     Fire this existing webhook trigger instead of
 *                         provisioning the probe workflow + trigger.
 *   --workflow <path>     Probe workflow JSON to install when provisioning
 *                         (default: the file beside this script,
 *                         deploy/burn-in-soak-workflow.json). Ignored with
 *                         --trigger-id.
 *   --help, -h            Print this help.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
// readMetric parses one unlabeled `name <value>` line from a Prometheus
// exposition. infloop_queue_depth is unlabeled (lib/server/metrics.ts), so the
// sibling's parser covers it — importing it avoids a second, divergent copy.
// Importing burn-in-driver.ts runs only its module body (its `main` is
// import.meta.main guarded), so this has no side effects.
import { readMetric } from './burn-in-driver';

/* ── constants ─────────────────────────────────────────────────────────── */

const DEFAULT_BASE_URL = 'http://localhost:8080';
/** docs/burn-in.md Phase 5: "firing a webhook trigger every few minutes". */
const DEFAULT_INTERVAL_S = 180;
const DEFAULT_CONCURRENCY = 1;
/** Abort a request that hangs so a stuck endpoint cannot stall a wave or Ctrl-C. */
const REQUEST_TIMEOUT_MS = 30_000;
/** Give up the whole run after this many waves deliver nothing back to back. */
const MAX_CONSECUTIVE_DEAD_WAVES = 10;
/** queue_depth > 50 for 10m is InfiniteLoopTriggerQueueBacklog's condition. */
const BACKLOG_THRESHOLD = 50;
/** A run whose deliveries mostly failed at the transport layer is a broken
 *  soak, not a back-pressured one — flag it rather than reporting it clean. */
const TRANSPORT_FAILURE_FRACTION = 0.5;
/** id of the probe workflow shipped beside this script. */
const PROBE_WORKFLOW_ID = 'burn-in-soak';
/** The built-in unsigned webhook plugin (lib/server/webhook-plugins/loader.ts). */
const GENERIC_PLUGIN_ID = 'generic';
/** Name given to a provisioned trigger, so a re-run reuses it instead of
 *  accumulating a fresh trigger every time. */
const PROVISIONED_TRIGGER_NAME = 'Burn-in soak load';

/* ── options / argument parsing ────────────────────────────────────────── */

export interface LoadOptions {
  baseUrl: string;
  /** Token from --token only; $INFLOOP_API_TOKEN fallback is applied in main. */
  tokenFromArg?: string;
  intervalMs: number;
  /** 0 = run until Ctrl-C. */
  durationMs: number;
  concurrency: number;
  /** When set, fire this trigger instead of provisioning one. */
  triggerId?: string;
  /** Undefined → main resolves it next to this script. */
  workflowPath?: string;
}

/** Thrown for bad CLI input; `--help` throws it with the HELP sentinel. */
export class UsageError extends Error {}
const HELP_SENTINEL = '__help__';

export function parseArgs(argv: string[]): LoadOptions {
  const opts: LoadOptions = {
    baseUrl: DEFAULT_BASE_URL,
    intervalMs: DEFAULT_INTERVAL_S * 1000,
    durationMs: 0,
    concurrency: DEFAULT_CONCURRENCY,
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
  const nonNegative = (raw: string, flag: string): number => {
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) {
      throw new UsageError(`option ${flag} needs a non-negative number, got "${raw}"`);
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
      case '--interval':
        opts.intervalMs = positive(value(i, arg), arg) * 1000;
        i++;
        break;
      case '--duration':
        // 0 is a legal value — "run until Ctrl-C".
        opts.durationMs = nonNegative(value(i, arg), arg) * 3_600_000;
        i++;
        break;
      case '--concurrency':
        opts.concurrency = Math.floor(positive(value(i, arg), arg));
        i++;
        break;
      case '--trigger-id':
        opts.triggerId = value(i, arg);
        i++;
        break;
      case '--workflow':
        opts.workflowPath = value(i, arg);
        i++;
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

/** Running tally of one soak-load run. */
export interface LoadTally {
  /** Firing waves completed. */
  waves: number;
  /** Webhook deliveries attempted. */
  fired: number;
  /** Deliveries accepted (HTTP 202) — the run was enqueued. */
  accepted: number;
  /** Deliveries refused with HTTP 503 — the trigger queue was full. */
  queueFull: number;
  /** Deliveries refused with HTTP 429 — the per-trigger rate limit. */
  rateLimited: number;
  /** Deliveries that returned some other HTTP status (404, 4xx, 5xx). */
  otherStatus: number;
  /** Deliveries that failed before getting an HTTP status (timeout, refused). */
  transportErrors: number;
  /** Successful /api/metrics scrapes (one is attempted per wave). */
  metricSamples: number;
  /** Highest infloop_queue_depth seen across all scrapes. */
  peakQueueDepth: number;
  /** Scrapes whose queue_depth was strictly above BACKLOG_THRESHOLD. */
  samplesOverBacklog: number;
}

/** A fresh, zeroed tally. */
export function emptyTally(): LoadTally {
  return {
    waves: 0,
    fired: 0,
    accepted: 0,
    queueFull: 0,
    rateLimited: 0,
    otherStatus: 0,
    transportErrors: 0,
    metricSamples: 0,
    peakQueueDepth: 0,
    samplesOverBacklog: 0,
  };
}

export interface LoadFinding {
  severity: 'pass' | 'fail' | 'info';
  label: string;
  detail: string;
}

export interface LoadReport {
  findings: LoadFinding[];
  /** False if any finding is a `fail`. */
  ok: boolean;
}

/**
 * Turn a finished run's tally into the load-generator report.
 *
 * This is a generator, not a verdict: the soak's pass/fail is
 * burn-in-soak-watch.ts's drift analysis. So the checks here only assert the
 * generator did its own job — that real load actually landed:
 *   - at least one delivery was accepted (otherwise the paired watcher would
 *     have observed an idle stack and passed vacuously);
 *   - deliveries were not dominated by transport failures (which would mean
 *     the app was unreachable for much of the window, not back-pressured).
 * The trigger-queue depth is reported as context for Phase 5 and the
 * InfiniteLoopTriggerQueueBacklog alert — never failed on, since a steady
 * Phase 5 load is *expected* to keep the queue near empty.
 */
export function summarizeLoad(t: LoadTally): LoadReport {
  const findings: LoadFinding[] = [];

  // 1. Did any load actually land?
  findings.push(
    t.accepted > 0
      ? {
          severity: 'pass',
          label: 'Webhook load delivered',
          detail: `${t.accepted} of ${t.fired} delivery(ies) accepted (HTTP 202) across ${t.waves} wave(s)`,
        }
      : {
          severity: 'fail',
          label: 'Webhook load delivered',
          detail:
            `0 of ${t.fired} delivery(ies) were accepted — this run drove no load, ` +
            'so a soak-watch run paired with it passed vacuously',
        },
  );

  // 2. Transport reliability. 503 (queue full) and 429 (rate limited) are
  //    deliberate back-pressure, not failures — only transport errors mean the
  //    app was actually unreachable.
  if (t.fired > 0) {
    const frac = t.transportErrors / t.fired;
    if (frac > TRANSPORT_FAILURE_FRACTION) {
      findings.push({
        severity: 'fail',
        label: 'Transport reliability',
        detail:
          `${t.transportErrors} of ${t.fired} deliveries (${(frac * 100).toFixed(1)}%) ` +
          'failed at the transport layer — the app was unreachable for much of the run',
      });
    } else {
      findings.push({
        severity: t.transportErrors > 0 ? 'info' : 'pass',
        label: 'Transport reliability',
        detail:
          t.transportErrors > 0
            ? `${t.transportErrors} of ${t.fired} deliveries failed at the transport layer`
            : `all ${t.fired} deliveries reached the app`,
      });
    }
  }

  // 3. Trigger-queue depth — context only.
  if (t.metricSamples === 0) {
    findings.push({
      severity: 'info',
      label: 'Trigger-queue depth',
      detail: 'not observed — every /api/metrics scrape failed',
    });
  } else if (t.peakQueueDepth > BACKLOG_THRESHOLD) {
    findings.push({
      severity: 'info',
      label: 'Trigger-queue depth',
      detail:
        `peaked at ${t.peakQueueDepth}; ${t.samplesOverBacklog} of ${t.metricSamples} ` +
        `scrape(s) held above ${BACKLOG_THRESHOLD} — the backlog condition for ` +
        'InfiniteLoopTriggerQueueBacklog (queue_depth > 50 for 10m). Confirm the ' +
        'alert state in Prometheus.',
    });
  } else {
    findings.push({
      severity: 'info',
      label: 'Trigger-queue depth',
      detail:
        `peaked at ${t.peakQueueDepth} (<= ${BACKLOG_THRESHOLD}) — the queue drained ` +
        'between waves, as expected under a steady, modest Phase 5 load',
    });
  }

  return { findings, ok: !findings.some((f) => f.severity === 'fail') };
}

/* ── formatting helpers ────────────────────────────────────────────────── */

function fmtDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number): string => String(n).padStart(2, '0');
  if (d > 0) return `${d}d${pad(h)}h`;
  if (h > 0) return `${h}h${pad(m)}m`;
  if (m > 0) return `${m}m${pad(sec)}s`;
  return `${sec}s`;
}

/* ── HTTP ──────────────────────────────────────────────────────────────── */

interface ApiResult {
  status: number;
  body: string;
  /** Parsed JSON, or undefined when the body is empty or not JSON. */
  json: unknown;
}

/**
 * A token-authenticated call to /api — used for preflight only (health,
 * metrics, workflow + trigger provisioning). Throws on a transport error; the
 * caller inspects `status` for HTTP-level outcomes.
 */
async function apiCall(
  opts: LoadOptions,
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
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
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

/** One webhook delivery. `status` is the HTTP status, or 'error' for a
 *  transport failure (timeout, connection refused). */
interface FireResult {
  status: number | 'error';
  detail?: string;
}

/**
 * Fire one webhook delivery. No bearer token — the webhook route authenticates
 * on the unguessable triggerId in the path (see app/api/webhook/[triggerId]).
 * Never throws: a transport failure is returned as `status: 'error'` so one
 * bad delivery cannot abort a multi-day run.
 */
async function fireWebhook(opts: LoadOptions, triggerId: string): Promise<FireResult> {
  try {
    const res = await fetch(
      `${opts.baseUrl}/api/webhook/${encodeURIComponent(triggerId)}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      },
    );
    // Drain the body so the socket is freed for reuse under a high --concurrency.
    await res.text();
    return { status: res.status };
  } catch (err) {
    return { status: 'error', detail: (err as Error).message };
  }
}

/** Scrape infloop_queue_depth. Returns undefined on any error so a failed
 *  scrape is a skipped sample, not an aborted wave. */
async function scrapeQueueDepth(opts: LoadOptions, token: string): Promise<number | undefined> {
  let metrics: ApiResult;
  try {
    metrics = await apiCall(opts, token, '/api/metrics');
  } catch {
    return undefined;
  }
  if (metrics.status !== 200) return undefined;
  return readMetric(metrics.body, 'infloop_queue_depth');
}

/* ── probe workflow + trigger provisioning ─────────────────────────────── */

interface ProbeWorkflow {
  id: string;
  name: string;
  nodes: unknown[];
  edges: unknown[];
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

/** Install the probe workflow, or update it to the shipped version if it
 *  already exists. Mirrors the burn-in driver's workflow-install step. */
async function ensureWorkflow(
  opts: LoadOptions,
  token: string,
  workflow: ProbeWorkflow,
): Promise<void> {
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
    throw new Error(`probing workflow "${workflow.id}" returned HTTP ${existing.status}`);
  }
}

interface ApiTrigger {
  id: string;
  name?: string;
  enabled?: boolean;
  pluginId?: string;
  workflowId?: string;
}

/** Parse the `triggers` array from a GET /api/triggers response. */
function parseTriggers(json: unknown): ApiTrigger[] {
  const list = (json as { triggers?: unknown } | undefined)?.triggers;
  if (!Array.isArray(list)) return [];
  const out: ApiTrigger[] = [];
  for (const t of list) {
    if (t && typeof t === 'object' && typeof (t as { id?: unknown }).id === 'string') {
      out.push(t as ApiTrigger);
    }
  }
  return out;
}

/**
 * Resolve the generic webhook trigger to fire for `workflowId`: reuse the one a
 * previous soak-load run provisioned, or create it. Idempotent — matching on
 * the provisioned name keeps a re-run from accumulating a fresh trigger each
 * time.
 */
async function ensureTrigger(
  opts: LoadOptions,
  token: string,
  workflowId: string,
): Promise<string> {
  const listed = await apiCall(
    opts,
    token,
    `/api/triggers?workflowId=${encodeURIComponent(workflowId)}`,
  );
  if (listed.status !== 200) {
    throw new Error(`GET /api/triggers returned HTTP ${listed.status}`);
  }
  const existing = parseTriggers(listed.json).find(
    (t) =>
      t.pluginId === GENERIC_PLUGIN_ID &&
      t.enabled === true &&
      t.name === PROVISIONED_TRIGGER_NAME,
  );
  if (existing) {
    console.log(`  [ok]   reusing webhook trigger "${existing.id}"`);
    return existing.id;
  }

  const created = await apiCall(opts, token, '/api/triggers', {
    method: 'POST',
    body: JSON.stringify({
      name: PROVISIONED_TRIGGER_NAME,
      enabled: true,
      workflowId,
      pluginId: GENERIC_PLUGIN_ID,
      match: [],
      inputs: {},
    }),
  });
  if (created.status !== 201) {
    throw new Error(
      `creating the webhook trigger failed: HTTP ${created.status} ${created.body}`,
    );
  }
  const trigger = (created.json as { trigger?: ApiTrigger } | undefined)?.trigger;
  if (!trigger || typeof trigger.id !== 'string') {
    throw new Error('POST /api/triggers did not return a trigger id');
  }
  console.log(`  [ok]   webhook trigger "${trigger.id}" created`);
  return trigger.id;
}

/** Confirm an operator-supplied --trigger-id exists and is enabled. */
async function verifyTrigger(
  opts: LoadOptions,
  token: string,
  triggerId: string,
): Promise<void> {
  const listed = await apiCall(opts, token, '/api/triggers');
  if (listed.status !== 200) {
    throw new Error(`GET /api/triggers returned HTTP ${listed.status}`);
  }
  const trigger = parseTriggers(listed.json).find((t) => t.id === triggerId);
  if (!trigger) {
    throw new Error(`--trigger-id "${triggerId}" was not found on /api/triggers`);
  }
  if (trigger.enabled !== true) {
    throw new Error(
      `--trigger-id "${triggerId}" is disabled — a webhook to a disabled trigger 404s`,
    );
  }
  console.log(`  [ok]   webhook trigger "${triggerId}" exists and is enabled`);
}

/* ── preflight ─────────────────────────────────────────────────────────── */

/**
 * Verify the stack and resolve the trigger to fire. Returns the resolved
 * trigger id. Throws on any failure — a clear, fast stop beats discovering a
 * broken setup hours into a soak.
 */
async function preflight(
  opts: LoadOptions,
  token: string,
  workflowPath: string,
): Promise<string> {
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

  // 2. Metrics endpoint authenticates and exposes the queue-depth gauge.
  const metrics = await apiCall(opts, token, '/api/metrics');
  if (metrics.status === 401) {
    throw new Error('/api/metrics returned 401 — the API token is wrong or missing');
  }
  if (metrics.status !== 200) {
    throw new Error(`/api/metrics returned HTTP ${metrics.status}`);
  }
  if (readMetric(metrics.body, 'infloop_queue_depth') === undefined) {
    throw new Error(
      'infloop_queue_depth absent from /api/metrics — not an Infinite Loop endpoint',
    );
  }
  console.log('  [ok]   /api/metrics → authenticated, infloop_queue_depth present');

  // 3. Resolve the trigger to fire.
  let triggerId: string;
  if (opts.triggerId) {
    await verifyTrigger(opts, token, opts.triggerId);
    triggerId = opts.triggerId;
  } else {
    const workflow = loadWorkflow(workflowPath);
    await ensureWorkflow(opts, token, workflow);
    triggerId = await ensureTrigger(opts, token, workflow.id);
  }

  // 4. One test delivery — confirm the whole webhook path before committing to
  //    a multi-day run.
  const test = await fireWebhook(opts, triggerId);
  if (test.status !== 202) {
    throw new Error(
      `test webhook delivery did not return 202 (got ${test.status}` +
        `${test.detail ? `: ${test.detail}` : ''}) — the trigger or workflow is broken`,
    );
  }
  console.log('  [ok]   test webhook delivery → 202 queued');

  console.log('');
  return triggerId;
}

/* ── interruptible sleep + signal handling ─────────────────────────────── */

let stopRequested = false;
let wake: () => void = () => {};

function interruptibleSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    wake = (): void => {
      clearTimeout(timer);
      resolve();
    };
  });
}

function installSignalHandler(): void {
  process.on('SIGINT', () => {
    if (stopRequested) {
      console.error('\nSecond Ctrl-C — exiting now.');
      process.exit(130);
    }
    stopRequested = true;
    console.error('\nCtrl-C — finishing up and printing the load report…');
    wake();
  });
}

/* ── status line ───────────────────────────────────────────────────────── */

/** One firing wave's outcome, for the status line. */
interface WaveResult {
  fired: number;
  accepted: number;
  queueFull: number;
  rateLimited: number;
  otherStatus: number;
  transportErrors: number;
  queueDepth: number | undefined;
}

function printStatus(wave: WaveResult, n: number, peakQueueDepth: number): void {
  const clock = new Date().toTimeString().slice(0, 8);
  const depth = wave.queueDepth === undefined ? '?' : String(wave.queueDepth);
  console.log(
    `[${clock} w${String(n).padStart(4, '0')}]  fired ${wave.fired}  ok ${wave.accepted}  ` +
      `503 ${wave.queueFull}  429 ${wave.rateLimited}  err ${wave.transportErrors + wave.otherStatus}  ` +
      `queue ${depth}  (peak ${peakQueueDepth})`,
  );
}

/* ── report ────────────────────────────────────────────────────────────── */

function report(
  opts: LoadOptions,
  tally: LoadTally,
  loop: { elapsedMs: number; aborted: boolean; abortReason: string },
): boolean {
  console.log('');
  console.log('Phase 5 — soak load — result');
  console.log(
    `  ${tally.waves} wave(s) over ${fmtDuration(loop.elapsedMs / 1000)}; ` +
      `${tally.fired} webhook delivery(ies) fired`,
  );
  console.log(
    `  accepted ${tally.accepted}  queue-full(503) ${tally.queueFull}  ` +
      `rate-limited(429) ${tally.rateLimited}  other-status ${tally.otherStatus}  ` +
      `transport-errors ${tally.transportErrors}`,
  );
  console.log('');

  const { findings, ok: findingsOk } = summarizeLoad(tally);
  for (const f of findings) {
    const tag = f.severity === 'pass' ? 'PASS' : f.severity === 'fail' ? 'FAIL' : 'INFO';
    console.log(`  [${tag}] ${f.label}`);
    console.log(`         ${f.detail}`);
  }
  console.log('');

  if (loop.aborted) {
    console.log(`  [FAIL] run aborted: ${loop.abortReason}`);
    console.log('');
  }

  console.log('Manual residual (not decided by this generator):');
  console.log(
    '  - This is the load *generator*. The Phase 5 pass/fail is the drift ' +
      'verdict from `bun run soak-watch`, run against the same window.',
  );
  console.log(
    '  - For InfiniteLoopTriggerQueueBacklog, confirm the alert state in ' +
      'Prometheus — a peak queue depth here only shows the backlog was reached.',
  );
  console.log('  Record the combined outcome under a new Run section in BURN-IN.md.');
  console.log('');

  const ok = findingsOk && !loop.aborted;
  console.log(
    ok
      ? 'Phase 5 soak-load checks PASSED — load was delivered for the window.'
      : 'Phase 5 soak-load checks FAILED — see the FAIL lines above.',
  );
  return ok;
}

/* ── load loop ─────────────────────────────────────────────────────────── */

async function runLoad(
  opts: LoadOptions,
  token: string,
  triggerId: string,
): Promise<number> {
  const tally = emptyTally();
  let consecutiveDeadWaves = 0;
  let aborted = false;
  let abortReason = '';

  const startedAt = Date.now();
  const endAt = opts.durationMs > 0 ? startedAt + opts.durationMs : Infinity;
  console.log(
    `Firing ${opts.concurrency} webhook(s) every ${opts.intervalMs / 1000}s` +
      (opts.durationMs > 0
        ? ` for ${fmtDuration(opts.durationMs / 1000)}`
        : ' until Ctrl-C') +
      ` — trigger ${triggerId}`,
  );
  console.log('');

  while (!stopRequested && Date.now() < endAt) {
    const waveStart = Date.now();

    // Fire the wave's deliveries in parallel.
    const results = await Promise.all(
      Array.from({ length: opts.concurrency }, () => fireWebhook(opts, triggerId)),
    );
    const wave: WaveResult = {
      fired: results.length,
      accepted: 0,
      queueFull: 0,
      rateLimited: 0,
      otherStatus: 0,
      transportErrors: 0,
      queueDepth: undefined,
    };
    let firstError: string | undefined;
    for (const r of results) {
      if (r.status === 'error') {
        wave.transportErrors++;
        if (!firstError) firstError = r.detail;
      } else if (r.status === 202) {
        wave.accepted++;
      } else if (r.status === 503) {
        wave.queueFull++;
      } else if (r.status === 429) {
        wave.rateLimited++;
      } else {
        wave.otherStatus++;
      }
    }

    // Scrape the queue depth once per wave (a failed scrape is a skipped
    // sample, never an aborted wave).
    wave.queueDepth = await scrapeQueueDepth(opts, token);

    // Fold the wave into the running tally.
    tally.waves++;
    tally.fired += wave.fired;
    tally.accepted += wave.accepted;
    tally.queueFull += wave.queueFull;
    tally.rateLimited += wave.rateLimited;
    tally.otherStatus += wave.otherStatus;
    tally.transportErrors += wave.transportErrors;
    if (wave.queueDepth !== undefined) {
      tally.metricSamples++;
      tally.peakQueueDepth = Math.max(tally.peakQueueDepth, wave.queueDepth);
      if (wave.queueDepth > BACKLOG_THRESHOLD) tally.samplesOverBacklog++;
    }

    printStatus(wave, tally.waves, tally.peakQueueDepth);
    if (wave.transportErrors > 0 && firstError) {
      console.error(`  [warn] transport error this wave: ${firstError}`);
    }

    // A wave that neither delivered nor was back-pressured reached nothing —
    // app down, or the trigger was deleted mid-run. Abort after a streak.
    const reachedSomething =
      wave.accepted > 0 || wave.queueFull > 0 || wave.rateLimited > 0;
    consecutiveDeadWaves = reachedSomething ? 0 : consecutiveDeadWaves + 1;
    if (consecutiveDeadWaves >= MAX_CONSECUTIVE_DEAD_WAVES) {
      aborted = true;
      abortReason =
        `${consecutiveDeadWaves} consecutive waves delivered nothing — the webhook ` +
        'endpoint is unreachable, overwhelmed, or the trigger was removed';
      console.error(`  ${abortReason}`);
      break;
    }

    if (stopRequested || Date.now() >= endAt) break;
    const waitMs = Math.max(0, opts.intervalMs - (Date.now() - waveStart));
    await interruptibleSleep(waitMs);
  }

  const ok = report(opts, tally, {
    elapsedMs: Date.now() - startedAt,
    aborted,
    abortReason,
  });
  return ok ? 0 : 1;
}

/* ── entry point ───────────────────────────────────────────────────────── */

const USAGE =
  'Usage: bun run soak-load -- [options]\n' +
  '       bun deploy/burn-in-soak-load.ts --help\n' +
  'See the header of deploy/burn-in-soak-load.ts for the full option list.';

async function main(argv: string[]): Promise<number> {
  let opts: LoadOptions;
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
    opts.workflowPath ?? join(import.meta.dir, 'burn-in-soak-workflow.json');

  console.log('Infinite Loop burn-in soak-load — Phase 5 (load generator)');
  console.log(`  target:        ${opts.baseUrl}`);
  if (opts.triggerId) {
    console.log(`  trigger:       ${opts.triggerId} (operator-supplied)`);
  } else {
    console.log(`  probe:         ${PROBE_WORKFLOW_ID} (${workflowPath})`);
  }
  console.log('');

  installSignalHandler();

  let triggerId: string;
  try {
    triggerId = await preflight(opts, token, workflowPath);
  } catch (err) {
    console.error(`Preflight FAILED: ${(err as Error).message}`);
    return 1;
  }

  return runLoad(opts, token, triggerId);
}

if (import.meta.main) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(`unexpected error: ${(err as Error).message}`);
      process.exit(1);
    });
}
