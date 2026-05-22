/*
 * burn-in-soak-watch.ts — automated observer for the production burn-in's
 * soak phase (docs/burn-in.md Phase 5).
 *
 * Phase 5 is the one burn-in phase with no automated coverage: slow drift over
 * a 24–72h unattended run. Unit and failure-injection tests prove behaviour in
 * the moment; only a soak proves nothing leaks over days. Until now that meant
 * an operator eyeballing Prometheus for three days. This script samples the
 * Phase 5 signals on an interval and turns the result into a pass/fail drift
 * verdict an operator can paste into BURN-IN.md.
 *
 * It does NOT generate load. docs/burn-in.md Phase 5 expects the operator to
 * drive a steady, modest load separately (an external cron/timer firing a
 * webhook). This script is the *observer* half — running it against an idle
 * stack produces a vacuous pass, exactly the trap BURN-IN.md warns about.
 *
 * Transport: HTTP only, except the optional `--docker-container` RSS probe.
 * It scrapes /api/metrics and imports no app code, so it cannot drift with
 * internal refactors and runs from the host, the container, or a remote box.
 * Container RSS is not in /api/metrics, so RSS sampling shells out to
 * `docker stats` and is therefore only available when this script runs on the
 * Docker host; left off, the run stays pure-HTTP and remote-friendly.
 *
 * What it does:
 *   1. PREFLIGHT — /api/metrics authenticates and exposes the soak gauges; if
 *      --docker-container is set, `docker stats` works for that container.
 *   2. SAMPLE — every --interval seconds, scrape the Phase 5 gauges
 *      (process uptime, runs active, queue depth, event-buffer events, slot
 *      pool in-use / waiting; cost spend for context) and, when enabled,
 *      container RSS. Print a status line; flag an uptime regression live.
 *      Each sample is optionally appended to --out as one JSON line.
 *   3. REPORT — on --duration elapsing or Ctrl-C, run the drift analysis and
 *      print a Phase 5 verdict: uptime monotonic (no silent restart), the
 *      return-to-baseline gauges did not ratchet, RSS did not trend up.
 *
 * Drift analysis (see analyzeSoak):
 *   - Uptime must climb monotonically. A drop past a small rounding grace
 *     means the process restarted — a hard fail.
 *   - The return-to-baseline gauges and RSS are checked by their *floor* — the
 *     minimum across an early third vs a late third of the run. The floor is
 *     load-independent (a steady load still idles between runs), so a rising
 *     floor is a genuine leak/ratchet, not load variance. Instantaneous peaks
 *     are load-dependent and reported for context only, never failed on.
 *   - Fewer than MIN_SAMPLES_FOR_TREND samples → the trend checks are reported
 *     inconclusive (a short run cannot prove a soak); the uptime check, which
 *     needs only two samples, still runs.
 *
 * Usage:
 *   bun run soak-watch -- [options]
 *   bun deploy/burn-in-soak-watch.ts --help
 *
 * Options:
 *   --base-url <url>        App base URL (default http://localhost:8080).
 *   --token <token>        API bearer token. Falls back to $INFLOOP_API_TOKEN.
 *   --interval <s>         Seconds between samples (default 300).
 *   --duration <h>         Hours to run, then stop and report. Fractional ok.
 *                          Default 0 = run until Ctrl-C.
 *   --docker-container <name>
 *                          Also sample container RSS via `docker stats`.
 *                          Requires running on the Docker host.
 *   --rss-growth-threshold <pct>
 *                          RSS post-GC floor growth that flags a leak
 *                          (default 10).
 *   --out <path>           Append each sample as one JSON line (JSONL).
 *   --help, -h             Print this help.
 */

import { appendFileSync, existsSync, statSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
// readMetric parses one unlabeled `name <value>` line from a Prometheus
// exposition. Every gauge this script samples is unlabeled (confirmed in
// lib/server/metrics.ts), so the sibling's parser covers them all — importing
// it avoids a second, divergent copy of exposition parsing. Importing
// burn-in-driver.ts runs only its module body (its `main` is import.meta.main
// guarded), so this has no side effects.
import { readMetric } from './burn-in-driver';

const execFileAsync = promisify(execFile);

/* ── constants ─────────────────────────────────────────────────────────── */

const DEFAULT_BASE_URL = 'http://localhost:8080';
const DEFAULT_INTERVAL_S = 300;
const DEFAULT_RSS_GROWTH_PCT = 10;
/** `docker stats` is normally ~1–2s; cap a stuck invocation so a tick can't hang. */
const DOCKER_STATS_TIMEOUT_MS = 10_000;
/** Abort a scrape that hangs, so a stuck endpoint cannot stall a tick or Ctrl-C. */
const SCRAPE_TIMEOUT_MS = 30_000;
/** Give up the whole watch after this many scrapes fail back to back. */
const MAX_CONSECUTIVE_FAILURES = 10;
/**
 * Below this sample count the early/late thirds are too small for a trend
 * verdict to mean anything (each third gets a usable population at 30). The
 * uptime check has no such floor — two samples are enough to spot a restart.
 */
const MIN_SAMPLES_FOR_TREND = 30;
/**
 * infloop_process_uptime_seconds is Math.round(process.uptime()) read by two
 * independent scrapes (app/api/metrics/route.ts), so a later sample can read a
 * second or two lower than an earlier one with no restart. A genuine restart
 * resets uptime to single digits — orders of magnitude past this grace.
 */
const UPTIME_REGRESSION_GRACE_S = 5;

/** The return-to-baseline gauges docs/burn-in.md Phase 5 says to watch. */
const WATCHED_GAUGES = [
  { metric: 'infloop_runs_active', key: 'runs_active' },
  { metric: 'infloop_queue_depth', key: 'queue_depth' },
  { metric: 'infloop_event_buffer_events', key: 'event_buffer_events' },
  { metric: 'infloop_slot_pool_in_use', key: 'slot_pool_in_use' },
  { metric: 'infloop_slot_pool_waiting', key: 'slot_pool_waiting' },
] as const;

/* ── options / argument parsing ────────────────────────────────────────── */

export interface SoakOptions {
  baseUrl: string;
  /** Token from --token only; $INFLOOP_API_TOKEN fallback is applied in main. */
  tokenFromArg?: string;
  intervalMs: number;
  /** 0 = run until Ctrl-C. */
  durationMs: number;
  dockerContainer?: string;
  /** RSS post-GC floor growth, as a fraction (0.10 = 10%). */
  rssGrowthThreshold: number;
  outPath?: string;
}

/** Thrown for bad CLI input; `--help` throws it with the HELP sentinel. */
export class UsageError extends Error {}
const HELP_SENTINEL = '__help__';

export function parseArgs(argv: string[]): SoakOptions {
  const opts: SoakOptions = {
    baseUrl: DEFAULT_BASE_URL,
    intervalMs: DEFAULT_INTERVAL_S * 1000,
    durationMs: 0,
    rssGrowthThreshold: DEFAULT_RSS_GROWTH_PCT / 100,
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
      case '--docker-container':
        opts.dockerContainer = value(i, arg);
        i++;
        break;
      case '--rss-growth-threshold':
        opts.rssGrowthThreshold = positive(value(i, arg), arg) / 100;
        i++;
        break;
      case '--out':
        opts.outPath = value(i, arg);
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

/**
 * Parse the "used" half of a `docker stats` MemUsage field to bytes. The field
 * reads `<used> / <limit>`, e.g. `45.2MiB / 1.952GiB`; only the used figure is
 * RSS. `docker stats` emits binary units (`KiB`/`MiB`/`GiB`); decimal units
 * are tolerated for safety. Returns undefined for anything unparseable so a
 * caller treats a bad reading as a missing sample, not a crash.
 */
export function parseDockerMem(memUsage: string): number | undefined {
  const used = memUsage.split('/')[0]?.trim();
  if (!used) return undefined;
  const m = used.match(/^([0-9]*\.?[0-9]+)\s*([a-zA-Z]+)$/);
  if (!m) return undefined;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return undefined;
  const factor: Record<string, number> = {
    b: 1,
    kib: 1024, mib: 1024 ** 2, gib: 1024 ** 3, tib: 1024 ** 4,
    kb: 1000, mb: 1000 ** 2, gb: 1000 ** 3, tb: 1000 ** 4,
  };
  const f = factor[m[2].toLowerCase()];
  return f === undefined ? undefined : n * f;
}

/** A single soak sample. RSS is present only when --docker-container is set. */
export interface SoakSample {
  /** Epoch ms when the sample was scraped. */
  t: number;
  uptimeSeconds: number;
  /** Cumulative provider spend — context only, not drift-checked (monotonic). */
  spentUsd: number;
  /** Watched-gauge values, keyed by WATCHED_GAUGES[].key. */
  gauges: Record<string, number>;
  rssBytes?: number;
}

export interface Finding {
  severity: 'pass' | 'fail' | 'info';
  label: string;
  detail: string;
}

export interface SoakReport {
  findings: Finding[];
  /** False if any finding is a `fail`. */
  ok: boolean;
  /** Whether the sample count was enough to assess the gauge/RSS trends. */
  trendAssessed: boolean;
}

const min = (xs: number[]): number => Math.min(...xs);
const max = (xs: number[]): number => Math.max(...xs);
const mean = (xs: number[]): number =>
  xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;

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

function fmtBytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)}GiB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)}MiB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)}KiB`;
  return `${Math.round(n)}B`;
}

/**
 * Turn a run of samples into the docs/burn-in.md Phase 5 drift verdict.
 *
 * Three independent checks, each mapping to one Phase 5 expectation:
 *   - uptime climbs monotonically (no silent restart);
 *   - every return-to-baseline gauge still returns to its floor;
 *   - the RSS post-GC floor has not trended up.
 *
 * Gauges and RSS are judged by their *floor* (the minimum across an early vs a
 * late third), never by peaks. Under the prescribed steady-but-modest load the
 * system still idles between runs, so the floor is load-independent: a floor
 * that rises is a genuine leak, while a higher peak is just a busier moment.
 * That is why the same min-of-thirds statistic is correct for both the
 * zero-floor gauges and RSS. Monotonic series (uptime, cost spend) are never
 * floor-checked — they are expected to climb.
 */
export function analyzeSoak(
  samples: SoakSample[],
  opts: { rssGrowthThreshold: number },
): SoakReport {
  const findings: Finding[] = [];

  /* 1. Uptime monotonicity — needs only two samples. */
  if (samples.length < 2) {
    findings.push({
      severity: 'info',
      label: 'Uptime monotonic (no silent restart)',
      detail: `only ${samples.length} sample(s) — cannot assess`,
    });
  } else {
    let restarts = 0;
    let worst = '';
    for (let i = 1; i < samples.length; i++) {
      const prev = samples[i - 1];
      const cur = samples[i];
      if (cur.uptimeSeconds < prev.uptimeSeconds - UPTIME_REGRESSION_GRACE_S) {
        restarts++;
        if (!worst) {
          worst = `${fmtDuration(prev.uptimeSeconds)} → ${fmtDuration(cur.uptimeSeconds)} between sample ${i} and ${i + 1}`;
        }
      }
    }
    const first = samples[0].uptimeSeconds;
    const last = samples[samples.length - 1].uptimeSeconds;
    findings.push(
      restarts === 0
        ? {
            severity: 'pass',
            label: 'Uptime monotonic (no silent restart)',
            detail: `climbed ${fmtDuration(first)} → ${fmtDuration(last)} across ${samples.length} samples`,
          }
        : {
            severity: 'fail',
            label: 'Uptime monotonic (no silent restart)',
            detail: `uptime regressed ${restarts}×; first: ${worst} — the process restarted`,
          },
    );
  }

  /* 2 & 3. Gauge ratchet + RSS leak — both floor-of-thirds. */
  const trendAssessed = samples.length >= MIN_SAMPLES_FOR_TREND;
  if (!trendAssessed) {
    findings.push({
      severity: 'info',
      label: 'Gauge / RSS trend',
      detail:
        `${samples.length} sample(s) — need ${MIN_SAMPLES_FOR_TREND} for a trend ` +
        'verdict; gauge and RSS checks not assessed (run longer)',
    });
    return { findings, ok: findings.every((f) => f.severity !== 'fail'), trendAssessed };
  }

  const third = Math.floor(samples.length / 3);
  const early = samples.slice(0, third);
  const late = samples.slice(samples.length - third);

  for (const gauge of WATCHED_GAUGES) {
    const earlyFloor = min(early.map((s) => s.gauges[gauge.key] ?? 0));
    const lateFloor = min(late.map((s) => s.gauges[gauge.key] ?? 0));
    findings.push(
      lateFloor > earlyFloor
        ? {
            severity: 'fail',
            label: `${gauge.key} returns to baseline`,
            detail: `late-third floor ${lateFloor} rose from early-third floor ${earlyFloor} — gauge ratcheting`,
          }
        : {
            severity: 'pass',
            label: `${gauge.key} returns to baseline`,
            detail: `floor steady (early ${earlyFloor}, late ${lateFloor})`,
          },
    );
  }

  // A live process always has positive RSS; a 0-byte docker-stats reading is a
  // glitch (a container caught pre-init, a transient empty stat), not a real
  // measurement. Drop non-positive readings so one bad sample cannot drag the
  // early-third floor to 0 — which would otherwise divide-by-zero or, worse,
  // silently report any later RSS as 0% growth and mask a real leak.
  const earlyRss = early
    .map((s) => s.rssBytes)
    .filter((v): v is number => v !== undefined && v > 0);
  const lateRss = late
    .map((s) => s.rssBytes)
    .filter((v): v is number => v !== undefined && v > 0);
  if (earlyRss.length === 0 || lateRss.length === 0) {
    findings.push({
      severity: 'info',
      label: 'RSS flat (no leak)',
      detail:
        'RSS not assessed — not sampled across both halves of the run (no ' +
        '--docker-container, or every reading was 0)',
    });
  } else {
    // earlyRss is filtered all-positive, so earlyFloor > 0 and the growth
    // ratio is always well-defined.
    const earlyFloor = min(earlyRss);
    const lateFloor = min(lateRss);
    const growth = (lateFloor - earlyFloor) / earlyFloor;
    const pct = (growth * 100).toFixed(1);
    const delta = `${fmtBytes(earlyFloor)} → ${fmtBytes(lateFloor)} (${growth >= 0 ? '+' : ''}${pct}%)`;
    findings.push(
      growth > opts.rssGrowthThreshold
        ? {
            severity: 'fail',
            label: 'RSS flat (no leak)',
            detail: `post-GC floor ${delta} — exceeds ${(opts.rssGrowthThreshold * 100).toFixed(0)}% — suspected leak`,
          }
        : {
            severity: 'pass',
            label: 'RSS flat (no leak)',
            detail: `post-GC floor ${delta} — within ${(opts.rssGrowthThreshold * 100).toFixed(0)}%`,
          },
    );
  }

  return { findings, ok: findings.every((f) => f.severity !== 'fail'), trendAssessed };
}

/* ── HTTP scrape ───────────────────────────────────────────────────────── */

/**
 * Scrape /api/metrics once and build a SoakSample (without RSS). Throws on any
 * transport error, a non-200, or a malformed body — the caller treats a throw
 * as a failed tick.
 */
async function scrape(opts: SoakOptions, token: string): Promise<SoakSample> {
  let res: Response;
  try {
    res = await fetch(`${opts.baseUrl}/api/metrics`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(SCRAPE_TIMEOUT_MS),
    });
  } catch (err) {
    throw new Error(`request to /api/metrics failed: ${(err as Error).message}`);
  }
  if (res.status === 401) {
    throw new Error('/api/metrics returned 401 — the API token is wrong or missing');
  }
  if (res.status !== 200) {
    throw new Error(`/api/metrics returned HTTP ${res.status}`);
  }
  const body = await res.text();

  const uptime = readMetric(body, 'infloop_process_uptime_seconds');
  if (uptime === undefined) {
    throw new Error(
      'infloop_process_uptime_seconds absent — not an Infinite Loop metrics endpoint',
    );
  }
  const gauges: Record<string, number> = {};
  for (const gauge of WATCHED_GAUGES) {
    const v = readMetric(body, gauge.metric);
    if (v === undefined) {
      throw new Error(`${gauge.metric} absent from /api/metrics`);
    }
    gauges[gauge.key] = v;
  }
  return {
    t: Date.now(),
    uptimeSeconds: uptime,
    spentUsd: readMetric(body, 'infloop_cost_budget_spent_usd') ?? 0,
    gauges,
  };
}

/* ── RSS via docker stats ──────────────────────────────────────────────── */

/**
 * Read a container's RSS via `docker stats --no-stream`. Throws if `docker` is
 * unavailable, the container is unknown, or the output cannot be parsed.
 */
async function sampleRss(container: string): Promise<number> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(
      'docker',
      ['stats', '--no-stream', '--format', '{{.MemUsage}}', container],
      { timeout: DOCKER_STATS_TIMEOUT_MS },
    ));
  } catch (err) {
    throw new Error(`docker stats for "${container}" failed: ${(err as Error).message}`);
  }
  const rss = parseDockerMem(stdout.trim());
  if (rss === undefined) {
    throw new Error(`could not parse docker stats output: "${stdout.trim()}"`);
  }
  return rss;
}

/* ── --out JSONL sink ──────────────────────────────────────────────────── */

/**
 * A crash-survivable JSONL sink: each sample is appended as one line, so a
 * watcher killed mid-soak still leaves every sample taken so far. A write
 * error disables the sink rather than aborting a multi-day run.
 */
function makeOutSink(path: string): (sample: SoakSample) => void {
  if (existsSync(path) && statSync(path).size > 0) {
    console.error(`  [warn] --out file "${path}" already exists — appending`);
  }
  let disabled = false;
  return (sample: SoakSample): void => {
    if (disabled) return;
    try {
      appendFileSync(path, JSON.stringify(sample) + '\n');
    } catch (err) {
      console.error(
        `  [warn] writing --out "${path}" failed: ${(err as Error).message} — ` +
          'sampling continues without it',
      );
      disabled = true;
    }
  };
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
    console.error('\nCtrl-C — finishing up and printing the soak report…');
    wake();
  });
}

/* ── status line ───────────────────────────────────────────────────────── */

function printStatus(sample: SoakSample, n: number): void {
  const clock = new Date(sample.t).toTimeString().slice(0, 8);
  const g = sample.gauges;
  let line =
    `[${clock} s${String(n).padStart(3, '0')}]  up ${fmtDuration(sample.uptimeSeconds).padEnd(7)}  ` +
    `active ${g.runs_active}  queue ${g.queue_depth}  evbuf ${g.event_buffer_events}  ` +
    `slot ${g.slot_pool_in_use}  wait ${g.slot_pool_waiting}  spend $${sample.spentUsd.toFixed(4)}`;
  if (sample.rssBytes !== undefined) line += `  rss ${fmtBytes(sample.rssBytes)}`;
  console.log(line);
}

/* ── report ────────────────────────────────────────────────────────────── */

function report(
  opts: SoakOptions,
  samples: SoakSample[],
  loop: { failedScrapes: number; aborted: boolean; abortReason: string },
): boolean {
  console.log('');
  console.log('Phase 5 — soak — result');
  console.log(
    `  ${samples.length} sample(s) over ${fmtDuration(
      samples.length >= 2 ? (samples[samples.length - 1].t - samples[0].t) / 1000 : 0,
    )}; ${loop.failedScrapes} failed scrape(s)`,
  );
  console.log('');

  if (samples.length === 0) {
    console.log('  No samples collected — nothing to analyse.');
    console.log('');
    console.log('Phase 5 soak checks FAILED — no data.');
    return false;
  }

  // Per-gauge shape, for the operator's eye. The verdict is on the floor (see
  // analyzeSoak); min/mean/max here just show how each series moved.
  console.log('  Gauge summary (min / mean / max across the run):');
  for (const gauge of WATCHED_GAUGES) {
    const xs = samples.map((s) => s.gauges[gauge.key] ?? 0);
    console.log(
      `    ${gauge.key.padEnd(20)} ${min(xs)} / ${mean(xs).toFixed(1)} / ${max(xs)}`,
    );
  }
  const rss = samples.map((s) => s.rssBytes).filter((v): v is number => v !== undefined);
  if (rss.length > 0) {
    console.log(
      `    ${'rss'.padEnd(20)} ${fmtBytes(min(rss))} / ${fmtBytes(mean(rss))} / ${fmtBytes(max(rss))}`,
    );
  }
  console.log('');

  const analysis = analyzeSoak(samples, {
    rssGrowthThreshold: opts.rssGrowthThreshold,
  });
  for (const f of analysis.findings) {
    const tag = f.severity === 'pass' ? 'PASS' : f.severity === 'fail' ? 'FAIL' : 'INFO';
    console.log(`  [${tag}] ${f.label}`);
    console.log(`         ${f.detail}`);
  }
  console.log('');

  if (loop.aborted) {
    console.log(`  [FAIL] watch aborted: ${loop.abortReason}`);
    console.log('');
  }

  console.log('Manual residual (not automated by this watcher):');
  console.log(
    '  - This watcher only observes. Confirm a steady, modest load was driven ' +
      'for the whole window (docs/burn-in.md Phase 5) — an idle soak passes vacuously.',
  );
  console.log('  Record the outcome under a new Run section in BURN-IN.md.');
  console.log('');

  const ok = analysis.ok && !loop.aborted;
  if (!ok) {
    console.log('Phase 5 soak checks FAILED — see the FAIL lines above.');
  } else if (!analysis.trendAssessed) {
    console.log(
      'Phase 5 soak INCONCLUSIVE — uptime is clean but the run was too short ' +
        'to assess gauge/RSS drift. Re-run for 24–72h.',
    );
  } else {
    console.log('Phase 5 soak checks PASSED.');
  }
  return ok;
}

/* ── soak loop ─────────────────────────────────────────────────────────── */

async function runSoak(opts: SoakOptions, token: string): Promise<number> {
  /* Preflight: one scrape so a bad URL/token fails fast and clearly. */
  console.log('Preflight');
  try {
    const first = await scrape(opts, token);
    console.log(
      `  [ok]   /api/metrics → uptime ${fmtDuration(first.uptimeSeconds)}, soak gauges present`,
    );
  } catch (err) {
    console.error(`Preflight FAILED: ${(err as Error).message}`);
    return 1;
  }
  if (opts.dockerContainer) {
    try {
      const rss = await sampleRss(opts.dockerContainer);
      console.log(
        `  [ok]   docker stats "${opts.dockerContainer}" → RSS ${fmtBytes(rss)}`,
      );
    } catch (err) {
      console.error(`Preflight FAILED: ${(err as Error).message}`);
      return 1;
    }
  } else {
    console.log('  [info] RSS not sampled (no --docker-container)');
  }
  console.log('');

  const outSink = opts.outPath ? makeOutSink(opts.outPath) : undefined;
  const samples: SoakSample[] = [];
  let failedScrapes = 0;
  let consecutiveFailures = 0;
  let aborted = false;
  let abortReason = '';

  const startedAt = Date.now();
  const endAt = opts.durationMs > 0 ? startedAt + opts.durationMs : Infinity;
  console.log(
    `Sampling every ${opts.intervalMs / 1000}s` +
      (opts.durationMs > 0
        ? ` for ${fmtDuration(opts.durationMs / 1000)}`
        : ' until Ctrl-C') +
      ` — target ${opts.baseUrl}`,
  );
  console.log('');

  while (!stopRequested && Date.now() < endAt) {
    const tickStart = Date.now();
    try {
      const sample = await scrape(opts, token);
      if (opts.dockerContainer) {
        try {
          sample.rssBytes = await sampleRss(opts.dockerContainer);
        } catch (err) {
          console.error(`  [warn] RSS sample skipped: ${(err as Error).message}`);
        }
      }
      samples.push(sample);
      consecutiveFailures = 0;
      outSink?.(sample);
      printStatus(sample, samples.length);

      // Live restart check — surface a silent restart the moment it shows up,
      // not only in the final report (a 72h soak should not hide it for days).
      if (samples.length >= 2) {
        const prev = samples[samples.length - 2];
        if (sample.uptimeSeconds < prev.uptimeSeconds - UPTIME_REGRESSION_GRACE_S) {
          console.error(
            `  [ALERT] uptime regressed ${fmtDuration(prev.uptimeSeconds)} → ` +
              `${fmtDuration(sample.uptimeSeconds)} — the process restarted`,
          );
        }
      }
    } catch (err) {
      failedScrapes++;
      consecutiveFailures++;
      console.error(
        `  [warn] scrape failed (${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES} ` +
          `consecutive): ${(err as Error).message}`,
      );
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        aborted = true;
        abortReason = `${consecutiveFailures} consecutive scrape failures — the endpoint is unreachable`;
        console.error(`  ${abortReason}`);
        break;
      }
    }

    if (stopRequested || Date.now() >= endAt) break;
    const waitMs = Math.max(0, opts.intervalMs - (Date.now() - tickStart));
    await interruptibleSleep(waitMs);
  }

  const ok = report(opts, samples, { failedScrapes, aborted, abortReason });
  return ok ? 0 : 1;
}

/* ── entry point ───────────────────────────────────────────────────────── */

const USAGE =
  'Usage: bun run soak-watch -- [options]\n' +
  '       bun deploy/burn-in-soak-watch.ts --help\n' +
  'See the header of deploy/burn-in-soak-watch.ts for the full option list.';

async function main(argv: string[]): Promise<number> {
  let opts: SoakOptions;
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

  console.log('Infinite Loop burn-in soak-watch — Phase 5 (drift over time)');
  console.log(`  target:        ${opts.baseUrl}`);
  if (opts.dockerContainer) console.log(`  rss container: ${opts.dockerContainer}`);
  if (opts.outPath) console.log(`  sample log:    ${opts.outPath}`);
  console.log('');

  installSignalHandler();
  return runSoak(opts, token);
}

if (import.meta.main) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(`unexpected error: ${(err as Error).message}`);
      process.exit(1);
    });
}
