/*
 * MetricsRegistry — process-lifetime operational counters + Prometheus exposition.
 *
 * Infinite Loop runs workflows unattended (webhooks, MCP, triggers). The
 * health probe is deliberately blind to workload (see app/api/health), the
 * audit log is forensic and after-the-fact, and structured logs are grep-only.
 * None of them answer the operational questions: is the trigger queue backing
 * up toward its cap, are runs failing, what is this costing. This registry is
 * that surface — `GET /api/metrics` renders it in Prometheus text exposition
 * format so it drops straight into Grafana / Alertmanager.
 *
 * Two kinds of metric, split deliberately:
 *
 *   - COUNTERS (held here): cumulative, monotonic, process-lifetime. Mutated
 *     by the `record*` methods and by a single event-bus subscription. They
 *     live in this object for the life of the process.
 *
 *   - GAUGES (NOT held here): instantaneous — runs active, slot-pool depth,
 *     queue depth, uptime. Read live at scrape time and passed into `render()`
 *     by the route layer as a `GaugeSnapshot`. They are deliberately not
 *     stored here because this module must not import the engine / slot pool /
 *     trigger queue: `run-controller.ts` imports this module, and
 *     `workflow-engine.ts` imports `run-controller.ts`, so importing the
 *     engine here would close a module cycle through a module that builds a
 *     globalThis singleton at import time — the fragile kind. The route sits
 *     above the engine and can read both, so it owns gauge collection.
 *
 * Recording mechanism is mixed, on a principled rule: subscribe to the bus
 * when the event already carries everything the counter needs (queue
 * enqueue/drop — mirrors queue-history.ts, zero changes to trigger-queue.ts);
 * call a `record*` method explicitly when the data is not on the bus (the
 * `run_finished` event carries status but not duration or cost; webhook HTTP
 * outcomes never touch the bus at all).
 *
 * KNOWN LIMITATION: a run reconstructed from a crash-recovery marker on the
 * next boot (see crash-recovery.ts) becomes a `failed` history record WITHOUT
 * going through RunController's settle path, so it never calls
 * `recordRunSettled`. `infloop_runs_total{status="failed"}` and
 * `infloop_run_duration_seconds` therefore undercount crash-killed runs. This
 * is acceptable for a v1 surface, but an alert wired to the failure counter
 * must be aware that a hard crash is invisible to it (use `/api/health` and
 * `infloop_process_uptime_seconds` to catch restarts).
 */

import { eventBus, type EventBus } from './event-bus';
import type { TerminalRunStatus, WorkflowEvent } from '../shared/workflow';

/** Reasons the trigger queue drops a queued item — mirrors TriggerDroppedEvent. */
const QUEUE_DROP_REASONS = [
  'workflow-deleted',
  'queue-full',
  'engine-start-failed',
] as const;
type QueueDropReason = (typeof QUEUE_DROP_REASONS)[number];

/** Coarse outcome of a webhook ingress request, keyed off the HTTP status. */
export const WEBHOOK_OUTCOMES = [
  'accepted',
  'ignored',
  'not_found',
  'rejected',
  'error',
] as const;
export type WebhookOutcome = (typeof WEBHOOK_OUTCOMES)[number];

/** The three terminal run statuses. Mirrors `TerminalRunStatus`. */
const TERMINAL_STATUSES: TerminalRunStatus[] = [
  'succeeded',
  'failed',
  'cancelled',
];

/**
 * Run-duration histogram bucket upper bounds, in seconds. Sized for this
 * tool's real range: sub-second tasks at the low end, the 24h run-duration
 * backstop (`DEFAULT_MAX_DURATION_MS`) at the high end. Prometheus' default
 * buckets top out at 10s and would be useless here.
 */
const DURATION_BUCKETS_SECONDS = [1, 10, 60, 300, 1800, 7200, 21600, 86400];

/**
 * Instantaneous values, read live at scrape time and supplied by the route.
 * See the module header for why gauges are injected rather than stored.
 */
export interface GaugeSnapshot {
  /** Workflow runs currently executing. */
  runsActive: number;
  /** Folder-touching runs currently holding a slot-pool slot. */
  slotPoolInUse: number;
  /** Configured slot-pool capacity. */
  slotPoolCapacity: number;
  /** Runs parked in the slot-pool FIFO wait queue. */
  slotPoolWaiting: number;
  /** Trigger-queue items waiting to start. */
  queueDepth: number;
  /** Seconds since this server process started. */
  processUptimeSeconds: number;
}

/**
 * Cumulative-count histogram. `counts[i]` holds the number of observations
 * less-than-or-equal-to `DURATION_BUCKETS_SECONDS[i]` — already cumulative,
 * because the buckets ascend, so it maps straight onto Prometheus' `le`
 * semantics without a render-time prefix sum.
 */
interface Histogram {
  counts: number[];
  sum: number;
  count: number;
}

function emptyHistogram(): Histogram {
  return { counts: DURATION_BUCKETS_SECONDS.map(() => 0), sum: 0, count: 0 };
}

/**
 * Render a metric value for exposition. A non-finite number (`NaN` /
 * `Infinity`) is not valid Prometheus text and would make the scraper reject
 * the entire scrape — collapse it to `0`. The counters are already guarded at
 * their write sites; this is the belt for the injected `GaugeSnapshot`, whose
 * values `render` cannot vet at their source.
 */
function formatValue(n: number): string {
  return Number.isFinite(n) ? String(n) : '0';
}

export class MetricsRegistry {
  private runsTotal = new Map<TerminalRunStatus, number>();
  private runDuration: Histogram = emptyHistogram();
  private runCostUsdTotal = 0;
  private nodeExecutionsTotal = 0;
  private queueEnqueuedTotal = 0;
  private queueDroppedTotal = new Map<QueueDropReason, number>();
  private webhookRequestsTotal = new Map<WebhookOutcome, number>();

  constructor() {
    this.seed();
  }

  /**
   * Pre-seed every labeled counter to 0 so `render()` emits a series for every
   * label value from process start. A counter series that only appears on its
   * first occurrence has no prior sample, so `rate()` across the 0→1
   * transition is undefined — the first event of a kind would be invisible.
   */
  private seed(): void {
    for (const s of TERMINAL_STATUSES) this.runsTotal.set(s, 0);
    for (const r of QUEUE_DROP_REASONS) this.queueDroppedTotal.set(r, 0);
    for (const o of WEBHOOK_OUTCOMES) this.webhookRequestsTotal.set(o, 0);
  }

  /**
   * Fold a settled run into the run counters. Called once per run from
   * RunController's settle path — the `run_finished` bus event carries the
   * status but not the duration or cost, so this is an explicit call rather
   * than a bus subscription. Synchronous and in-memory.
   */
  recordRunSettled(opts: {
    status: TerminalRunStatus;
    durationMs: number;
    costUsd: number;
    nodeCount: number;
  }): void {
    this.runsTotal.set(opts.status, (this.runsTotal.get(opts.status) ?? 0) + 1);
    this.observeDuration(opts.durationMs);
    // A malformed cost/count must not poison a monotonic counter (a NaN would
    // make it NaN forever); negatives are nonsensical. Drop both quietly.
    if (Number.isFinite(opts.costUsd) && opts.costUsd > 0) {
      this.runCostUsdTotal += opts.costUsd;
    }
    if (Number.isFinite(opts.nodeCount) && opts.nodeCount > 0) {
      this.nodeExecutionsTotal += opts.nodeCount;
    }
  }

  private observeDuration(durationMs: number): void {
    if (!Number.isFinite(durationMs) || durationMs < 0) return;
    const seconds = durationMs / 1000;
    this.runDuration.sum += seconds;
    this.runDuration.count += 1;
    for (let i = 0; i < DURATION_BUCKETS_SECONDS.length; i++) {
      if (seconds <= DURATION_BUCKETS_SECONDS[i]) this.runDuration.counts[i] += 1;
    }
  }

  /**
   * Count one webhook ingress request by its coarse outcome. Called from the
   * webhook route's POST wrapper — HTTP outcomes never reach the event bus.
   */
  recordWebhookRequest(outcome: WebhookOutcome): void {
    this.webhookRequestsTotal.set(
      outcome,
      (this.webhookRequestsTotal.get(outcome) ?? 0) + 1,
    );
  }

  /**
   * Fold a bus event into the queue counters. Public so `subscribeMetrics`
   * can wire it and tests can drive it directly. Silently ignores every event
   * type this registry does not own.
   */
  handleEvent(ev: WorkflowEvent): void {
    if (ev.type === 'trigger_enqueued') {
      this.queueEnqueuedTotal += 1;
    } else if (ev.type === 'trigger_dropped') {
      const reason = ev.reason as QueueDropReason;
      this.queueDroppedTotal.set(
        reason,
        (this.queueDroppedTotal.get(reason) ?? 0) + 1,
      );
    }
  }

  /** Drop all counter state back to process-start. Tests only. */
  reset(): void {
    this.runsTotal.clear();
    this.queueDroppedTotal.clear();
    this.webhookRequestsTotal.clear();
    this.runDuration = emptyHistogram();
    this.runCostUsdTotal = 0;
    this.nodeExecutionsTotal = 0;
    this.queueEnqueuedTotal = 0;
    this.seed();
  }

  /**
   * Render the full metrics surface in Prometheus text exposition format
   * (version 0.0.4). `gauges` carries the instantaneous values the registry
   * does not store — see the module header.
   *
   * Every label value emitted here is a fixed compile-time enum member with no
   * Prometheus-special character, so no label-value escaping is needed.
   */
  render(gauges: GaugeSnapshot): string {
    const out: string[] = [];
    const family = (name: string, type: string, help: string): void => {
      out.push(`# HELP ${name} ${help}`);
      out.push(`# TYPE ${name} ${type}`);
    };

    /* ── counters ───────────────────────────────────────────────────────── */

    family(
      'infloop_runs_total',
      'counter',
      'Workflow runs that have settled, by terminal status.',
    );
    for (const status of TERMINAL_STATUSES) {
      out.push(
        `infloop_runs_total{status="${status}"} ${formatValue(this.runsTotal.get(status) ?? 0)}`,
      );
    }

    family(
      'infloop_run_duration_seconds',
      'histogram',
      'Wall-clock duration of settled workflow runs.',
    );
    for (let i = 0; i < DURATION_BUCKETS_SECONDS.length; i++) {
      out.push(
        `infloop_run_duration_seconds_bucket{le="${DURATION_BUCKETS_SECONDS[i]}"} ${formatValue(this.runDuration.counts[i])}`,
      );
    }
    out.push(
      `infloop_run_duration_seconds_bucket{le="+Inf"} ${formatValue(this.runDuration.count)}`,
    );
    out.push(
      `infloop_run_duration_seconds_sum ${formatValue(this.runDuration.sum)}`,
    );
    out.push(
      `infloop_run_duration_seconds_count ${formatValue(this.runDuration.count)}`,
    );

    family(
      'infloop_run_cost_usd_total',
      'counter',
      'Cumulative provider-reported run cost, in USD.',
    );
    out.push(`infloop_run_cost_usd_total ${formatValue(this.runCostUsdTotal)}`);

    family(
      'infloop_node_executions_total',
      'counter',
      'Cumulative node-execution steps across all runs — budget-counted, so ' +
        'it includes start/end and loop/parallel/subworkflow container nodes.',
    );
    out.push(
      `infloop_node_executions_total ${formatValue(this.nodeExecutionsTotal)}`,
    );

    family(
      'infloop_queue_enqueued_total',
      'counter',
      'Trigger-queue items enqueued.',
    );
    out.push(
      `infloop_queue_enqueued_total ${formatValue(this.queueEnqueuedTotal)}`,
    );

    family(
      'infloop_queue_dropped_total',
      'counter',
      'Trigger-queue items dropped before starting, by reason.',
    );
    for (const reason of QUEUE_DROP_REASONS) {
      out.push(
        `infloop_queue_dropped_total{reason="${reason}"} ${formatValue(this.queueDroppedTotal.get(reason) ?? 0)}`,
      );
    }

    family(
      'infloop_webhook_requests_total',
      'counter',
      'Webhook ingress requests, by coarse outcome.',
    );
    for (const outcome of WEBHOOK_OUTCOMES) {
      out.push(
        `infloop_webhook_requests_total{outcome="${outcome}"} ${formatValue(this.webhookRequestsTotal.get(outcome) ?? 0)}`,
      );
    }

    /* ── gauges (injected; see module header) ───────────────────────────── */

    family(
      'infloop_runs_active',
      'gauge',
      'Workflow runs currently executing.',
    );
    out.push(`infloop_runs_active ${formatValue(gauges.runsActive)}`);

    family(
      'infloop_slot_pool_in_use',
      'gauge',
      'Folder-touching runs currently holding a slot-pool slot.',
    );
    out.push(`infloop_slot_pool_in_use ${formatValue(gauges.slotPoolInUse)}`);

    family(
      'infloop_slot_pool_capacity',
      'gauge',
      'Configured slot-pool capacity (max concurrent folder-touching runs).',
    );
    out.push(
      `infloop_slot_pool_capacity ${formatValue(gauges.slotPoolCapacity)}`,
    );

    family(
      'infloop_slot_pool_waiting',
      'gauge',
      'Runs parked in the slot-pool FIFO wait queue.',
    );
    out.push(
      `infloop_slot_pool_waiting ${formatValue(gauges.slotPoolWaiting)}`,
    );

    family(
      'infloop_queue_depth',
      'gauge',
      'Trigger-queue items waiting to start.',
    );
    out.push(`infloop_queue_depth ${formatValue(gauges.queueDepth)}`);

    family(
      'infloop_process_uptime_seconds',
      'gauge',
      'Seconds since this server process started.',
    );
    out.push(
      `infloop_process_uptime_seconds ${formatValue(gauges.processUptimeSeconds)}`,
    );

    // Prometheus requires a trailing newline after the final sample.
    return out.join('\n') + '\n';
  }
}

/**
 * Wire `registry` to an event bus. Returns the unsubscribe handle. Kept
 * separate from the constructor — mirroring `subscribeQueueHistory` — so a
 * test can build a bare `MetricsRegistry` without a live bus subscription,
 * and so `reset()` does not have to recreate the subscription.
 */
export function subscribeMetrics(
  registry: MetricsRegistry,
  bus: EventBus = eventBus,
): () => void {
  return bus.subscribe((ev) => registry.handleEvent(ev));
}

function createSingleton(): MetricsRegistry {
  const r = new MetricsRegistry();
  subscribeMetrics(r);
  return r;
}

// Pin the singleton to `globalThis` so Next.js dev-mode module reloads cannot
// fork it — same rationale as event-bus.ts / queue-history.ts. The producers
// (engine, webhook route) and the consumer (/api/metrics) must share one.
declare global {
  // eslint-disable-next-line no-var
  var __infiniteLoopMetrics: MetricsRegistry | undefined;
}

export const metrics: MetricsRegistry =
  globalThis.__infiniteLoopMetrics ?? createSingleton();
if (!globalThis.__infiniteLoopMetrics) {
  globalThis.__infiniteLoopMetrics = metrics;
}
