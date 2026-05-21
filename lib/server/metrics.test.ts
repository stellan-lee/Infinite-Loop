import { describe, expect, it } from 'bun:test';
import {
  MetricsRegistry,
  subscribeMetrics,
  WEBHOOK_OUTCOMES,
  type GaugeSnapshot,
} from './metrics';
import { EventBus } from './event-bus';
import type { WorkflowEvent } from '../shared/workflow';

const ZERO_GAUGES: GaugeSnapshot = {
  runsActive: 0,
  slotPoolInUse: 0,
  slotPoolCapacity: 0,
  slotPoolWaiting: 0,
  queueDepth: 0,
  eventBufferEvents: 0,
  eventBufferLimit: 0,
  processUptimeSeconds: 0,
};

/** Parse the `name{labels} value` sample lines of an exposition body into a
 *  lookup keyed by the full series identifier (name plus any labels). */
function samples(text: string): Map<string, number> {
  const map = new Map<string, number>();
  for (const line of text.split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const sp = line.lastIndexOf(' ');
    map.set(line.slice(0, sp), Number(line.slice(sp + 1)));
  }
  return map;
}

describe('MetricsRegistry — zero-seeded series', () => {
  it('emits every labeled counter at 0 from process start', () => {
    const s = samples(new MetricsRegistry().render(ZERO_GAUGES));
    // Every terminal status, drop reason and webhook outcome must be present
    // even before its first occurrence, or rate() over the 0→1 edge breaks.
    for (const status of ['succeeded', 'failed', 'cancelled']) {
      expect(s.get(`infloop_runs_total{status="${status}"}`)).toBe(0);
    }
    for (const reason of [
      'workflow-deleted',
      'queue-full',
      'engine-start-failed',
    ]) {
      expect(s.get(`infloop_queue_dropped_total{reason="${reason}"}`)).toBe(0);
    }
    for (const outcome of WEBHOOK_OUTCOMES) {
      expect(s.get(`infloop_webhook_requests_total{outcome="${outcome}"}`)).toBe(
        0,
      );
    }
  });

  it('renders valid exposition framing', () => {
    const body = new MetricsRegistry().render(ZERO_GAUGES);
    expect(body).toContain('# HELP infloop_runs_total ');
    expect(body).toContain('# TYPE infloop_runs_total counter');
    expect(body).toContain('# TYPE infloop_run_duration_seconds histogram');
    expect(body).toContain('# TYPE infloop_runs_active gauge');
    expect(body).toContain('# TYPE infloop_event_buffer_events gauge');
    expect(body).toContain('# TYPE infloop_event_buffer_limit gauge');
    // Prometheus requires a trailing newline after the last sample.
    expect(body.endsWith('\n')).toBe(true);
  });
});

describe('MetricsRegistry — recordRunSettled', () => {
  it('counts runs by terminal status', () => {
    const m = new MetricsRegistry();
    m.recordRunSettled({ status: 'succeeded', durationMs: 1000, costUsd: 0, nodeCount: 3 });
    m.recordRunSettled({ status: 'succeeded', durationMs: 1000, costUsd: 0, nodeCount: 3 });
    m.recordRunSettled({ status: 'failed', durationMs: 1000, costUsd: 0, nodeCount: 1 });
    const s = samples(m.render(ZERO_GAUGES));
    expect(s.get('infloop_runs_total{status="succeeded"}')).toBe(2);
    expect(s.get('infloop_runs_total{status="failed"}')).toBe(1);
    expect(s.get('infloop_runs_total{status="cancelled"}')).toBe(0);
  });

  it('accumulates cost and node-execution totals', () => {
    const m = new MetricsRegistry();
    m.recordRunSettled({ status: 'succeeded', durationMs: 1000, costUsd: 0.25, nodeCount: 4 });
    m.recordRunSettled({ status: 'succeeded', durationMs: 1000, costUsd: 0.75, nodeCount: 6 });
    const s = samples(m.render(ZERO_GAUGES));
    expect(s.get('infloop_run_cost_usd_total')).toBeCloseTo(1, 6);
    expect(s.get('infloop_node_executions_total')).toBe(10);
  });

  it('places durations in cumulative histogram buckets', () => {
    const m = new MetricsRegistry();
    m.recordRunSettled({ status: 'succeeded', durationMs: 500, costUsd: 0, nodeCount: 1 });
    m.recordRunSettled({ status: 'succeeded', durationMs: 5_000, costUsd: 0, nodeCount: 1 });
    const s = samples(m.render(ZERO_GAUGES));
    // 0.5s falls in le=1; 5s does not — both fall in le=10 and above.
    expect(s.get('infloop_run_duration_seconds_bucket{le="1"}')).toBe(1);
    expect(s.get('infloop_run_duration_seconds_bucket{le="10"}')).toBe(2);
    expect(s.get('infloop_run_duration_seconds_bucket{le="+Inf"}')).toBe(2);
    expect(s.get('infloop_run_duration_seconds_count')).toBe(2);
    expect(s.get('infloop_run_duration_seconds_sum')).toBeCloseTo(5.5, 6);
  });

  it('ignores malformed cost, count and duration without poisoning counters', () => {
    const m = new MetricsRegistry();
    m.recordRunSettled({ status: 'succeeded', durationMs: NaN, costUsd: NaN, nodeCount: -3 });
    m.recordRunSettled({ status: 'succeeded', durationMs: -10, costUsd: -1, nodeCount: 2 });
    const s = samples(m.render(ZERO_GAUGES));
    expect(s.get('infloop_run_cost_usd_total')).toBe(0);
    expect(s.get('infloop_node_executions_total')).toBe(2);
    // Both malformed durations are dropped — the histogram saw nothing.
    expect(s.get('infloop_run_duration_seconds_count')).toBe(0);
  });
});

describe('MetricsRegistry — webhook + queue counters', () => {
  it('counts webhook requests by outcome', () => {
    const m = new MetricsRegistry();
    m.recordWebhookRequest('accepted');
    m.recordWebhookRequest('accepted');
    m.recordWebhookRequest('rejected');
    const s = samples(m.render(ZERO_GAUGES));
    expect(s.get('infloop_webhook_requests_total{outcome="accepted"}')).toBe(2);
    expect(s.get('infloop_webhook_requests_total{outcome="rejected"}')).toBe(1);
    expect(s.get('infloop_webhook_requests_total{outcome="error"}')).toBe(0);
  });

  it('folds trigger_enqueued / trigger_dropped bus events into counters', () => {
    const m = new MetricsRegistry();
    const enqueued: WorkflowEvent = {
      type: 'trigger_enqueued',
      queueId: 'q1',
      triggerId: 't1',
      workflowId: 'w1',
      position: 1,
      receivedAt: Date.now(),
    };
    const dropped: WorkflowEvent = {
      type: 'trigger_dropped',
      queueId: 'q2',
      triggerId: 't1',
      reason: 'queue-full',
    };
    m.handleEvent(enqueued);
    m.handleEvent(enqueued);
    m.handleEvent(dropped);
    const s = samples(m.render(ZERO_GAUGES));
    expect(s.get('infloop_queue_enqueued_total')).toBe(2);
    expect(s.get('infloop_queue_dropped_total{reason="queue-full"}')).toBe(1);
    expect(s.get('infloop_queue_dropped_total{reason="workflow-deleted"}')).toBe(0);
  });

  it('ignores bus events it does not own', () => {
    const m = new MetricsRegistry();
    m.handleEvent({ type: 'run_finished', status: 'succeeded', scope: {} });
    const s = samples(m.render(ZERO_GAUGES));
    expect(s.get('infloop_queue_enqueued_total')).toBe(0);
  });
});

describe('MetricsRegistry — subscribeMetrics + reset', () => {
  it('wires a registry to an event bus', () => {
    const bus = new EventBus();
    const m = new MetricsRegistry();
    const unsub = subscribeMetrics(m, bus);
    bus.emit({
      type: 'trigger_enqueued',
      queueId: 'q1',
      triggerId: 't1',
      workflowId: 'w1',
      position: 1,
      receivedAt: Date.now(),
    });
    expect(samples(m.render(ZERO_GAUGES)).get('infloop_queue_enqueued_total')).toBe(1);
    // After unsubscribe the registry must stop receiving events.
    unsub();
    bus.emit({
      type: 'trigger_enqueued',
      queueId: 'q2',
      triggerId: 't1',
      workflowId: 'w1',
      position: 1,
      receivedAt: Date.now(),
    });
    expect(samples(m.render(ZERO_GAUGES)).get('infloop_queue_enqueued_total')).toBe(1);
  });

  it('reset() returns every counter to process-start zero', () => {
    const m = new MetricsRegistry();
    m.recordRunSettled({ status: 'failed', durationMs: 2000, costUsd: 1.5, nodeCount: 9 });
    m.recordWebhookRequest('error');
    m.reset();
    const s = samples(m.render(ZERO_GAUGES));
    expect(s.get('infloop_runs_total{status="failed"}')).toBe(0);
    expect(s.get('infloop_run_cost_usd_total')).toBe(0);
    expect(s.get('infloop_node_executions_total')).toBe(0);
    expect(s.get('infloop_run_duration_seconds_count')).toBe(0);
    expect(s.get('infloop_webhook_requests_total{outcome="error"}')).toBe(0);
  });
});

describe('MetricsRegistry — gauges', () => {
  it('renders injected gauge values verbatim', () => {
    const s = samples(
      new MetricsRegistry().render({
        runsActive: 2,
        slotPoolInUse: 3,
        slotPoolCapacity: 4,
        slotPoolWaiting: 1,
        queueDepth: 7,
        eventBufferEvents: 8_400,
        eventBufferLimit: 200_000,
        processUptimeSeconds: 123,
      }),
    );
    expect(s.get('infloop_runs_active')).toBe(2);
    expect(s.get('infloop_slot_pool_in_use')).toBe(3);
    expect(s.get('infloop_slot_pool_capacity')).toBe(4);
    expect(s.get('infloop_slot_pool_waiting')).toBe(1);
    expect(s.get('infloop_queue_depth')).toBe(7);
    expect(s.get('infloop_event_buffer_events')).toBe(8_400);
    expect(s.get('infloop_event_buffer_limit')).toBe(200_000);
    expect(s.get('infloop_process_uptime_seconds')).toBe(123);
  });

  it('collapses a non-finite gauge to 0 rather than emitting invalid text', () => {
    const body = new MetricsRegistry().render({
      ...ZERO_GAUGES,
      runsActive: NaN,
      queueDepth: Infinity,
    });
    // A literal `NaN` / `Infinity` token would make Prometheus reject the
    // whole scrape — both must serialize as `0`.
    expect(body).not.toContain('NaN');
    expect(body).not.toContain('Infinity');
    const s = samples(body);
    expect(s.get('infloop_runs_active')).toBe(0);
    expect(s.get('infloop_queue_depth')).toBe(0);
  });
});
